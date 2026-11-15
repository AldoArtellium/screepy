/**
 * Safe mode baits (safeMode.ts; our design, 2026-11-15): a player room worth a squad whose safe mode is
 * armed gets a cheap armed creep first. It walks in and hits the closest structure; once the room is seen
 * in safe mode the charge is burnt and the room comes back as a squad target when the safe mode ends, in
 * the cooldown window (~30000 ticks without one). shard0 2026-11-14: Blindfold safe-moded W25N7 31 ticks
 * after our boosted quad came in, doorknobnob W26N7 the tick our remote defenders crossed it.
 *
 * One bait at a time, from the closest base with a spawn. A bait that dies or runs out of time without a
 * safe mode counts as a failure (`failures`); after MAX_BAIT_FAILURES the room gets squads directly.
 */

import { effectiveEnergy } from "../core/roomState";
import type { SpawnOption, SpawnRole } from "../spawning/spawnRoles";
import { log } from "../utils/logger";
import { countStat } from "../utils/stats";
import { hostileRoom, militaryMemory } from "./intel";
import { squadRoute } from "./route";
import { attackMode, safeModePhase } from "./safeMode";

export const BAIT = "bait";

export interface BaitMemory {
    /** Baits that came back without a safe mode */
    failures: number;
    /** The bait under way: started at, spawned from */
    since?: number;
    base?: string;
    /** Its creep was spawned: one creep per bait, its death without a safe mode is the failure */
    sent?: boolean;
}

declare global {
    interface CreepMemory {
        /** Room the bait goes to (bait.ts) */
        bait?: string;
    }
}

/** Two ATTACK parts: armed, hits a structure, 260 energy */
const BAIT_BODY: BodyPartConstant[] = [ATTACK, ATTACK, MOVE, MOVE];
/** A bait still without a safe mode this long after its start failed (spawn, trip of up to 10 rooms, hits) */
const BAIT_TIMEOUT = 1500;
/** Farthest base a bait leaves from */
const MAX_DISTANCE = 10;
/** Same scale as the squads (military.ts START_PRIORITY) */
const BAIT_PRIORITY = 3;
const BAIT_MIN_ENERGY = 300;

/** Rooms a bait is wanted for, best return first (targets.ts rankTargets, every target search) */
let wanted: string[] = [];
/** A target search ran since the global reset: before, a bait under way is not judged on `wanted` */
let wantedKnown = false;

export function setBaitCandidates(rooms: string[]): void {
    wanted = rooms;
    wantedKnown = true;
}

export function baits(): { [room: string]: BaitMemory } {
    const memory = militaryMemory();
    memory.baits = memory.baits ?? {};
    return memory.baits;
}

export function baitFailures(roomName: string): number {
    return militaryMemory().baits?.[roomName]?.failures ?? 0;
}

function baitCreeps(roomName: string): Creep[] {
    return _.filter(Game.creeps, c => c.memory.role === BAIT && c.memory.bait === roomName);
}

function stillArmed(roomName: string): boolean {
    const intel = hostileRoom(roomName);
    return !!intel && attackMode(safeModePhase(intel, Game.time), baitFailures(roomName)) === "bait";
}

/** Closest base of the squads' minimum RCL (targets.ts origins) with a spawn, within MAX_DISTANCE */
function closestBase(roomName: string): string | undefined {
    const minRcl = militaryMemory().minRcl ?? 4;
    const bases = _.filter(
        Game.rooms,
        r =>
            !!r.controller?.my &&
            r.controller.level >= minRcl &&
            r.find(FIND_MY_SPAWNS).length > 0 &&
            Game.map.getRoomLinearDistance(r.name, roomName) <= MAX_DISTANCE
    );
    if (bases.length === 0) return undefined;
    return _.min(bases, r => Game.map.getRoomLinearDistance(r.name, roomName)).name;
}

/** A squad attacks the room (manual attack or a mission): no bait there */
function squadThere(roomName: string): boolean {
    const memory = militaryMemory();
    if (memory.attack === roomName) return true;
    const missions = [...Object.values(memory.duos ?? {}), ...Object.values(memory.quads ?? {})];
    return missions.some(m => m.targetRoom === roomName);
}

/** The safe mode is on, seen now by the bait (the intel records every 10 ticks only) or in the intel */
function safeModeSeen(roomName: string): boolean {
    if (Game.rooms[roomName]?.controller?.safeMode) return true;
    return (hostileRoom(roomName)?.safeMode ?? 0) > Game.time;
}

type BaitEnd = "safeMode" | "failed" | "dropped";

function end(roomName: string, bait: BaitMemory, result: BaitEnd, why: string): void {
    delete bait.since;
    delete bait.base;
    delete bait.sent;
    if (result === "failed") bait.failures++;
    // A burnt charge shows the owner reacts to baits
    if (result === "safeMode") bait.failures = 0;
    countStat(`military:bait:${result}`);
    log.info("Military", `Bait on ${roomName}: ${why}${result === "failed" ? ` (${bait.failures} failed)` : ""}`);
}

/** Why the bait under way ends now, else null */
function baitEnd(roomName: string, bait: BaitMemory): [BaitEnd, string] | null {
    if (safeModeSeen(roomName)) return ["safeMode", "safe mode burnt"];
    if (!stillArmed(roomName) || (wantedKnown && !wanted.includes(roomName)))
        return ["dropped", "no longer a target to bait"];
    if (squadThere(roomName)) return ["dropped", "a squad attacks it"];
    if (bait.sent && baitCreeps(roomName).length === 0) return ["failed", "bait gone without a safe mode"];
    if (Game.time - bait.since! > BAIT_TIMEOUT)
        return bait.sent ? ["failed", "no safe mode in time"] : ["dropped", "bait never spawned"];
    return null;
}

/** Every tick: ends the bait under way, starts the next one */
export function runBaits(): void {
    const memory = militaryMemory();
    if (!memory.baits && wanted.length === 0) return;
    const all = baits();
    let active = false;
    for (const [roomName, bait] of Object.entries(all)) {
        if (bait.since === undefined) continue;
        // Its creep spawned (spawning included): one creep per bait
        if (!bait.sent && baitCreeps(roomName).length > 0) bait.sent = true;
        const ended = baitEnd(roomName, bait);
        if (ended) end(roomName, bait, ended[0], ended[1]);
        else active = true;
    }
    if (!active) {
        const next = wanted.find(room => stillArmed(room) && !squadThere(room) && !!closestBase(room));
        if (next) {
            const bait = all[next] ?? { failures: 0 };
            bait.since = Game.time;
            bait.base = closestBase(next);
            all[next] = bait;
            countStat("military:bait:start");
            log.info("Military", `Bait on ${next} from ${bait.base}: burns its safe mode before a squad`);
        }
    }
    // Rooms forgotten by the intel, or idle without failures, have nothing to keep
    for (const room of Object.keys(all))
        if (all[room].since === undefined && (all[room].failures === 0 || !hostileRoom(room))) delete all[room];
    if (Object.keys(all).length === 0) delete memory.baits;
}

/** The room a creep baits, while its bait is under way */
export function baitTarget(creep: Creep): string | undefined {
    const room = creep.memory.bait;
    return room && militaryMemory().baits?.[room]?.since !== undefined ? room : undefined;
}

/** Room by room along the squad route (never through another player's room) */
export function travelToBait(creep: Creep, target: string): string {
    const route = squadRoute(creep.room.name, target);
    return route?.[1] ?? target;
}

export const baitSpawnRole: SpawnRole = {
    id: "bait",
    emptyTimeout: 10,

    options(room) {
        const all = militaryMemory().baits;
        if (!all || effectiveEnergy(room) < BAIT_MIN_ENERGY) return [];
        for (const [target, bait] of Object.entries(all)) {
            if (bait.base !== room.name || bait.since === undefined || bait.sent) continue;
            if (baitCreeps(target).length > 0) continue;
            return [
                {
                    role: BAIT,
                    priority: BAIT_PRIORITY,
                    weight: 1,
                    memory: { bait: target },
                    reason: `bait ${target}`
                } as SpawnOption
            ];
        }
        return [];
    },

    body() {
        return BAIT_BODY;
    },

    memory(room, option) {
        return { role: BAIT, room: room.name, bait: option.memory?.bait };
    }
};
