/**
 * When a remote source needs a remote builder trip (pure, offline check: tests/remoteRepairs/run.mjs),
 * used by RemoteMining.ts needsRepairs.
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
