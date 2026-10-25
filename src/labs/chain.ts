/**
 * Reaction chain, without game objects (tests/boosts checks it): what to keep in stock and the next
 * compound to make towards it. The International (MIT) labs.ts chainDecompose / chainFindNextReaction.
 * Rules: docs/hivemind/hivemind-labs.md.
 */

/** Amount kept of each target compound (TI: 10 000; one room lacks the throughput for more) */
const TARGET_AMOUNT = 3000;

/**
 * Military compounds, in priority order (TI sorts its targets by deficit): HEAL, TOUGH, ATTACK,
 * RANGED_ATTACK, WORK repair (emergency builders). Without catalyst (X) the chain stops at the tier 2
 * compounds, which boost too. No MOVE compound: squad bodies are sized for plain MOVE.
 */
const MILITARY_TARGETS: ResourceConstant[] = [
    RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
    RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
    RESOURCE_CATALYZED_UTRIUM_ACID,
    RESOURCE_CATALYZED_KEANIUM_ALKALIDE,
    RESOURCE_CATALYZED_LEMERGIUM_ACID
];

/**
 * Upgrade compound by RCL (not in Hivemind, which boosts upgraders at RCL 8 only): a boosted WORK
 * upgrades x1.5 / x1.8 / x2 for the same energy and CPU. One reactor at RCL 6 makes GH ~2.4x faster
 * than GH2O (OH takes 20 ticks a reaction), which pays more progress per tick; RCL 7 has 4 reactors.
 */
const UPGRADE_TARGETS: { [rcl: number]: ResourceConstant[] } = {
    6: [RESOURCE_GHODIUM_HYDRIDE],
    7: [RESOURCE_GHODIUM_ACID]
};

/** What we want in stock, in priority order: upgrading, the military compounds with a threat */
export function reactionTargets(rcl: number, militaryFirst: boolean, militaryWanted: boolean): [ResourceConstant, number][] {
    const upgrade = UPGRADE_TARGETS[rcl] ?? [];
    const military = militaryFirst || militaryWanted ? MILITARY_TARGETS : [];
    const targets = militaryFirst ? [...military, ...upgrade] : [...upgrade, ...military];
    return targets.map(compound => [compound, TARGET_AMOUNT]);
}

/** Compound -> its two reagents */
const REAGENTS: { [compound: string]: [ResourceConstant, ResourceConstant] } = (() => {
    const result: { [compound: string]: [ResourceConstant, ResourceConstant] } = {};
    const reactions = REACTIONS as unknown as Record<string, Record<string, string>>;
    for (const r1 in reactions) {
        for (const r2 in reactions[r1]) result[reactions[r1][r2]] = [r1 as ResourceConstant, r2 as ResourceConstant];
    }
    return result;
})();

export function reagentsOf(compound: ResourceConstant): [ResourceConstant, ResourceConstant] | undefined {
    return REAGENTS[compound];
}

export function productOf(reaction: [ResourceConstant, ResourceConstant]): ResourceConstant {
    return (REACTIONS as unknown as Record<string, Record<string, ResourceConstant>>)[reaction[0]][reaction[1]];
}

/** The International chainDecompose: deficits of every compound for the targets, reagents included */
export function chainDeficits(targets: [ResourceConstant, number][], have: (r: ResourceConstant) => number): { [resourceType: string]: number } {
    const result: { [resourceType: string]: number } = {};
    const decompose = (compound: ResourceConstant, amount: number) => {
        result[compound] = (result[compound] ?? -have(compound)) + amount;
        const next = Math.max(0, Math.min(amount, result[compound]));
        const reagents = REAGENTS[compound];
        if (!reagents || next === 0) return;
        for (const reagent of reagents) decompose(reagent, next);
    };
    for (const [compound, amount] of targets) decompose(compound, amount);
    return result;
}

/**
 * The International chainFindNextReaction: make the target if both reagents are there (a quarter of
 * the amount, + 5% per reactor), else the first missing reagent that can be made. Not in TI: reagents
 * the other rooms hold (`imported`) count as there, the terminal transfers bring the reagents of the
 * reaction under way (core/resources.ts reactionCutoffs); a room holding only part of the base
 * minerals (shard0: Z and K in one room, U and L in the other) stopped at ZK or UL for good.
 */
export function findChainReaction(
    target: ResourceConstant,
    amount: number,
    reactors: number,
    have: (r: ResourceConstant) => number,
    imported: (r: ResourceConstant) => number,
    depth = 0
): ResourceConstant | null {
    const reagents = REAGENTS[target];
    if (!reagents || depth > 5) return null;
    const needed = Math.max(LAB_REACTION_AMOUNT, amount * (0.25 + 0.05 * reactors));
    const missing = reagents.filter(r => have(r) < needed);
    if (missing.length === 0) return target;
    if (missing.every(r => have(r) + imported(r) >= needed)) return target;
    for (const reagent of missing) {
        if (!REAGENTS[reagent]) continue; // base minerals: bought, not made
        const found = findChainReaction(reagent, amount, reactors, have, imported, depth + 1);
        if (found) return found;
    }
    return null;
}
