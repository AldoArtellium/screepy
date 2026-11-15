/**
 * Defense against incoming nukes, from plain numbers (no game objects: offline check node tests/nukes/run.mjs).
 * See defense/nukes.ts for how the inputs are read from a room and where the answers are used.
 *
 * Engine rules (@screeps/engine processor/intents/nukes/tick.js), applied on the tick before landTime:
 * - every creep in the room dies, every construction site, dropped resource, tombstone and ruin is removed,
 *   the spawn in progress is cancelled, safe mode ends and the controller can't be upgraded for 200 ticks;
 * - each tile within range 2 takes NUKE_DAMAGE (10M at the center, 5M around): a rampart takes it first and
 *   only what exceeds its hits reaches the structures under it. Nukes on the same tick add up.
 */

export const NUKE_RADIUS = 2;
export const NUKE_CENTER_DAMAGE = 10000000;
export const NUKE_SPLASH_DAMAGE = 5000000;
/** Hits a WORK part repairs per energy (REPAIR_POWER, one energy per part and tick) */
const HITS_PER_ENERGY = 100;
/** Hits a builder WORK repairs per tick on average: REPAIR_POWER on half of its ticks, the other half fetching */
export const REPAIR_HITS_PER_WORK_TICK = 50;
/** Hits above the damage: rampart decay (300 per 100 ticks) and the last repairs lost to the evacuation */
const MARGIN_RATIO = 0.02;
const MARGIN_HITS = 50000;

/**
 * What losing a structure costs, in energy: its construction cost plus the downtime (a room without spawn,
 * storage or towers right before the attack a nuke usually announces). A tile is protected when the repairs
 * cost at most this. Splash (5M hits = 51.5k energy of repairs) saves towers, labs and anything pricier;
 * the center (10M = 103k) saves spawns, storage, terminal, nuker, power spawn and factory. Extensions, links
 * and observers are cheaper to rebuild.
 */
export const STRUCTURE_WORTH: { [type: string]: number } = {
    spawn: 150000,
    storage: 150000,
    terminal: 150000,
    nuker: 150000,
    powerSpawn: 120000,
    factory: 120000,
    tower: 80000,
    lab: 60000,
    observer: 8000,
    link: 5000,
    extension: 3000
};

export interface NukeInput {
    x: number;
    y: number;
    timeToLand: number;
}

export interface StructureInput {
    x: number;
    y: number;
    /** Structure type (never a rampart: see RampartInput) */
    type: string;
}

export interface RampartInput {
    x: number;
    y: number;
    hits: number;
}

export interface NukeTile {
    x: number;
    y: number;
    /** Total damage of every incoming nuke on this tile */
    damage: number;
    /** First landing on this tile */
    timeToLand: number;
    /** Rampart hits that keep the structures under it alive */
    needed: number;
    /** Current rampart hits (0 without rampart) */
    rampartHits: number;
    /** Energy the missing hits cost */
    cost: number;
    /** STRUCTURE_WORTH of the structures on the tile */
    worth: number;
    types: string[];
}

export interface NukeDefensePlan {
    /** Tiles whose rampart gets repaired up to `needed`, best worth per energy first */
    protect: NukeTile[];
    /** Tiles with something worth saving left to the nuke (too costly, above the rampart limit or the budget) */
    abandon: NukeTile[];
    /** Hits still to repair on the protected tiles */
    deficit: number;
    /** First landing in the room */
    timeToLand: number;
}

/** Damage a tile takes from the given nukes */
export function nukeDamageAt(nukes: NukeInput[], x: number, y: number): number {
    let damage = 0;
    for (const nuke of nukes) {
        const range = Math.max(Math.abs(nuke.x - x), Math.abs(nuke.y - y));
        if (range === 0) damage += NUKE_CENTER_DAMAGE;
        else if (range <= NUKE_RADIUS) damage += NUKE_SPLASH_DAMAGE;
    }
    return damage;
}

export function inNukeRadius(nukes: NukeInput[], x: number, y: number): boolean {
    return nukes.some(n => Math.max(Math.abs(n.x - x), Math.abs(n.y - y)) <= NUKE_RADIUS);
}

/** Rampart hits that absorb `damage` with a margin */
export function neededRampartHits(damage: number): number {
    return Math.ceil(damage * (1 + MARGIN_RATIO) + MARGIN_HITS);
}

/**
 * Which tiles to protect. Each tile with a valued structure in a nuke radius needs a rampart above the damage;
 * it is protected when the repairs cost no more than the structures' worth, the room's rampart limit allows the
 * hits, and the energy budget still covers them (best worth per energy first).
 */
export function planNukeDefense(
    nukes: NukeInput[],
    structures: StructureInput[],
    ramparts: RampartInput[],
    rampartMax: number,
    energyBudget: number
): NukeDefensePlan {
    const timeToLand = nukes.length > 0 ? Math.min(...nukes.map(n => n.timeToLand)) : Infinity;
    const tiles = new Map<number, NukeTile>();
    for (const s of structures) {
        const worth = STRUCTURE_WORTH[s.type];
        if (!worth) continue;
        const hitting = nukes.filter(n => Math.max(Math.abs(n.x - s.x), Math.abs(n.y - s.y)) <= NUKE_RADIUS);
        if (hitting.length === 0) continue;
        const key = s.x + 50 * s.y;
        let tile = tiles.get(key);
        if (!tile) {
            const damage = nukeDamageAt(hitting, s.x, s.y);
            const rampartHits = ramparts.find(r => r.x === s.x && r.y === s.y)?.hits ?? 0;
            const needed = neededRampartHits(damage);
            tile = {
                x: s.x,
                y: s.y,
                damage,
                timeToLand: Math.min(...hitting.map(n => n.timeToLand)),
                needed,
                rampartHits,
                cost: Math.max(0, needed - rampartHits) / HITS_PER_ENERGY,
                worth: 0,
                types: []
            };
            tiles.set(key, tile);
        }
        tile.worth += worth;
        tile.types.push(s.type);
    }
    const ranked = [...tiles.values()].sort((a, b) => b.worth / Math.max(1, b.cost) - a.worth / Math.max(1, a.cost));
    const protect: NukeTile[] = [];
    const abandon: NukeTile[] = [];
    let budget = energyBudget;
    for (const tile of ranked) {
        if (tile.needed > rampartMax || tile.cost > tile.worth || tile.cost > budget) {
            abandon.push(tile);
            continue;
        }
        budget -= tile.cost;
        protect.push(tile);
    }
    const deficit = protect.reduce((sum, t) => sum + Math.max(0, t.needed - t.rampartHits), 0);
    return { protect, abandon, deficit, timeToLand };
}

/** Builder WORK parts that repair `deficit` hits within `ticks` (at least one while anything is missing) */
export function repairWork(deficit: number, ticks: number): number {
    if (deficit <= 0) return 0;
    return Math.max(1, Math.ceil(deficit / (Math.max(1, ticks) * REPAIR_HITS_PER_WORK_TICK)));
}

/** Ticks before the impact when no construction site is started anywhere in the room (all removed at impact) */
export const SITE_HOLD_TICKS = 500;

/**
 * Whether a construction site may be started: ramparts always (they are the defense) until the last
 * SITE_HOLD_TICKS, nothing else within the radius of an incoming nuke, nothing at all in the last ticks
 * (Hivemind skips spawns, extensions, links, containers and roads within range 2 of a nuke).
 */
export function siteAllowed(nukes: NukeInput[], x: number, y: number, isRampart: boolean): boolean {
    if (nukes.length === 0) return true;
    if (Math.min(...nukes.map(n => n.timeToLand)) <= SITE_HOLD_TICKS) return false;
    return isRampart || !inNukeRadius(nukes, x, y);
}

/** Ticks a creep needs per plain tile: fatigue 2 per non-MOVE part, each MOVE part removes 2 per tick */
export function ticksPerTile(moveParts: number, otherParts: number): number {
    if (moveParts <= 0) return Infinity;
    return Math.max(1, Math.ceil(otherParts / moveParts));
}

/** Slack on the way out: swamps, traffic, a detour around the base */
const EVACUATION_FACTOR = 1.5;
const EVACUATION_MARGIN = 20;
/** Every creep of the room leaves at least this early */
export const MIN_EVACUATION_TICKS = 50;

/** Ticks before the impact a creep `range` tiles from the exit starts leaving the room */
export function evacuationTicks(range: number, tilesTicks: number): number {
    if (!isFinite(tilesTicks)) return MIN_EVACUATION_TICKS;
    const ticks = Math.ceil(range * tilesTicks * EVACUATION_FACTOR) + EVACUATION_MARGIN;
    // Never before the neighbours' border is kept: a creep out earlier would walk back in
    return Math.min(BORDER_GUARD_TICKS, Math.max(MIN_EVACUATION_TICKS, ticks));
}

/** Creeps in a neighbour room keep this far from the border while the nuked room is being evacuated */
export const BORDER_GUARD_RANGE = 2;
/** The neighbour rooms' border is kept while the impact is this close */
export const BORDER_GUARD_TICKS = 500;

/**
 * No spawn in the room this close to the impact: a creep spawned now could not get out in time (and the spawn
 * in progress is cancelled at impact). Spawn time of a full body plus the longest evacuation.
 */
export const SPAWN_HOLD_TICKS = 50 * 3 + BORDER_GUARD_TICKS;
