/**
 * Target choice of a squad in the target room (pure: no Game globals, checked offline by
 * tests/militaryTargets/run.mjs).
 *
 * Classes, best first: armed towers and the invader core, spawns, empty towers, extensions, storage and
 * terminal, ramparts over loot (loot.ts), then the rest. Within the best class present the squad goes for
 * the lowest cost: ticks to break the hostile rampart covering the structure and the structure itself at
 * the squad's structure dps, plus the range to walk; ties go to the closest. A tower behind a 10M rampart
 * is no longer chosen over one behind 100k a few tiles further.
 */

/** Energy a tower needs to fire (TOWER_ENERGY_COST) */
export const MIN_TOWER_ENERGY = 10;

export const TARGET_CLASS = {
    armed: 0,
    spawn: 1,
    emptyTower: 2,
    extension: 3,
    store: 4,
    lootRampart: 5,
    other: 6
} as const;

/** Classes the squad must clear before a takeover goes for the controller (towers and spawns) */
export const CRITICAL_CLASS = TARGET_CLASS.emptyTower;

export interface TargetDescriptor {
    id: string;
    /** TARGET_CLASS value (lower is better) */
    cls: number;
    /** Hits of the structure itself */
    hits: number;
    /** Hits of the hostile rampart covering it (0 without) */
    coverHits: number;
    /** Range from the squad */
    range: number;
}

/** Class of a hostile structure (loot ramparts are classed by the caller) */
export function targetClass(structureType: string, energy = 0): number {
    switch (structureType) {
        case "tower":
            return energy >= MIN_TOWER_ENERGY ? TARGET_CLASS.armed : TARGET_CLASS.emptyTower;
        case "invaderCore":
            return TARGET_CLASS.armed;
        case "spawn":
            return TARGET_CLASS.spawn;
        case "extension":
            return TARGET_CLASS.extension;
        case "storage":
        case "terminal":
            return TARGET_CLASS.store;
        default:
            return TARGET_CLASS.other;
    }
}

/** Ticks to reach and break a target: (cover + own hits) / dps + range */
export function targetCost(target: TargetDescriptor, dps: number): number {
    return (target.coverHits + target.hits) / Math.max(1, dps) + target.range;
}

/** Cheapest target of the best class present, ties to the closest (null without targets) */
export function chooseTarget<T extends TargetDescriptor>(targets: T[], dps: number): T | null {
    let best: T | null = null;
    let bestCost = Infinity;
    for (const target of targets) {
        if (best && target.cls > best.cls) continue;
        const cost = targetCost(target, dps);
        if (
            !best ||
            target.cls < best.cls ||
            cost < bestCost ||
            (cost === bestCost && target.range < best.range)
        ) {
            best = target;
            bestCost = cost;
        }
    }
    return best;
}

/**
 * PathFinder cost of a barrier tile (hostile rampart or wall) towards the controller: its hits relative to
 * the strongest barrier of the room, scaled into 1..254 (255 is impassable)
 */
export function barrierCost(hits: number, maxHits: number): number {
    if (maxHits <= 0) return 1;
    return Math.min(254, Math.max(1, Math.ceil((254 * hits) / maxHits)));
}
