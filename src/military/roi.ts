/**
 * Return on investment of an automatic military target (targets.ts), in energy: what the target
 * brings against what the squad costs. Pure functions (tests/militaryRoi/run.mjs).
 *
 * - Value: the loot seen in the room (each resource at its market price in energy, 1 without prices),
 *   the remote income a stronghold blocks (REMOTE_NET per source and tick until its collapse, at most
 *   REMOTE_HORIZON ticks) and, for a player, the energy they made us lose (infamy).
 * - Cost: the spawn cost of the squad's bodies, ATTRITION times (the creeps lost are replaced: the
 *   mockup quad against a level 1 stronghold spawned 12 creeps for 4 members, earlier runs 4).
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
