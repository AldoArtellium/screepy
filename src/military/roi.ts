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
 * Targets of the simultaneous missions (our design, 2026-11-05: the CPU unlock left ~40 CPU idle while one
 * mission at a time ran): the current targets whose squad has creeps (`engaged`) and are still candidates
 * first, whatever their return, then the others by return (at least MIN_ROI, CURRENT_BONUS for a current
 * one), at most `max`. A squad already spawned for a target keeps it while it is still a candidate
 * (feasible, no safe mode, not failed): switching recycled it (shard0 W27N5, duo against W29N3)
 */
export function pickTargets<T extends { room: string; roi: number }>(
    candidates: T[],
    current: string[],
    engaged: string[],
    max: number
): T[] {
    if (max <= 0) return [];
    const kept = candidates.filter(c => current.includes(c.room) && engaged.includes(c.room));
    const rest = candidates
        .filter(c => !kept.includes(c) && c.roi >= MIN_ROI)
        .map(c => ({ c, score: current.includes(c.room) ? c.roi * CURRENT_BONUS : c.roi }))
        .sort((x, y) => y.score - x.score)
        .map(x => x.c);
    return [...kept, ...rest].slice(0, max);
}

/** Route length in rooms (route.ts squadRoute) from a mission's rally room to the bases spawning its members */
export const COLONY_RANGE = 4;
/** Ticks between two refreshes of a mission's bases (military.ts) */
export const BASES_REFRESH = 100;

/** An owned room that may spawn squad members; `route`: rooms to the rally (0: the rally, Infinity: no route) */
export interface BaseCandidate {
    room: string;
    route: number;
    capacity: number;
    rcl: number;
    spawns: number;
}

/**
 * Bases of a colony mission (our design, 2026-11-14; 2026-11-05 helpers within 2 rooms, frozen, one mission
 * per base): every owned room of RCL `minRcl`+ with a spawn, whose energy capacity builds the bodies the
 * mission is sized on (`energy`) and within COLONY_RANGE rooms of the rally, which members walk to to form
 * (quad.ts, duo.ts). Closest first: a quad's 4 members (~200 parts) took one spawn ~600 ticks.
 * None big enough: the rally (route 0) alone, with smaller bodies (military.ts memberEnergy), so a capacity
 * drop never stalls the mission (mockup rcl4 preset: RoomCleanup removed the extensions off the plan, the
 * capacity fell from 1300 to 800 at tick 100 and came back at 2000).
 */
export function colonyBases(energy: number, minRcl: number, candidates: BaseCandidate[]): string[] {
    const usable = candidates.filter(b => b.rcl >= minRcl && b.spawns > 0 && b.route <= COLONY_RANGE);
    const bases = usable
        .filter(b => b.capacity >= energy)
        .sort((x, y) => x.route - y.route || (x.room < y.room ? -1 : 1))
        .map(b => b.room);
    if (bases.length > 0) return bases;
    return usable.filter(b => b.route === 0).map(b => b.room);
}

/**
 * Base whose capacity a mission's bodies are sized on: among the candidates within COLONY_RANGE of the
 * rally, by capacity ascending (then closest), the first whose squad holds against the target with its
 * own boosts (`feasible`, sizing.ts planSquad): the smallest bodies that win let the most bases share the
 * mission. Null when none does.
 */
export function energyBase<T extends BaseCandidate>(
    candidates: T[],
    minRcl: number,
    feasible: (base: T) => boolean
): T | null {
    const sorted = candidates
        .filter(b => b.rcl >= minRcl && b.spawns > 0 && b.route <= COLONY_RANGE)
        .sort((x, y) => x.capacity - y.capacity || x.route - y.route);
    for (const base of sorted) if (feasible(base)) return base;
    return null;
}

/**
 * Base whose capacity and boosts size a mission: the smallest feasible one (energyBase); with `preferTank`
 * (the order by hand against towers that refill), the smallest whose squad tanks them first, when one does.
 * shard0 2026-11-25 W29N8 (doorknobnob, RCL 4, one tower and a tower feeder): sized on W28N7 (no labs, no
 * boosts), the quad needed a drain, the refills kept up and the mission was abandoned before the quad spawned
 * (`military:drain:noProgress`), while a base with labs fields a quad that tanks one refilled tower.
 */
export function missionBase<T extends BaseCandidate>(
    candidates: T[],
    minRcl: number,
    feasible: (base: T) => boolean,
    tanks: (base: T) => boolean,
    preferTank: boolean
): T | null {
    const tanking = preferTank ? energyBase(candidates, minRcl, base => feasible(base) && tanks(base)) : null;
    return tanking ?? energyBase(candidates, minRcl, feasible);
}

/**
 * Boost routing of a squad member: a base without the mission's compounds for the member's boosted parts
 * leaves it to a base of the mission that holds them; when none does, any base spawns it (labs/boosts.ts
 * boostsWith falls back to the best in stock)
 */
export function offersMember(boosted: boolean, holdsHere: boolean, holdsElsewhere: boolean): boolean {
    return !boosted || holdsHere || !holdsElsewhere;
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
