/**
 * Value of a room's mineral for the expansion score (pure, offline check: tests/mineralValue/run.mjs).
 *
 * Not in Hivemind, whose score adds 1 / (rooms already on that mineral + 1) whatever the mineral is
 * worth. shard0 2026-11-01: our 5 rooms sit on H x3, L and K, 7-day averages H 273, K 67 against
 * O 553, L 688, X 691; the minerals are sold (H 21.6k for 12.9M credits over 12000 ticks), so a room
 * on X earns ~2.5x what a room on H earns, ~10x a room on K. The term is scaled by the mineral's price
 * over the median base mineral price, between MIN_VALUE_FACTOR and MAX_VALUE_FACTOR: a median mineral
 * keeps the old term, one source (2 points) still outweighs any mineral.
 */

export const MIN_VALUE_FACTOR = 0.25;
export const MAX_VALUE_FACTOR = 2;

const BASE_MINERALS: MineralConstant[] = ["H", "O", "U", "L", "K", "Z", "X"] as MineralConstant[];

/** Market price of a mineral, undefined without data */
export type MineralPrice = (resourceType: MineralConstant) => number | undefined;

/** Price of the mineral over the median base mineral price, clamped; 1 without prices */
export function mineralValueFactor(mineral: MineralConstant, price: MineralPrice): number {
    const own = price(mineral);
    const known = BASE_MINERALS.map(price).filter((p): p is number => p !== undefined && p > 0).sort((a, b) => a - b);
    if (own === undefined || own <= 0 || known.length === 0) return 1;
    const middle = Math.floor(known.length / 2);
    const median = known.length % 2 === 1 ? known[middle] : (known[middle - 1] + known[middle]) / 2;
    return Math.min(MAX_VALUE_FACTOR, Math.max(MIN_VALUE_FACTOR, own / median));
}

/** Expansion score term of a mineral: its value over (rooms we already own on it + 1) */
export function mineralScore(mineral: MineralConstant, owned: number, price: MineralPrice): number {
    return mineralValueFactor(mineral, price) / (owned + 1);
}
