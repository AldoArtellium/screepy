/**
 * Patient choice of idle healing (core/healing.ts), pure for the offline check tests/healing/run.mjs.
 */

export interface Point {
    x: number;
    y: number;
}

export interface Patient extends Point {
    id: string;
    hits: number;
    hitsMax: number;
}

/** Patients this close to a hostile are left alone: the healer would stand in a keeper's or a melee creep's reach */
export const DANGER_RANGE = 4;
/** rangedHeal's range */
export const RANGED_HEAL_RANGE = 3;

const range = (a: Point, b: Point): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/**
 * The patient to heal: the most hits missing, then the closest, among the wounded within `maxRange` of
 * `from` and farther than DANGER_RANGE from every hostile. The healer itself counts (range 0).
 */
export function pickPatient(
    from: Point,
    wounded: Patient[],
    danger: Point[] = [],
    maxRange = Infinity
): Patient | undefined {
    let best: Patient | undefined;
    for (const p of wounded) {
        if (p.hits >= p.hitsMax || range(from, p) > maxRange) continue;
        if (danger.some(d => range(d, p) <= DANGER_RANGE)) continue;
        if (!best) {
            best = p;
            continue;
        }
        const missing = p.hitsMax - p.hits;
        const bestMissing = best.hitsMax - best.hits;
        if (missing > bestMissing || (missing === bestMissing && range(from, p) < range(from, best))) best = p;
    }
    return best;
}

/**
 * Farthest patient a keeper killer waiting for a lair may walk to: there and back before the keeper
 * spawns, with a margin. Unbounded with no lair to wait for.
 */
export function roamRange(ticksToSpawn: number | undefined, margin = 10): number {
    if (ticksToSpawn === undefined) return Infinity;
    return Math.max(0, Math.floor((ticksToSpawn - margin) / 2));
}
