/**
 * Spawn role for remote mining: at most one option per tick. Sources are taken closest first and a
 * source is only considered once every closer one has its haulers, harvesters and reservers.
 * Ported from Hivemind (MIT), src/spawn-role/remote-mining.ts (source keepers and dismantlers left
 * out: RCL 7, rare on a fresh server). See docs/hivemind/hivemind-remote.md §6.
 */

import { bodyCost, buildBody, MoveMode } from "../core/bodyBuilder";
import { activeParts, creepsByRole, effectiveEnergy } from "../core/roomState";
import { ENEMY_STRENGTH_NORMAL, enemyStrength } from "../defense/RoomDefense";
import { intelManager } from "../modules/IntelManager";
import { hasInvaderCore } from "../modules/RoomIntel";
import { countStat } from "../utils/stats";
import type { SpawnOption, SpawnRole } from "../spawning/spawnRoles";
import {
    canReserveFrom,
    hasRemoteContainer,
    isRemoteUnderAttack,
    needsRepairs,
    remoteContainer,
    remotePath,
    RemoteSource,
    repairNeed,
    remoteSources,
    sourceEnergyCapacity
} from "./RemoteMining";
import { builderWork } from "./repairs";
import { pathTerrain, recordSpawnLateness, spawnLeadObserved, travelObserved, walkTicks } from "./travel";

export const REMOTE_HARVESTER = "remoteHarvester";
export const REMOTE_HAULER = "remoteHauler";
export const RESERVER = "reserver";
export const REMOTE_BUILDER = "remoteBuilder";

/** Reservation a second reserver of a room is spawned under (not in Hivemind: one per free tile around the controller) */
const RESERVE_HOLD = 1000;

declare global {
    interface CreepMemory {
        /** Remote source key (remote harvesters and haulers) */
        source?: string;
        /** Remote room a reserver holds */
        reserveRoom?: string;
        /** Remote harvester that reached its source once */
        arrived?: boolean;
    }
}

type RemoteOption = SpawnOption & {
    unit: "hauler" | "builder" | "harvester" | "reserver";
    remote?: RemoteSource;
    /** Replacement harvester: the tick it had to spawn to arrive as the youngest harvester left dies */
    deadline?: number;
};

/** Each source's pending harvester option (heap): first tick it was offered, replacement deadline */
const harvesterWanted = new Map<string, { since: number; deadline?: number }>();

function energyLimit(room: Room): number {
    return Math.min(room.energyCapacityAvailable, Math.max(room.energyCapacityAvailable * 0.9, room.energyAvailable));
}

/** CARRY needed to bring a source's output home: 2 * travel * energy per tick / 50 */
function requiredCarry(home: Room, source: RemoteSource): number {
    const capacity = sourceEnergyCapacity(home, source);
    return Math.ceil((2 * source.travelTime * capacity) / ENERGY_REGEN_TIME / CARRY_CAPACITY);
}

function requiredWork(home: Room, source: RemoteSource): number {
    return sourceEnergyCapacity(home, source) / ENERGY_REGEN_TIME / HARVEST_POWER;
}

function harvesterSize(home: Room, source: RemoteSource): number {
    return requiredWork(home, source) * (hasRemoteContainer(source) ? 1 : 1.5);
}

function haulerMove(home: Room): MoveMode {
    return home.controller!.level > 3 && (home.storage || home.terminal) ? MoveMode.ROAD : MoveMode.PLAINS;
}

function haulerBody(home: Room, size: number): BodyPartConstant[] {
    return buildBody({
        weights: { [CARRY]: 1 },
        partLimits: { [CARRY]: size },
        moveMode: haulerMove(home),
        energyLimit: energyLimit(home)
    });
}

/** Haulers of equal size covering the total demand (Hivemind getMaximumHaulerSize) */
function haulerSize(home: Room, totalCarry: number): number {
    const largest = buildBody({
        weights: { [CARRY]: 1 },
        partLimits: { [CARRY]: totalCarry },
        moveMode: haulerMove(home),
        energyLimit: home.energyCapacityAvailable
    }).filter(p => p === CARRY).length;
    const maxCarry = Math.min(largest, Math.ceil((0.9 * CONTAINER_CAPACITY) / CARRY_CAPACITY));
    if (maxCarry === 0) return 0;
    const haulers = Math.ceil(totalCarry / maxCarry);
    return Math.ceil(totalCarry / haulers);
}

function harvesterBody(home: Room, option: RemoteOption): BodyPartConstant[] {
    const established = option.remote ? isEstablished(option.remote) : false;
    return buildBody({
        weights: { [WORK]: 20, [CARRY]: 1 },
        partLimits: { [WORK]: option.size ? option.size + 1 : 0 },
        // Road bodies only once the home builds remote roads (storage era): off roads they walk at half speed
        moveMode: established && haulerMove(home) === MoveMode.ROAD ? MoveMode.ROAD : MoveMode.PLAINS,
        carryContentLevel: 0,
        energyLimit: energyLimit(home)
    });
}

function reserverBody(home: Room): BodyPartConstant[] {
    return buildBody({
        weights: { [CLAIM]: 1 },
        partLimits: { [CLAIM]: Math.floor(CONTROLLER_RESERVE_MAX / CREEP_CLAIM_LIFE_TIME) },
        moveMode: MoveMode.PLAINS,
        energyLimit: home.energyCapacityAvailable
    });
}

function isEstablished(source: RemoteSource): boolean {
    if (!hasRemoteContainer(source)) return false;
    return (remoteContainer(source)?.hits ?? CONTAINER_HITS) > CONTAINER_HITS / 2;
}

function haulerOption(home: Room, demand: number): RemoteOption | null {
    const total = _.sum(remoteSources(home.name).filter(s => !isRemoteUnderAttack(s)), s => requiredCarry(home, s));
    const size = haulerSize(home, total);
    if (size === 0) return null;
    const spawnTime = haulerBody(home, size).length * CREEP_SPAWN_TIME;
    const current = activeParts(
        creepsByRole(home.name, REMOTE_HAULER).filter(c => c.spawning || (c.ticksToLive ?? 0) > spawnTime),
        CARRY
    );
    if (current >= demand) return null;
    return { role: REMOTE_HAULER, unit: "hauler", priority: 3, weight: 0, size };
}

// ------------------------------------------------------------------ builder (storage era)

function hasRemoteHarvesters(home: Room, source: RemoteSource): boolean {
    return creepsByRole(home.name, REMOTE_HARVESTER).some(c => c.memory.source === source.key);
}

/** A source's container and roads need a builder trip, once it is mined */
function builderDue(home: Room, source: RemoteSource): boolean {
    return hasRemoteHarvesters(home, source) && needsRepairs(source);
}

function builderBody(home: Room, size: number, energy = energyLimit(home)): BodyPartConstant[] {
    return buildBody({
        weights: { [CARRY]: 5, [WORK]: 2 },
        partLimits: { [WORK]: size },
        moveMode: haulerMove(home),
        energyLimit: energy
    });
}

/**
 * One remote builder per home at a time, its WORK sized on what the due sources miss (repairs.ts
 * builderWork: hits to repair and progress to build, spent within one life) and capped by the body the
 * home can spawn. Hivemind: builders of equal size until their WORK covers 0.7 + 0.03 per path tile of
 * every source (getMaximumBuilderSize); shard0 W27N5 kept ~4.7 builders of 33 parts on healthy roads.
 */
function builderOption(home: Room): RemoteOption | null {
    if (!home.storage && !home.terminal) return null;
    if (effectiveEnergy(home) < 5000) return null;
    if (creepsByRole(home.name, REMOTE_BUILDER).length > 0) return null;
    const due = remoteSources(home.name).filter(s => !isRemoteUnderAttack(s) && builderDue(home, s));
    const work = builderWork(due.map(s => ({ ...repairNeed(s), travel: s.travelTime })));
    if (work === 0) return null;
    const maxWork = builderBody(home, work, home.energyCapacityAvailable).filter(p => p === WORK).length;
    const size = Math.min(work, maxWork);
    if (size === 0) return null;
    const reason = `${work} WORK for ${due.length} source(s)`;
    return { role: REMOTE_BUILDER, unit: "builder", priority: 3, weight: 0, size, reason };
}

/**
 * Remote harvesters of a selected source are spawned at priority 3, the first one included. Hivemind: 1 for the
 * first one, after the whole local economy. shard0 W27N5 (RCL 4, no storage, waiting for energy on builders at 4
 * and transporters at 3) left 3 of its 5 selected sources without harvester for thousands of ticks; in the mockup
 * a young RCL 4 home next to W7N3 never spawned one in 5000 ticks. 3 only once the source has a container (or its
 * site) still left that home's sources unserved and cost W1N3 12% over 8000 ticks (see CLAUDE.md).
 */
const HARVESTER_PRIORITY = 3;

/** Longest replacement lead: past it the old harvester and its replacement overlap more than they gap */
const MAX_LEAD = 500;

/**
 * Ticks a new harvester of `body` takes to reach its source: the path length (Hivemind) raised to the
 * walk the path terrain and the body's fatigue give (empty CARRY weighs nothing) and to the travel
 * observed on arrival (traffic, detours, roads not known out of sight)
 */
function harvesterTravel(source: RemoteSource, body: BodyPartConstant[]): number {
    const path = remotePath(source);
    const work = body.filter(p => p === WORK).length;
    const estimate = path.length > 0 ? walkTicks(pathTerrain(source.key, path), work, body.filter(p => p === MOVE).length) : 0;
    return Math.max(source.travelTime, estimate, travelObserved(source.key) ?? 0);
}

function harvesterOption(home: Room, source: RemoteSource): RemoteOption | null {
    const intel = intelManager.getIntel(source.room);
    const reservedByUs = intel?.reserver === Memory.username && (intel?.reservationTicks ?? 0) >= 500;
    if (hasInvaderCore(source.room) && !reservedByUs) return null;
    if (intel?.reserver && intel.reserver !== Memory.username && (intel.reservationTicks ?? 0) > 500) return null;

    const all = creepsByRole(home.name, REMOTE_HARVESTER).filter(c => c.memory.source === source.key);
    const size = harvesterSize(home, source);
    const option: RemoteOption = {
        role: REMOTE_HARVESTER,
        unit: "harvester",
        priority: HARVESTER_PRIORITY,
        weight: 1 - source.travelTime / 100,
        size,
        remote: source
    };
    // Replace a harvester early enough to cover the walk, the spawn time and the spawn queue (Hivemind: path length)
    const body = harvesterBody(home, option);
    const spawnTime = body.length * CREEP_SPAWN_TIME;
    const travel = harvesterTravel(source, body);
    const lead = Math.min(travel + spawnTime + spawnLeadObserved(home.name), MAX_LEAD);
    const harvesters = all.filter(c => c.spawning || (c.ticksToLive ?? 0) > lead);
    if (harvesters.length >= source.free) return null;
    // Without a container, extra WORK builds it ((BUILD_POWER + HARVEST_POWER) / BUILD_POWER)
    const saturation = hasRemoteContainer(source) ? 0.9 : (BUILD_POWER + HARVEST_POWER) / BUILD_POWER;
    if (activeParts(harvesters, WORK) >= size * saturation) return null;
    const leaving = all.filter(c => !c.spawning && !harvesters.includes(c));
    if (leaving.length > 0) option.deadline = Game.time + _.max(leaving.map(c => c.ticksToLive ?? 0)) - travel - spawnTime;
    return option;
}

function reserverOption(home: Room, source: RemoteSource): RemoteOption | null {
    const intel = intelManager.getIntel(source.room);
    if (!intel?.controllerPos || intel.owner) return null;
    const positions = intel.reservePositions ?? 0;
    const reservedByOther = !!intel.reserver && intel.reserver !== Memory.username;
    if (home.energyCapacityAvailable < 1300 && !(home.energyCapacityAvailable >= 650 && (positions > 1 || reservedByOther))) {
        return null;
    }
    const body = reserverBody(home);
    if (body.length === 0) return null;
    const spawnTime = body.length * CREEP_SPAWN_TIME;
    const reservers = creepsByRole(home.name, RESERVER).filter(c => c.memory.reserveRoom === source.room);
    const activeOnArrival = reservers.filter(c => c.spawning || (c.ticksToLive ?? 0) > source.travelTime + spawnTime);
    if (activeOnArrival.length >= positions) return null;

    // Don't overshoot the reservation cap
    const claimParts = body.filter(p => p === CLAIM).length;
    const maxAdditional = (claimParts - 1) * (CREEP_CLAIM_LIFE_TIME - source.travelTime);
    const lastClaim = Memory.rooms[source.room]?.lastClaim;
    const remaining = lastClaim ? Math.max(0, lastClaim.value + lastClaim.time - Game.time) : 0;
    const extra = _.sum(reservers, c => (c.spawning ? CREEP_CLAIM_LIFE_TIME : c.ticksToLive ?? 0) * c.getActiveBodyparts(CLAIM));
    if (remaining + extra - spawnTime - source.travelTime + maxAdditional > CONTROLLER_RESERVE_MAX) return null;
    // A 1-CLAIM reserver only offsets the decay (Hivemind sent one per free tile, 4 on shard0 W28N5): another one
    // only while the reservation left by those on their way, over the new creep's life, stays under RESERVE_HOLD
    if (activeOnArrival.length > 0) {
        const horizon = spawnTime + CREEP_CLAIM_LIFE_TIME;
        const held = _.sum(
            reservers,
            c =>
                Math.min(c.spawning ? CREEP_CLAIM_LIFE_TIME - source.travelTime : c.ticksToLive ?? 0, horizon) *
                c.getActiveBodyparts(CLAIM)
        );
        if (remaining + held - horizon >= RESERVE_HOLD) return null;
    }
    return { role: RESERVER, unit: "reserver", priority: 3, weight: 1 - source.travelTime / 100, remote: source };
}

export const remoteSpawnRole: SpawnRole = {
    id: "remote",
    emptyTimeout: 10,

    options(home) {
        // Serious enemies at home: no remote spawn
        if (enemyStrength(home) >= ENEMY_STRENGTH_NORMAL) return [];
        let haulerDemand = 0;
        let builderChecked = false;
        const reserved = new Set<string>();
        for (const source of remoteSources(home.name)) {
            if (isRemoteUnderAttack(source)) continue;
            // Haulers only for a mined source: a container left without harvester has nothing to carry
            if (hasRemoteContainer(source) && hasRemoteHarvesters(home, source)) haulerDemand += requiredCarry(home, source);
            const hauler = haulerOption(home, haulerDemand);
            if (hauler) return [hauler];
            // The builder covers every due source: offered at the first (closest) one, checked once
            if (!builderChecked && builderDue(home, source)) {
                builderChecked = true;
                const builder = builderOption(home);
                if (builder) return [builder];
            }
            const harvester = harvesterOption(home, source);
            if (!harvester) harvesterWanted.delete(source.key);
            else if (!harvesterWanted.has(source.key)) {
                harvesterWanted.set(source.key, { since: Game.time, deadline: harvester.deadline });
            }
            if (harvester) return [harvester];
            if (reserved.has(source.room) || !canReserveFrom(home, source.room)) continue;
            reserved.add(source.room);
            const reserver = reserverOption(home, source);
            if (reserver) return [reserver];
        }
        return [];
    },

    body(home, option) {
        const remote = option as RemoteOption;
        if (remote.unit === "hauler") return haulerBody(home, option.size ?? 0);
        if (remote.unit === "builder") return builderBody(home, option.size ?? 0);
        if (remote.unit === "harvester") return harvesterBody(home, remote);
        const body = reserverBody(home);
        return bodyCost(body) <= home.energyCapacityAvailable ? body : [];
    },

    memory(home, option) {
        const remote = option as RemoteOption;
        if (remote.unit === "hauler") return { role: REMOTE_HAULER, room: home.name, delivering: false };
        if (remote.unit === "builder") return { role: REMOTE_BUILDER, room: home.name, returning: true };
        if (remote.unit === "harvester") {
            const wanted = harvesterWanted.get(remote.remote!.key);
            if (wanted) {
                harvesterWanted.delete(remote.remote!.key);
                countStat("remote:spawnWait", Game.time - wanted.since);
                countStat("remote:spawnWaits");
                if (wanted.deadline !== undefined) {
                    countStat("remote:replacements");
                    countStat("remote:late", Math.max(0, Game.time - wanted.deadline));
                    recordSpawnLateness(home.name, Game.time - wanted.deadline);
                }
            }
            return { role: REMOTE_HARVESTER, room: home.name, source: remote.remote!.key };
        }
        return { role: RESERVER, room: home.name, reserveRoom: remote.remote!.room };
    }
};
