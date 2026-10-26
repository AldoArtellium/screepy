/**
 * When a remote source needs a remote builder trip, and how many WORK parts (pure, offline check:
 * tests/remoteRepairs/run.mjs), used by RemoteMining.ts needsRepairs / repairNeed and remoteSpawnRole.
 *
 * Hivemind (builder.mines): the container below half its hits, or a road of the path missing or below
 * 2/3 of its hits. On a long path some road is always below 2/3, so every mined source kept its WORK
 * demand: shard0 2026-10-25, 6 remote builders (~1.5 CPU per tick with their moves, ~5 spawn energy per
 * tick) walked the paths 85% of their ticks to repair ~2 energy per tick, while the 7 remote rooms
 * missed ~2200 energy of hits in all (W28N6: 92). Here a road counts from a third of its hits (a plain
 * road there still has 16000+ ticks of decay left), or the path once REPAIR_BATCH_HITS are missing.
 */

export interface Hits {
    hits: number;
    hitsMax: number;
}

/** Hits missing on a path that make a trip worth it: ~one builder load (500 energy) */
export const REPAIR_BATCH_HITS = 50000;

/**
 * Container and road tiles of a path: an object when seen, null when missing (to build), undefined when
 * out of sight (nothing known)
 */
export function repairsDue(container: Hits | null | undefined, roads: (Hits | null | undefined)[] | undefined): boolean {
    if (container === null || (container && container.hits < container.hitsMax / 2)) return true;
    let missing = 0;
    for (const road of roads ?? []) {
        if (road === undefined) continue;
        if (road === null || road.hits < road.hitsMax / 3) return true;
        missing += road.hitsMax - road.hits;
    }
    return missing >= REPAIR_BATCH_HITS;
}

// ------------------------------------------------------------------ remote builder demand

/**
 * Remote builder WORK sized on the real need. Before, every mined source needing repairs asked for
 * ceil(0.7 + 0.03 x path tiles outside our rooms) WORK and builders were spawned until their WORK covered
 * the sum: shard0 2026-10-26 (W27N5, 20 CPU, CPU at 19.2), 4.7 remote builders of 33 parts on average,
 * ~1.4 CPU per tick (0.13 code + 0.84 move intents per creep) and ~4k spawn energy per 1000 ticks for
 * ~3.9 energy per tick of work, every road and container healthy. Now the WORK is what spends the energy
 * the paths miss (repair: hits / REPAIR_POWER, build: progress left) within one creep's life, trips home
 * to refill included, and a home keeps one remote builder at a time (remoteSpawnRole builderOption).
 */

/** A path tile: a structure (hits), a construction site (energy left to build), missing (null), out of sight (undefined) */
export type Tile = Hits | { buildLeft: number } | null | undefined;

export interface PathNeed {
    /** Hits missing on the container and the roads seen */
    repairHits: number;
    /** Energy left to build: construction sites, missing roads and container */
    buildEnergy: number;
}

export interface SourceNeed extends PathNeed {
    /** Path length home storage -> source */
    travel: number;
}

/** Remote builder bodies: CARRY 5 : WORK 2 (remoteSpawnRole builderBody) */
export const BUILDER_CARRY_PER_WORK = 2.5;
/** Floor while something is due: 2 WORK carry 250 energy per trip */
export const MIN_REPAIR_WORK = 2;
/** Floor while something is to build: 4 WORK build 20 per tick, a plain road site in 15 ticks */
export const MIN_BUILD_WORK = 4;
/**
 * Road upkeep outside our rooms, energy per tile and tick, for the selection's cost estimate: decay
 * (plain 100 hits per 1000 ticks = 0.001, swamp 0.005) plus the wear of the creeps walking on it (1 hit
 * per body part and step). shard0 2026-10-26: ~1.8 energy per tick repaired kept ~600-800 tiles healthy.
 */
export const ROAD_UPKEEP_ENERGY = 0.003;

/** CONSTRUCTION_COST of a container and a plain road */
const CONTAINER_BUILD = 5000;
const ROAD_BUILD = 300;
/** REPAIR_POWER / REPAIR_COST: hits per energy */
const HITS_PER_ENERGY = 100;
const CARRY_LOAD = 50;

/** Repair hits and build energy of a source's container and path tiles; a missing road costs `missingRoad` */
export function pathNeed(container: Tile, roads: Tile[], missingRoad = ROAD_BUILD): PathNeed {
    const need: PathNeed = { repairHits: 0, buildEnergy: 0 };
    const add = (tile: Tile, missing: number) => {
        if (tile === undefined) return;
        if (tile === null) need.buildEnergy += missing;
        else if ("buildLeft" in tile) need.buildEnergy += tile.buildLeft;
        else need.repairHits += Math.max(0, tile.hitsMax - tile.hits);
    };
    add(container, CONTAINER_BUILD);
    for (const road of roads) add(road, missingRoad);
    return need;
}

/**
 * Energy one WORK part spends over a remote builder's life: a load of BUILDER_CARRY_PER_WORK x 50 per
 * trip, a trip = the walk both ways + the ticks to repair the load (1 energy per WORK and tick; building
 * is 5x faster, so this is the slower case), the first walk out taken off the life
 */
export function energyPerWorkLife(travel: number, life = 1500): number {
    const load = BUILDER_CARRY_PER_WORK * CARRY_LOAD;
    const trips = Math.max(1, (life - travel) / (2 * travel + load));
    return load * trips;
}

/**
 * WORK parts that spend every due source's need within one creep's life, at least MIN_REPAIR_WORK
 * (MIN_BUILD_WORK while something is to build); 0 when nothing is needed
 */
export function builderWork(needs: SourceNeed[], life = 1500): number {
    let work = 0;
    let build = 0;
    let energy = 0;
    for (const need of needs) {
        const spend = need.repairHits / HITS_PER_ENERGY + need.buildEnergy;
        energy += spend;
        build += need.buildEnergy;
        work += spend / energyPerWorkLife(need.travel, life);
    }
    if (energy <= 0) return 0;
    return Math.ceil(Math.max(work, build > 0 ? MIN_BUILD_WORK : MIN_REPAIR_WORK));
}

/** Steady WORK a source's remote roads cost (selection estimate, remoteIncome sourceNet): their upkeep over a life */
export function upkeepWork(tiles: number, travel: number, life = 1500): number {
    return (tiles * ROAD_UPKEEP_ENERGY * life) / energyPerWorkLife(travel, life);
}
