/**
 * Observer plan (pure, offline check: tests/observer/run.mjs), used by modules/ObserverManager.ts.
 *
 * Not in Hivemind (it observes for its own room intel, not this ranking). Rooms needing intel are the
 * scouts' list (IntelManager.needsScouting); each observer takes at most one of them per tick, the most
 * urgent first: active military targets, then remote candidates, then expansion candidates, then the
 * periodic rescout, the oldest intel first within a kind. Under CPU pressure only military targets are
 * observed. Rooms within OBSERVER_RANGE of one of our observers are left out of the scouts' targets.
 *
 * shard0 2026-11-15: ~0.25 CPU per tick of scouts (code + moves) and 4.3 scouts per 1000 ticks, while the
 * four rooms of doorknobnob north of W28N7 kept intel ~59k ticks old (scouts never got there); W27N5 (RCL 8)
 * has all of them within 4 rooms.
 */

export const OBSERVER_RANGE = 10;

/** Why a room needs intel, most urgent first */
export type IntelNeed = "military" | "remote" | "expansion" | "rescout";

const NEED_RANK: { [need in IntelNeed]: number } = { military: 0, remote: 1, expansion: 2, rescout: 3 };

export interface ObservationCandidate {
    room: string;
    need: IntelNeed;
    /** Ticks since the room was last seen (Infinity: never) */
    age: number;
}

export interface ObserverSite {
    id: string;
    /** Room of the observer */
    room: string;
}

export interface NeedContext {
    /** Active military targets */
    military: ReadonlySet<string>;
    /** Rooms our homes could mine */
    remote: ReadonlySet<string>;
    /** Expansion targets (current, next) */
    expansion: ReadonlySet<string>;
    /** Intel of the room: owner, controller; undefined when never seen */
    intel(room: string): { owner?: string; controller: boolean } | undefined;
}

/**
 * Kind of need of a room: a military target, a remote candidate (in range of a home, not another player's
 * room), an expansion candidate (an expansion target, never seen, or an unowned controller), else rescout
 */
export function classifyNeed(room: string, ctx: NeedContext): IntelNeed {
    if (ctx.military.has(room)) return "military";
    const intel = ctx.intel(room);
    if (ctx.remote.has(room) && !intel?.owner) return "remote";
    if (ctx.expansion.has(room) || !intel || (intel.controller && !intel.owner)) return "expansion";
    return "rescout";
}

/** Candidates in observation order (need, then oldest intel, then name); only military ones under CPU pressure */
export function rankCandidates(candidates: ObservationCandidate[], pressure: boolean): ObservationCandidate[] {
    return candidates
        .filter(c => !pressure || c.need === "military")
        .sort((a, b) => NEED_RANK[a.need] - NEED_RANK[b.need] || b.age - a.age || (a.room < b.room ? -1 : a.room > b.room ? 1 : 0));
}

/**
 * One room per observer for this tick: each ranked candidate in turn goes to the closest free observer
 * within OBSERVER_RANGE (ties to the first observer), each room observed once
 */
export function assignObservations(
    observers: ObserverSite[],
    ranked: ObservationCandidate[],
    distance: (a: string, b: string) => number
): { observer: string; room: string }[] {
    const free = new Set(observers.map(o => o.id));
    const result: { observer: string; room: string }[] = [];
    for (const candidate of ranked) {
        if (free.size === 0) break;
        let best: ObserverSite | undefined;
        let bestDistance = Infinity;
        for (const observer of observers) {
            if (!free.has(observer.id)) continue;
            const d = distance(observer.room, candidate.room);
            if (d <= OBSERVER_RANGE && d < bestDistance) {
                best = observer;
                bestDistance = d;
            }
        }
        if (!best) continue;
        free.delete(best.id);
        result.push({ observer: best.id, room: candidate.room });
    }
    return result;
}

/** A room within OBSERVER_RANGE of one of our observers: no scout goes there */
export function coveredByObserver(room: string, observerRooms: readonly string[], distance: (a: string, b: string) => number): boolean {
    return observerRooms.some(o => distance(o, room) <= OBSERVER_RANGE);
}
