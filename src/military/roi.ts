/**
 * Return on investment of an automatic military target (targets.ts), in energy: what the target
 * brings against what the squad costs. Pure functions (tests/militaryRoi/run.mjs).
 *
 * - Value: the loot seen in the room (each resource at its market price in energy, 1 without prices),
 *   the remote income a stronghold blocks (REMOTE_NET per source and tick until its collapse, at most
 *   REMOTE_HORIZON ticks) and, for a player, the energy they made us lose (infamy) and the remote
 *   sources its room's fall frees (freedSources, REMOTE_HORIZON ticks).
 * - Cost: the spawn cost of the squad's bodies, ATTRITION times (the creeps lost are replaced: the
 *   mockup quad against a level 1 stronghold spawned 12 creeps for 4 members, earlier runs 4), and
 *   the boosts the squad needs (sizing.ts planSquad).
 * - A target needs a ratio of MIN_ROI; the best one wins, the current one is kept unless another
 *   beats it by CURRENT_BONUS (no switching for a small difference).
 * Our design (Harabi's "ROI-driven target selection" with energy on both sides).
 */

export const ATTRITION = 2;
/** Net energy per tick of a remote source (typical `sourceNet` of mined sources: 3-9) */
export const REMOTE_NET = 3;
/** Remote income counted at most this far ahead */
export const REMOTE_HORIZON = 10000;
export const MIN_ROI = 1;
export const CURRENT_BONUS = 1.5;

/** Spawn cost of the squad with its replacements, and their boosts (`boostCost`: one squad's, sizing.ts planSquad) */
export function squadCost(memberCosts: number[], attrition = ATTRITION, boostCost = 0): number {
    return (memberCosts.reduce((sum, cost) => sum + cost, 0) + boostCost) * attrition;
}

/** Linear distance from a target's room to remote sources it frees (remote mining reaches 3 rooms, closer ones are mined first) */
export const FREED_REACH = 2;
/** A reservation seen longer ago than this may have run out (CONTROLLER_RESERVE_MAX; intel refreshes a controller every 10000 ticks out of sight) */
export const RESERVATION_FRESH = 5000;

export interface RoomHolding {
    room: string;
    owner?: string;
    reserver?: string;
    sources: number;
    /** Tick the owner and reserver were seen */
    scouted?: number;
}

/**
 * Remote sources a player's room frees when it falls (our design, a player target's `remote` value):
 * its own sources and those of the rooms the player reserves whose closest room of that player is the
 * target (strictly: on a tie another of its rooms keeps reserving them; a lower bound), each within
 * FREED_REACH of one of our rooms. Reservations seen more than RESERVATION_FRESH ticks before `now`
 * don't count. shard0 W28N8 (doorknobnob): its 2 sources and W27N7, next to W28N7, which mined a
 * single remote source.
 */
export function freedSources(
    target: string,
    owner: string,
    rooms: RoomHolding[],
    ours: string[],
    distance: (a: string, b: string) => number,
    now: number
): number {
    const playerRooms = rooms.filter(r => r.owner === owner).map(r => r.room);
    if (!playerRooms.includes(target)) return 0;
    const inReach = (room: string) => ours.some(o => distance(o, room) <= FREED_REACH);
    let sources = 0;
    for (const r of rooms) {
        if (!inReach(r.room)) continue;
        if (r.room === target || reservedFrom(r, target, owner, playerRooms, distance, now)) sources += r.sources;
    }
    return sources;
}

/** A fresh reservation of `owner` whose strictly closest room of theirs is `target` */
function reservedFrom(
    r: RoomHolding,
    target: string,
    owner: string,
    playerRooms: string[],
    distance: (a: string, b: string) => number,
    now: number
): boolean {
    if (r.reserver !== owner || r.owner || now - (r.scouted ?? now) > RESERVATION_FRESH) return false;
    const toTarget = distance(r.room, target);
    return playerRooms.every(p => p === target || distance(r.room, p) > toTarget);
}

/**
 * Rooms a player's fallen room releases (military.ts on a success): the room itself and the rooms they
 * reserved from it (freedSources' rule, without the reach), whose contest RoomIntel then forgets
 * (remote/remoteRooms.ts releaseFrom)
 */
export function releasedRooms(
    target: string,
    owner: string,
    rooms: RoomHolding[],
    distance: (a: string, b: string) => number,
    now: number
): string[] {
    const playerRooms = rooms.filter(r => r.owner === owner).map(r => r.room);
    if (!playerRooms.includes(target)) return [];
    return [target, ...rooms.filter(r => r.room !== target && reservedFrom(r, target, owner, playerRooms, distance, now)).map(r => r.room)];
}

/** Remote income a stronghold blocks until it collapses (ticksLeft) */
export function remoteValue(sources: number, ticksLeft: number): number {
    return sources * REMOTE_NET * Math.max(0, Math.min(ticksLeft, REMOTE_HORIZON));
}

/** Loot in energy: amount x the resource's price in energy */
export function lootValue(store: { [resourceType: string]: number }, price: (resourceType: string) => number): number {
    let value = 0;
    for (const resourceType in store) value += (store[resourceType] ?? 0) * price(resourceType);
    return value;
}

export function targetValue(parts: { loot: number; remote: number; infamy: number }): number {
    return parts.loot + parts.remote + parts.infamy;
}

/**
 * Best target by return, at least MIN_ROI; the current one counts CURRENT_BONUS times its return, and is
 * kept whatever its return while `engaged` (its squad has creeps) and still a candidate
 */
export function pickTarget<T extends { room: string; roi: number }>(
    candidates: T[],
    current: string | undefined,
    engaged = false
): T | null {
    // A squad already spawned (or spawning) for the current target keeps it while it is still a candidate
    // (feasible, no safe mode, not failed): switching recycled it (shard0 W27N5, duo against W29N3)
    if (engaged) {
        const kept = candidates.find(c => c.room === current);
        if (kept) return kept;
    }
    let best: T | null = null;
    let bestScore = 0;
    for (const candidate of candidates) {
        if (candidate.roi < MIN_ROI) continue;
        const score = candidate.room === current ? candidate.roi * CURRENT_BONUS : candidate.roi;
        if (!best || score > bestScore) {
            best = candidate;
            bestScore = score;
        }
    }
    return best;
}

const MAX_LOOTERS = 3;
const TILES_PER_ROOM = 50;
/** CREEP_LIFE_TIME (a constant here: the module stays pure for the offline check) */
const LIFE_TIME = 1500;

/**
 * Looters a loot needs: round trips over a creep's life, at least one while loot is left, at most
 * MAX_LOOTERS (Overmind DirectiveHaul: amount x 2 x distance / (1500 x capacity))
 */
export function lootersNeeded(amount: number, routeRooms: number, capacity: number): number {
    if (amount <= 0 || capacity <= 0) return 0;
    const trips = (amount * 2 * Math.max(1, routeRooms) * TILES_PER_ROOM) / (LIFE_TIME * capacity);
    return Math.min(MAX_LOOTERS, Math.max(1, Math.ceil(trips)));
}
