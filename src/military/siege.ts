/**
 * Controller takeover (2026-11-14, our design): a squad's "success" razes spawns and towers but the owner
 * kept the controller and rebuilt (shard0 W25N7 razed twice is RCL 6 again, W29N4 RCL 7 with 3 towers).
 * A takeover mission (military.ts startMission: a player room whose siege fits SIEGE_MAX_TICKS with the
 * biggest base's claimer) opens a siege on success: `Memory.military.sieges[room]`, at most `maxSieges`.
 *
 * - The bases of the mission keep one `siegeGuard` there (melee + HEAL: kills hostile creeps, steps on hostile
 *   construction sites, spawn and tower first, else parks near the controller), replaced before it dies.
 * - The biggest base sends a `controllerAttacker` (CLAIM x N + MOVE x N, siegeModel.ts siegeClaimParts),
 *   timed to stand next to the controller when its upgrade block ends; it attacks once, then suicides.
 * - Ends: controller without owner -> "taken" (the room released for remote mining and the expansion); safe
 *   mode, a spawn or an armed tower rebuilt, another owner, MAX_GUARD_LOSSES guards lost or SIEGE_TIMEOUT
 *   -> "abandoned" (in the mission log: targets.ts recentlyFailed leaves it FAILURE_MEMORY ticks, then it is
 *   an ordinary candidate again).
 */

import { buildBody, bodyCost, MoveMode } from "../core/bodyBuilder";
import { effectiveEnergy } from "../core/roomState";
import { releaseRooms } from "../modules/RoomIntel";
import { trafficManager } from "../modules/TrafficManager";
import type { SpawnOption, SpawnRole } from "../spawning/spawnRoles";
import { log } from "../utils/logger";
import { countStat } from "../utils/stats";
import { hostileRoom, militaryMemory } from "./intel";
import { squadRoute } from "./route";
import {
    arrivalTicks,
    ATTACK_CYCLE,
    attackerDue,
    claimerCost,
    DOWNGRADE_TICKS,
    guardDue,
    SIEGE_MAX_TICKS,
    siegeClaimParts,
    siegeCost,
    siegeTicks
} from "./siegeModel";
import { MIN_TOWER_ENERGY } from "./targetChoice";

export const SIEGE_GUARD = "siegeGuard";
export const CONTROLLER_ATTACKER = "controllerAttacker";

export interface SiegeMemory {
    /** Player who owned the controller when the siege started */
    owner: string;
    since: number;
    /** Bases of the mission (spawn the guard; the biggest one the attacker) */
    bases: string[];
    /** Rally room of the mission */
    rally: string;
    /** Guards lost before their time */
    losses: number;
    /** Successful attackController */
    attacks: number;
    lastAttack?: number;
    /** Controller seen: level, tick it downgrades, tick its upgrade block ends */
    level?: number;
    downgrade?: number;
    blockedUntil?: number;
    /** Guards seen alive and the tick they die of old age (gone sooner: a loss) */
    guards?: { [name: string]: number };
}

declare global {
    interface CreepMemory {
        /** Room of the siege the creep serves */
        siege?: string;
        /** Controller attacker: attacked, suicides next tick */
        attacked?: boolean;
    }
}

const DEFAULT_MAX_SIEGES = 2;
/** Guards lost before the siege is given up */
const MAX_GUARD_LOSSES = 6;
/** A siege still running this long after its start is given up (the owner found a way to upgrade) */
const SIEGE_TIMEOUT = SIEGE_MAX_TICKS * 1.5;
/** Same scale as the squads' first member (military.ts START_PRIORITY): economy roles at 4 go first */
const SIEGE_PRIORITY = 3;
const SIEGE_MIN_ENERGY = 2000;
const GUARD_MAX_ENERGY = 2000;
/** Traffic priority of the attacker (lower first): the guard makes way next to the controller */
export const ATTACKER_TRAFFIC = 5;

export function sieges(): { [room: string]: SiegeMemory } {
    return militaryMemory().sieges ?? {};
}

/** Guard body: ATTACK with two HEAL, MOVE for plains, MOVE parts in front, at most GUARD_MAX_ENERGY */
export function siegeGuardBody(capacity: number): BodyPartConstant[] {
    const body = buildBody({
        weights: { [ATTACK]: 4, [HEAL]: 1 },
        partLimits: { [HEAL]: 2 },
        moveMode: MoveMode.PLAINS,
        energyLimit: Math.min(capacity, GUARD_MAX_ENERGY)
    });
    return [...body.filter(p => p === MOVE), ...body.filter(p => p !== MOVE)];
}

function attackerBody(capacity: number): BodyPartConstant[] {
    const parts = siegeClaimParts(capacity);
    return [..._.fill(Array(parts), MOVE), ..._.fill(Array(parts), CLAIM)] as BodyPartConstant[];
}

/**
 * Siege of a player room's controller with the claimer a base of `capacity` builds, null when it is no
 * takeover (takeover off, not a player's room, or over SIEGE_MAX_TICKS). The timer is the one last seen
 * (the owner keeps upgrading it), the full one without a record.
 */
export function siegePlan(roomName: string, capacity: number): { ticks: number; parts: number } | null {
    if (militaryMemory().takeover === false) return null;
    const intel = hostileRoom(roomName);
    const owner = intel?.owner;
    if (!intel || !owner || owner === "Invader" || owner === Memory.username || !intel.rcl) return null;
    const parts = siegeClaimParts(capacity);
    const left = intel.downgrade !== undefined ? intel.downgrade - intel.t : DOWNGRADE_TICKS[intel.rcl];
    const ticks = siegeTicks(intel.rcl, Math.max(0, left), parts);
    return ticks <= SIEGE_MAX_TICKS ? { ticks, parts } : null;
}

/** Energy of a siege planned with siegePlan for bases of `capacity` */
export function siegeEnergy(plan: { ticks: number; parts: number }, capacity: number): number {
    return siegeCost(plan.ticks, claimerCost(plan.parts), bodyCost(siegeGuardBody(capacity)));
}

/** Opens the siege of a fallen takeover target; false over maxSieges (the mission ends as before) */
export function openSiege(target: string, bases: string[], rally: string): boolean {
    const memory = militaryMemory();
    const owner = hostileRoom(target)?.owner;
    if (!owner || owner === "Invader" || owner === Memory.username) return false;
    const current = memory.sieges ?? {};
    if (current[target]) return true;
    const max = memory.maxSieges ?? DEFAULT_MAX_SIEGES;
    if (Object.keys(current).length >= max) {
        log.info("Military", `No siege of ${target}: ${max} sieges already`);
        return false;
    }
    memory.sieges = { ...current, [target]: { owner, since: Game.time, bases: [...bases], rally, losses: 0, attacks: 0 } };
    countStat("military:siege:start");
    log.info("Military", `Siege of ${target} (${owner}) from ${bases.join("+")}`);
    return true;
}

/** Creeps of each siege, spawning ones included (heap, once per tick) */
const creepCache: { tick: number; bySiege: Map<string, Creep[]> } = { tick: -1, bySiege: new Map() };

function siegeCreeps(roomName: string): Creep[] {
    if (creepCache.tick !== Game.time) {
        creepCache.tick = Game.time;
        creepCache.bySiege = new Map();
        for (const name in Game.creeps) {
            const creep = Game.creeps[name];
            const siege = creep.memory.siege;
            if (!siege) continue;
            const list = creepCache.bySiege.get(siege) ?? [];
            list.push(creep);
            creepCache.bySiege.set(siege, list);
        }
    }
    return creepCache.bySiege.get(roomName) ?? [];
}

/** Guards gone before their time count as losses */
function countLosses(roomName: string, siege: SiegeMemory): void {
    const guards = siege.guards ?? {};
    for (const creep of siegeCreeps(roomName)) {
        if (creep.memory.role !== SIEGE_GUARD || creep.spawning) continue;
        guards[creep.name] = Game.time + (creep.ticksToLive ?? CREEP_LIFE_TIME);
    }
    for (const name in guards) {
        if (Game.creeps[name]) continue;
        if (Game.time < guards[name] - 2) {
            siege.losses++;
            countStat("military:siege:lost");
            log.info("Military", `Siege of ${roomName}: guard ${name} lost (${siege.losses})`);
        }
        delete guards[name];
    }
    siege.guards = guards;
}

/** Why the siege ends now, or null */
function siegeEnd(roomName: string, siege: SiegeMemory): { result: "taken" | "abandoned"; why: string } | null {
    if (siege.losses >= MAX_GUARD_LOSSES) return { result: "abandoned", why: `${siege.losses} guards lost` };
    if (Game.time - siege.since > SIEGE_TIMEOUT) return { result: "abandoned", why: "too long" };
    const room = Game.rooms[roomName];
    // Out of sight: the guard gives the vision back
    if (!room) return null;
    const controller = room.controller;
    if (!controller?.owner || controller.my) return { result: "taken", why: "controller neutral" };
    if (controller.owner.username !== siege.owner) return { result: "abandoned", why: `now owned by ${controller.owner.username}` };
    siege.level = controller.level;
    siege.downgrade = Game.time + controller.ticksToDowngrade;
    if (controller.upgradeBlocked) siege.blockedUntil = Game.time + controller.upgradeBlocked;
    if (controller.safeMode) return { result: "abandoned", why: "safe mode" };
    for (const s of room.find(FIND_HOSTILE_STRUCTURES)) {
        if (s.structureType === STRUCTURE_SPAWN) return { result: "abandoned", why: "spawn rebuilt" };
        if (s.structureType === STRUCTURE_TOWER && (s as StructureTower).store.getUsedCapacity(RESOURCE_ENERGY) >= MIN_TOWER_ENERGY)
            return { result: "abandoned", why: "armed tower" };
    }
    return null;
}

function endSiege(roomName: string, siege: SiegeMemory, result: "taken" | "abandoned", why: string): void {
    const memory = militaryMemory();
    memory.log = [...(memory.log ?? []).slice(-9), { room: roomName, result, time: Game.time, losses: siege.losses, squad: "siege" }];
    countStat(`military:siege:${result}`);
    log.info(
        "Military",
        `Siege of ${roomName} (${siege.owner}): ${result}, ${why}, after ${Game.time - siege.since} ticks, ` +
            `${siege.attacks} attacks, ${siege.losses} guards lost`
    );
    // The room is free: remote mining and the expansion may use it (its reserved rooms were released on the squad's success)
    if (result === "taken") releaseRooms([roomName], siege.owner);
    delete memory.sieges![roomName];
    if (Object.keys(memory.sieges!).length === 0) delete memory.sieges;
}

/** Every tick (military.ts): losses, the controller seen, the end of each siege */
export function runSieges(): void {
    const current = militaryMemory().sieges;
    if (!current) return;
    for (const roomName of Object.keys(current)) {
        const siege = current[roomName];
        countLosses(roomName, siege);
        const end = siegeEnd(roomName, siege);
        if (end) endSiege(roomName, siege, end.result, end.why);
    }
}

/** Base of the siege with the biggest energy capacity (it spawns the attacker) */
function biggestBase(siege: SiegeMemory): Room | undefined {
    const rooms = siege.bases.map(b => Game.rooms[b]).filter((r): r is Room => !!r?.controller?.my);
    if (rooms.length === 0) return undefined;
    return _.max(rooms, r => r.energyCapacityAvailable);
}

/** Roles given to a spawn this tick (heap): two bases never spawn the same creep */
const claimed: { tick: number; roles: string[] } = { tick: -1, roles: [] };

function pendingRoles(roomName: string): string[] {
    if (claimed.tick !== Game.time) return [];
    return claimed.roles.filter(r => r.startsWith(`${roomName}|`)).map(r => r.split("|")[1]);
}

function siegeOption(role: string, target: string, why: string): SpawnOption[] {
    // Weight 1 like the squads: at weight 0 the mockup guard waited ~1000 ticks behind remote creeps of priority 3
    return [{ role, priority: SIEGE_PRIORITY, weight: 1, memory: { siege: target }, reason: `siege ${target} ${why}` } as SpawnOption];
}

/** The creep a base of a siege spawns: the guard when none will be there, the attacker on time */
function siegeOptions(room: Room): SpawnOption[] {
    for (const [target, siege] of Object.entries(sieges())) {
        if (!siege.bases.includes(room.name)) continue;
        const route = squadRoute(room.name, target);
        if (!route) continue;
        const rooms = route.length - 1;
        const creeps = siegeCreeps(target);
        const pending = pendingRoles(target);
        const capacity = room.energyCapacityAvailable;
        const guardArrival = arrivalTicks(rooms, siegeGuardBody(capacity).length);
        const guards = creeps.filter(c => c.memory.role === SIEGE_GUARD && !guardDue(c.ticksToLive ?? CREEP_LIFE_TIME, guardArrival));
        if (guards.length === 0 && !pending.includes(SIEGE_GUARD)) return siegeOption(SIEGE_GUARD, target, "guard");
        if (biggestBase(siege)?.name !== room.name || siegeClaimParts(capacity) === 0) continue;
        if (creeps.some(c => c.memory.role === CONTROLLER_ATTACKER) || pending.includes(CONTROLLER_ATTACKER)) continue;
        const nextAttack = Math.max(Game.time, siege.blockedUntil ?? 0);
        if (attackerDue(nextAttack, Game.time, arrivalTicks(rooms, attackerBody(capacity).length)))
            return siegeOption(CONTROLLER_ATTACKER, target, `attack at ${nextAttack}`);
    }
    return [];
}

/** Spawn role of the siege creeps (bases of each siege) */
export const siegeSpawnRole: SpawnRole = {
    id: "siege",
    emptyTimeout: 10,

    options(room) {
        if (!militaryMemory().sieges || effectiveEnergy(room) < SIEGE_MIN_ENERGY) return [];
        return siegeOptions(room);
    },

    body(room, option) {
        return option.role === SIEGE_GUARD ? siegeGuardBody(room.energyCapacityAvailable) : attackerBody(room.energyCapacityAvailable);
    },

    memory(room, option) {
        const target = option.memory?.siege;
        if (target) {
            if (claimed.tick !== Game.time) claimed.roles = [];
            claimed.tick = Game.time;
            claimed.roles.push(`${target}|${option.role}`);
        }
        return { role: option.role, room: room.name, siege: target };
    }
};

/** Room by room along the squad route (never through another player's room) */
export function travelToSiege(creep: Creep, target: string): void {
    const route = squadRoute(creep.room.name, target);
    trafficManager.moveToRoom(creep, route?.[1] ?? target);
}

/** The attacker's successful attack: the next one waits for the upgrade block */
export function noteAttack(roomName: string, controller: StructureController): void {
    const siege = sieges()[roomName];
    if (!siege) return;
    siege.attacks++;
    siege.lastAttack = Game.time;
    siege.blockedUntil = Game.time + ATTACK_CYCLE;
    countStat("military:siege:attack");
    log.info("Military", `Siege of ${roomName}: attack ${siege.attacks}, RCL ${controller.level}, ${controller.ticksToDowngrade} ticks to downgrade`);
}
