/**
 * Expansion: claims a new room and bootstraps it until it stands alone, plus help for owned rooms
 * that lost their spawn (reclaim).
 * Ported from Hivemind (MIT), src/process/strategy/expand.ts, reclaim-manager.ts.
 * See docs/hivemind/hivemind-expansion.md.
 *
 * - May expand: a room at RCL 5+ (where the squad spawns), fewer owned rooms than the GCL, average CPU below 80% of the
 *   limit (100% with a single room, Hivemind's quirk). Target: best modified expansion score among
 *   scouted claimable rooms nobody owns, reachable from an RCL 5+ room with a spawn (<= 10 rooms).
 * - Squad "expand" from that room: a claimer and 2 pioneers (+ a defender when the target has
 *   hostiles); support squads of 1 pioneer from every other RCL 4+ room with 50000 energy.
 * - Success: RCL 4 and a storage. Failure: not claimed in 7500 ticks, or 30000 ticks after the claim,
 *   or lost; failed targets (and rooms around) score lower for a long time.
 * Deviations: units are spawned claimer first (Hivemind: random), the defender only against hostiles
 * (Hivemind: always), the claimer claims as soon as it reaches the controller.
 */

import { effectiveEnergy } from "../core/roomState";
import { intelManager } from "../modules/IntelManager";
import { hasInvaderCore, isRoomUnderAttack } from "../modules/RoomIntel";
import { log } from "../utils/logger";
import { expansionScore } from "./expansionScore";

export type SquadUnit = "claimer" | "pioneer" | "defender";

export interface Squad {
    spawnRoom: string;
    targetRoom: string;
    composition: Partial<Record<SquadUnit, number>>;
}

declare global {
    interface Memory {
        expand?: {
            current?: { roomName: string; spawnRoom: string; score: number; started: number; claimed?: number; pathBlocked?: number };
            failed: { roomName: string; time: number }[];
            squads: { [name: string]: Squad };
            /** No target found: next search */
            nextTry?: number;
        };
    }
    interface CreepMemory {
        /** Squad the creep belongs to and its unit type (kept by pioneers once in the target) */
        squad?: string;
        unit?: SquadUnit;
        /** Pioneer / claimer: room to work in */
        targetRoom?: string;
    }
}

const UNCLAIMED_TIMEOUT = 5 * CREEP_LIFE_TIME;
const CLAIMED_TIMEOUT = 20 * CREEP_LIFE_TIME;
const FAILURE_MEMORY = 1000000;
/** Longest route to a target, in rooms (Hivemind: navmesh path <= 500 tiles) */
const MAX_ROUTE_ROOMS = 10;
const SUPPORT_ENERGY = 50000;
const MAX_SUPPORT_SQUADS = 5;
const NO_TARGET_RETRY = 500;

export function expansionMemory(): NonNullable<Memory["expand"]> {
    if (!Memory.expand) Memory.expand = { failed: [], squads: {} };
    return Memory.expand;
}

function myRooms(): Room[] {
    return _.filter(Game.rooms, r => !!r.controller?.my);
}

/** Route length in rooms avoiding rooms owned by others, null when there is none */
function routeLength(from: string, to: string): number | null {
    const route = Game.map.findRoute(from, to, {
        routeCallback: room => {
            const intel = intelManager.getIntel(room);
            if (intel?.owner && intel.owner !== Memory.username) return Infinity;
            if (intel?.reserver && intel.reserver !== Memory.username && intel.reserver !== "Invader") return 1.5;
            return isRoomUnderAttack(room) ? 2 : 1;
        }
    });
    if (route === ERR_NO_PATH || route.length > MAX_ROUTE_ROOMS) return null;
    return route.length;
}

/** Closest RCL 5+ room with a spawn that can reach the target (Hivemind findClosestSpawn) */
function findSpawnRoom(target: string): string | null {
    let best: { room: string; length: number } | null = null;
    for (const room of myRooms()) {
        if (room.controller!.level < 5 || room.name === target) continue;
        if (room.find(FIND_MY_SPAWNS).length === 0) continue;
        const length = routeLength(room.name, target);
        if (length === null) continue;
        if (!best || length < best.length) best = { room: room.name, length };
    }
    return best?.room ?? null;
}

function mayExpand(): boolean {
    const rooms = myRooms();
    // Same RCL as findSpawnRoom: from RCL 4 the target search ran every 5 ticks without any origin
    if (!rooms.some(r => r.controller!.level >= 5)) return false;
    if (rooms.length >= Game.gcl.level) return false;
    const cpu = Memory.stats?.cpuAvg;
    if (cpu === undefined) return false;
    return cpu < Game.cpu.limit * (rooms.length === 1 ? 1 : 0.8);
}

/** Expansion score lowered near past failures (Hivemind getModifiedExpansionScore) */
function modifiedScore(roomName: string, score: number): number {
    for (const failure of expansionMemory().failed) {
        const elapsed = Game.time - failure.time;
        if (elapsed > FAILURE_MEMORY) continue;
        const factor = elapsed > 100000 ? 1 - (elapsed - 100000) / 900000 : 1;
        const distance = Game.map.getRoomLinearDistance(roomName, failure.roomName);
        if (distance === 0) score -= factor;
        else if (distance < 6) score -= factor / (distance + 1);
    }
    return score;
}

function chooseTarget(): void {
    let best: { roomName: string; spawnRoom: string; score: number; modified: number } | null = null;
    for (const roomName in intelManager.allIntel()) {
        const intel = intelManager.getIntel(roomName)!;
        if (intel.owner || Game.rooms[roomName]?.controller?.my) continue;
        const score = expansionScore(roomName);
        if (score === 0) continue;
        const modified = modifiedScore(roomName, score);
        if (best && best.modified >= modified) continue;
        const spawnRoom = findSpawnRoom(roomName);
        if (!spawnRoom) continue;
        best = { roomName, spawnRoom, score, modified };
    }
    if (!best) return;
    const memory = expansionMemory();
    memory.current = { roomName: best.roomName, spawnRoom: best.spawnRoom, score: best.score, started: Game.time };
    memory.squads.expand = { spawnRoom: best.spawnRoom, targetRoom: best.roomName, composition: { claimer: 1, pioneer: 2 } };
    log.info("Expansion", `Expanding to ${best.roomName} from ${best.spawnRoom} (score ${best.score.toFixed(2)})`);
}

function stopExpansion(failed: boolean): void {
    const memory = expansionMemory();
    const current = memory.current;
    if (!current) return;
    if (failed) memory.failed.push({ roomName: current.roomName, time: Game.time });
    for (const name in memory.squads) if (name === "expand" || name.startsWith("expandSupport.")) delete memory.squads[name];
    log.info("Expansion", `Expansion to ${current.roomName} ${failed ? "failed" : "done"}`);
    delete memory.current;
}

/** One pioneer from every other RCL 4+ room with 50000 energy (Hivemind manageExpansionSupport) */
function manageSupport(target: string, spawnRoom: string, claimed: boolean): void {
    const memory = expansionMemory();
    const active = new Set<string>();
    for (const room of myRooms()) {
        if (active.size >= MAX_SUPPORT_SQUADS) break;
        if (room.controller!.level < 4 || room.name === spawnRoom || room.name === target) continue;
        if (room.find(FIND_MY_SPAWNS).length === 0 || effectiveEnergy(room) < SUPPORT_ENERGY) continue;
        if (routeLength(room.name, target) === null) continue;
        const name = `expandSupport.${target}.${room.name}`;
        active.add(name);
        const composition: Squad["composition"] = { pioneer: 1 };
        if (!claimed && Math.random() < 0.05) composition.claimer = 1;
        memory.squads[name] = { spawnRoom: room.name, targetRoom: target, composition };
    }
    for (const name in memory.squads) if (name.startsWith("expandSupport.") && !active.has(name)) delete memory.squads[name];
}

function manageCurrent(): void {
    const memory = expansionMemory();
    const current = memory.current!;
    const squad = memory.squads.expand;
    manageSupport(current.roomName, current.spawnRoom, !!current.claimed);

    // Origin lost or path blocked for long: switch origin, else give up (no failure recorded)
    const spawnRoom = Game.rooms[current.spawnRoom];
    if (spawnRoom && routeLength(current.spawnRoom, current.roomName) === null) current.pathBlocked ??= Game.time;
    else if (spawnRoom) delete current.pathBlocked;
    if (!spawnRoom || (current.pathBlocked && Game.time - current.pathBlocked > UNCLAIMED_TIMEOUT)) {
        const origin = findSpawnRoom(current.roomName);
        if (!origin) {
            stopExpansion(false);
            return;
        }
        current.spawnRoom = origin;
        if (squad) squad.spawnRoom = origin;
    }

    const room = Game.rooms[current.roomName];
    if (squad) {
        // A defender while the target or the way there has hostiles (Hivemind: always one)
        squad.composition.defender = isRoomUnderAttack(current.roomName) || hasInvaderCore(current.roomName) ? 1 : 0;
    }
    if (room?.controller?.my) {
        if (!current.claimed) current.claimed = Game.time;
        if (squad) squad.composition.claimer = 0;
        if (room.controller.level >= 4 && room.storage) {
            stopExpansion(false);
            return;
        }
    } else if (room && squad) {
        const reservation = room.controller?.reservation;
        const hostileReservation = !!reservation && reservation.username !== Memory.username && reservation.ticksToEnd > 100;
        // A big enough claimer breaks the reservation first
        squad.composition.claimer = hostileReservation ? Math.ceil(reservation!.ticksToEnd / 2000) : 1;
    }

    const failed =
        (!current.claimed && Game.time - current.started > UNCLAIMED_TIMEOUT) ||
        (!!current.claimed && Game.time - current.claimed > CLAIMED_TIMEOUT) ||
        (!!current.claimed && !!room && !room.controller?.my);
    if (failed) stopExpansion(true);
}

/** Owned rooms without spawn (other than the expansion target) get pioneers from rooms with energy */
export function roomsNeedingReclaim(): string[] {
    const rooms = myRooms();
    if (rooms.length < 2) return [];
    const target = expansionMemory().current?.roomName;
    return rooms.filter(r => r.name !== target && r.find(FIND_MY_SPAWNS).length === 0).map(r => r.name);
}

/** Squads whose units a room spawns */
export function squadsOf(roomName: string): [string, Squad][] {
    return Object.entries(expansionMemory().squads).filter(([, s]) => s.spawnRoom === roomName);
}

/**
 * Squads of a room still claiming their target. Once the target is claimed a squad only sends
 * pioneers (2 per CREEP_LIFE_TIME at most), far lighter than a remote room, for up to
 * CLAIMED_TIMEOUT ticks: shard0 W29N7 mined 2 remote rooms instead of 3 while W28N7 grew.
 */
export function claimingSquadsOf(roomName: string): [string, Squad][] {
    const current = expansionMemory().current;
    return squadsOf(roomName).filter(([, s]) => !(current?.claimed && s.targetRoom === current.roomName));
}

export const expansionModule = (): void => {
    const memory = expansionMemory();
    if (Game.time % 5000 === 0) memory.failed = memory.failed.filter(f => Game.time - f.time <= FAILURE_MEMORY);
    if (!memory.current && Game.time >= (memory.nextTry ?? 0) && mayExpand()) {
        chooseTarget();
        // No target yet (scouting incomplete, none reachable): look again later
        if (!memory.current) memory.nextTry = Game.time + NO_TARGET_RETRY;
    }
    if (memory.current) manageCurrent();
};
