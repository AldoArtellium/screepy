/**
 * Spawn role for remote mining: at most one option per tick. Sources are taken closest first and a
 * source is only considered once every closer one has its haulers, harvesters and reservers.
 * Ported from Hivemind (MIT), src/spawn-role/remote-mining.ts (builders, source keepers and
 * dismantlers left out: they need a storage or RCL 7). See docs/hivemind/hivemind-remote.md §6.
 */

import { bodyCost, buildBody, MoveMode } from "../core/bodyBuilder";
import { activeParts, creepsByRole, hasEnemies } from "../core/roomState";
import { intelManager } from "../modules/IntelManager";
import type { SpawnOption, SpawnRole } from "../spawning/spawnRoles";
import {
    canReserveFrom,
    hasRemoteContainer,
    isRemoteUnderAttack,
    remoteContainer,
    RemoteSource,
    remoteSources,
    sourceEnergyCapacity
} from "./RemoteMining";

export const REMOTE_HARVESTER = "remoteHarvester";
export const REMOTE_HAULER = "remoteHauler";
export const RESERVER = "reserver";

declare global {
    interface CreepMemory {
        /** Remote source key (remote harvesters and haulers) */
        source?: string;
        /** Remote room a reserver holds */
        reserveRoom?: string;
    }
}

type RemoteOption = SpawnOption & { unit: "hauler" | "harvester" | "reserver"; remote?: RemoteSource };

function energyLimit(room: Room): number {
    return Math.min(room.energyCapacityAvailable, Math.max(room.energyCapacityAvailable * 0.9, room.energyAvailable));
}

/** CARRY needed to bring a source's output home: 2 * travel * energy per tick / 50 */
function requiredCarry(home: Room, source: RemoteSource): number {
    return Math.ceil((2 * source.travelTime * sourceEnergyCapacity(home, source)) / ENERGY_REGEN_TIME / CARRY_CAPACITY);
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
        moveMode: established ? MoveMode.ROAD : MoveMode.PLAINS,
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

function harvesterOption(home: Room, source: RemoteSource): RemoteOption | null {
    const intel = intelManager.getIntel(source.room);
    if (intel?.hasInvaderCore && !(intel.reserver === Memory.username && (intel.reservationTicks ?? 0) >= 500)) {
        return null;
    }
    if (intel?.reserver && intel.reserver !== Memory.username && (intel.reservationTicks ?? 0) > 500) return null;

    const all = creepsByRole(home.name, REMOTE_HARVESTER).filter(c => c.memory.source === source.key);
    const size = harvesterSize(home, source);
    const option: RemoteOption = {
        role: REMOTE_HARVESTER,
        unit: "harvester",
        priority: all.length > 0 ? 3 : 1,
        weight: 1 - source.travelTime / 100,
        size,
        remote: source
    };
    const spawnTime = harvesterBody(home, option).length * CREEP_SPAWN_TIME;
    const harvesters = all.filter(c => c.spawning || (c.ticksToLive ?? 0) > Math.min(source.travelTime + spawnTime, 500));
    if (harvesters.length >= source.free) return null;
    // Without a container, extra WORK builds it ((BUILD_POWER + HARVEST_POWER) / BUILD_POWER)
    const saturation = hasRemoteContainer(source) ? 0.9 : (BUILD_POWER + HARVEST_POWER) / BUILD_POWER;
    if (activeParts(harvesters, WORK) >= size * saturation) return null;
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
    return { role: RESERVER, unit: "reserver", priority: 3, weight: 1 - source.travelTime / 100, remote: source };
}

export const remoteSpawnRole: SpawnRole = {
    id: "remote",
    emptyTimeout: 10,

    options(home) {
        if (hasEnemies(home)) return [];
        let haulerDemand = 0;
        const reserved = new Set<string>();
        for (const source of remoteSources(home.name)) {
            if (isRemoteUnderAttack(source)) continue;
            if (hasRemoteContainer(source)) haulerDemand += requiredCarry(home, source);
            const hauler = haulerOption(home, haulerDemand);
            if (hauler) return [hauler];
            const harvester = harvesterOption(home, source);
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
        if (remote.unit === "harvester") return harvesterBody(home, remote);
        const body = reserverBody(home);
        return bodyCost(body) <= home.energyCapacityAvailable ? body : [];
    },

    memory(home, option) {
        const remote = option as RemoteOption;
        if (remote.unit === "hauler") return { role: REMOTE_HAULER, room: home.name, delivering: false };
        if (remote.unit === "harvester") return { role: REMOTE_HARVESTER, room: home.name, source: remote.remote!.key };
        return { role: RESERVER, room: home.name, reserveRoom: remote.remote!.room };
    }
};
