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
 *   under CPU pressure its CPU (squadCpu) priced in energy by targets.ts.
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

/** Spawn cost of the squad with its replacements */
export function squadCost(memberCosts: number[], attrition = ATTRITION): number {
    return memberCosts.reduce((sum, cost) => sum + cost, 0) * attrition;
}

/**
 * Official CPU per squad creep spawned (code, actions and moves over its life): mockup W7N3 `--preset
 * rcl7 --stronghold W7N4:1`, 4000 ticks, 12 quad creeps over 7036 creep-ticks for ~1900 CPU (Military
 * module 1646 with the quad's actions, roles 70, 1008 moves 202), ~0.27 per creep and tick.
 */
export const SQUAD_CREEP_CPU = 160;

/**
 * Official CPU of a squad with its replacements. Under CPU pressure targets.ts prices it at a neutral
 * remote source's energy per CPU (remoteIncome neutralEnergyPerCpu): the remote budget would mine
 * that energy with the CPU the squad takes (shard0: 17-19 of 20 CPU, remote rooms capped).
 */
export function squadCpu(members: number, attrition = ATTRITION): number {
    return members * attrition * SQUAD_CREEP_CPU;
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
        if (r.room === target) sources += r.sources;
        else if (r.reserver === owner && !r.owner && now - (r.scouted ?? now) <= RESERVATION_FRESH) {
            const toTarget = distance(r.room, target);
            if (playerRooms.every(p => p === target || distance(r.room, p) > toTarget)) sources += r.sources;
        }
    }
    return sources;
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

/** Best target by return, at least MIN_ROI; the current one counts CURRENT_BONUS times its return */
export function pickTarget<T extends { room: string; roi: number }>(candidates: T[], current: string | undefined): T | null {
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

/** Raids (opt-in `Memory.military.raid`): loot of a room without defense, taken without a squad */
export const RAID_MIN_LOOT = 10000;
/** Intel older than this is not trusted for a raid (towers may have been refilled) */
export const RAID_INTEL_AGE = 5000;
/** A tower with less than a shot of energy can't fire */
const RAID_MAX_TOWER_ENERGY = 10;
const MAX_LOOTERS = 3;
const TILES_PER_ROOM = 50;
/** CREEP_LIFE_TIME (a constant here: the module stays pure for the offline check) */
const LIFE_TIME = 1500;

interface RaidIntel {
    t: number;
    loot?: number;
    coreLevel?: number;
    towerEnergy?: number;
    damage: number;
    safeMode?: number;
    lootBarrier?: number;
}

/** Enough loot, fresh intel, no stronghold, no safe mode, towers empty, no armed creep, ramparts a dismantler opens */
export function isRaidable(intel: RaidIntel, now: number, maxBarrier: number): boolean {
    if ((intel.loot ?? 0) < RAID_MIN_LOOT || now - intel.t > RAID_INTEL_AGE) return false;
    if (intel.coreLevel !== undefined || (intel.safeMode ?? 0) > now) return false;
    if ((intel.towerEnergy ?? 0) >= RAID_MAX_TOWER_ENERGY || intel.damage > 0) return false;
    return (intel.lootBarrier ?? 0) <= maxBarrier;
}

/**
 * Looters a loot needs: round trips over a creep's life, at least one while loot is left, at most
 * MAX_LOOTERS (Overmind DirectiveHaul: amount x 2 x distance / (1500 x capacity))
 */
export function lootersNeeded(amount: number, routeRooms: number, capacity: number): number {
    if (amount <= 0 || capacity <= 0) return 0;
    const trips = (amount * 2 * Math.max(1, routeRooms) * TILES_PER_ROOM) / (LIFE_TIME * capacity);
    return Math.min(MAX_LOOTERS, Math.max(1, Math.ceil(trips)));
}

/** Spawn cost of a raid: its looters, and a dismantler when ramparts cover the loot */
export function raidCost(
    loot: number,
    routeRooms: number,
    looterCost: number,
    looterCapacity: number,
    dismantlerCost: number,
    covered: boolean
): number {
    return lootersNeeded(loot, routeRooms, looterCapacity) * looterCost + (covered ? dismantlerCost : 0);
}
