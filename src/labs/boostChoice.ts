/**
 * Choice of a boost compound for the parts of a creep, without game objects (tests/boosts checks it).
 * Hivemind (MIT) spawn-role/spawn-role.ts getBestBoost, with the partial boosts of our upgraders.
 */

export type BoostTable = Record<string, Record<string, Record<string, number>>>;

export interface BoostPick {
    compound: ResourceConstant;
    parts: number;
}

/**
 * Best compound for `parts` parts of a type with this effect; `available(compound)` = parts it can
 * still boost. Without `minParts` (Hivemind): enough for every part, strongest effect (damage: lowest
 * multiplier; Hivemind's getBestBoost took the highest). With `minParts` (not in Hivemind): as many
 * parts as the stock allows, at least min(parts, minParts), the biggest total gain. `maxTier`: compound
 * name length at most.
 */
export function pickBoost(
    table: BoostTable,
    part: BodyPartConstant,
    effect: string,
    parts: number,
    available: (compound: ResourceConstant) => number,
    maxTier?: number,
    minParts?: number
): BoostPick | null {
    if (parts === 0) return null;
    const boosts = table[part] ?? {};
    let best: BoostPick | null = null;
    let bestScore = 0;
    for (const key in boosts) {
        const value = boosts[key][effect];
        if (value === undefined) continue;
        if (maxTier && key.length > maxTier) continue;
        const compound = key as ResourceConstant;
        const count = Math.min(parts, available(compound));
        if (count < (minParts === undefined ? parts : Math.min(parts, minParts))) continue;
        const gain = effect === "damage" ? 1 - value : value - 1;
        const score = minParts === undefined ? gain : gain * count;
        if (!best || score > bestScore) {
            best = { compound, parts: count };
            bestScore = score;
        }
    }
    return best;
}
