/**
 * Option arbitration shared by spawning and the resource dispatcher.
 * Ported from Hivemind (MIT), src/utilities.ts getBestOption.
 */

export interface Option {
    /** Higher = more important. Negative options are never chosen. */
    priority: number;
    /** Tie-breaker between options of the same priority, higher wins */
    weight: number;
}

/** Highest priority, then highest weight; the first one collected wins ties */
export function getBestOption<T extends Option>(options: Iterable<T>): T | null {
    let best: T | null = null;
    for (const option of options) {
        if (option.priority < 0) continue;
        if (!best || option.priority > best.priority || (option.priority === best.priority && option.weight > best.weight)) {
            best = option;
        }
    }
    return best;
}
