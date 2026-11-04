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

/**
 * Defense stock, kept whatever `Memory.military.auto` says and never bought: one response's worth of
 * each compound defense draws, at the largest bodies (RCL 7-8, core/bodyBuilder): ATTACK for a melee
 * guardian (33 parts) or a mini brawler (5), RANGED_ATTACK for a ranged guardian (33) or a blinky pair
 * (2 x 17), HEAL for a blinky pair (2 x 8), WORK repair for an emergency builder (17), TOUGH for a
 * TOUGH blinky pair (2 x 4, RCL 6-7). Users: spawnRoles.ts roomDefense (guardians, builders against
 * NORMAL+ enemies at home), remoteDefense.ts boostedDefense (boostedResponse needs one compound covering
 * every part of an effect). The tier 3 target stops at tier 2 without catalyst (X), which boosts too.
 */
const DEFENSE_TARGETS: [ResourceConstant, number][] = [
    [RESOURCE_CATALYZED_UTRIUM_ACID, 33 * LAB_BOOST_MINERAL],
    [RESOURCE_CATALYZED_KEANIUM_ALKALIDE, 34 * LAB_BOOST_MINERAL],
    [RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE, 16 * LAB_BOOST_MINERAL],
    [RESOURCE_CATALYZED_LEMERGIUM_ACID, 17 * LAB_BOOST_MINERAL],
    [RESOURCE_CATALYZED_GHODIUM_ALKALIDE, 8 * LAB_BOOST_MINERAL]
];

/** What we want in stock, in priority order: upgrading, the military compounds with a threat */
export function reactionTargets(rcl: number, militaryFirst: boolean, militaryWanted: boolean): [ResourceConstant, number][] {
    return demandTargets(rcl, militaryFirst, militaryWanted).map(t => [t.compound, t.amount]);
}

/**
 * A reaction target and whether the market may buy base minerals for it: `military` compounds only
 * for a demand (a mission, enemies at home), never for a stock (threat or defense); upgrade compounds
 * only below the value of what they upgrade (upgradeValuePerMineral)
 */
export interface DemandTarget {
    compound: ResourceConstant;
    amount: number;
    kind: "upgrade" | "military" | "stock";
}

/**
 * Targets by priority. `militaryFirst`: a mission or enemies at home use military boosts now;
 * `militaryWanted`: a stock against a threat for squads; otherwise the smaller defense stock. Both
 * stocks are made from what the rooms hold (no market buy).
 */
export function demandTargets(rcl: number, militaryFirst: boolean, militaryWanted: boolean): DemandTarget[] {
    const upgrade: DemandTarget[] = (UPGRADE_TARGETS[rcl] ?? []).map(compound => ({ compound, amount: TARGET_AMOUNT, kind: "upgrade" }));
    if (militaryFirst) return [...MILITARY_TARGETS.map(compound => ({ compound, amount: TARGET_AMOUNT, kind: "military" as const })), ...upgrade];
    if (militaryWanted) return [...upgrade, ...MILITARY_TARGETS.map(compound => ({ compound, amount: TARGET_AMOUNT, kind: "stock" as const }))];
    return [...upgrade, ...DEFENSE_TARGETS.map(([compound, amount]) => ({ compound, amount, kind: "stock" as const }))];
}

/** Base minerals in one unit of a compound (GH: H + Z, K, U, L = 5) */
export function baseMineralsIn(compound: ResourceConstant): number {
    const reagents = REAGENTS[compound];
    return reagents ? baseMineralsIn(reagents[0]) + baseMineralsIn(reagents[1]) : 1;
}

/**
 * Energy of upgrade progress one base mineral of an upgrade compound brings at most: the extra
 * progress of a boosted WORK over a whole creep life, per compound unit, over its base minerals
 * (GH 5, GH2O 5.7, XGH2O 6.25). shard0 2026-11-04: base minerals cost 560-886 credits and energy ~8.7,
 * so ~65-100 energy each: buying them for upgrade boosts never pays.
 */
export function upgradeValuePerMineral(compound: ResourceConstant, boosts: Record<string, Record<string, number>>): number {
    const multiplier = boosts[compound]?.upgradeController;
    if (!multiplier) return 0;
    return ((multiplier - 1) * UPGRADE_CONTROLLER_POWER * CREEP_LIFE_TIME) / LAB_BOOST_MINERAL / baseMineralsIn(compound);
}

/**
 * Base minerals the market may buy for the targets: each target's chain deficit pushed down to base
 * minerals (chainDeficits, in priority order) with the highest price per unit a target it serves
 * pays: `maxPrice(target)`, null for no cap beyond the market rules, 0 for nothing (a stock).
 * Before (2026-11-04) the market kept every base mineral above 10k per room whatever the labs made:
 * shard0 spent 37M credits in 21k ticks on O, X, U, L, Z, K for compounds nothing used.
 */
export function mineralNeeds(
    targets: DemandTarget[],
    have: (r: ResourceConstant) => number,
    maxPrice: (target: DemandTarget) => number | null
): { [mineral: string]: { amount: number; maxPrice: number | null } } {
    const result: { [mineral: string]: { amount: number; maxPrice: number | null } } = {};
    let before: { [resourceType: string]: number } = {};
    for (let i = 0; i < targets.length; i++) {
        const after = chainDeficits(
            targets.slice(0, i + 1).map(t => [t.compound, t.amount]),
            have
        );
        // Asked only once the target adds a need (the upgrade worth reads the energy price)
        let price: number | null | undefined;
        for (const resourceType in after) {
            if (REAGENTS[resourceType]) continue;
            const added = Math.max(0, after[resourceType]) - Math.max(0, before[resourceType] ?? 0);
            if (added <= 0) continue;
            if (price === undefined) price = maxPrice(targets[i]);
            if (price === 0) continue;
            const need = result[resourceType] ?? { amount: 0, maxPrice: 0 };
            need.amount += added;
            need.maxPrice = need.maxPrice === null || price === null ? null : Math.max(need.maxPrice, price);
            result[resourceType] = need;
        }
        before = after;
    }
    return result;
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
 * What the terminal transfers can bring from the other rooms: their amounts, except the reagents of
 * their own reaction under way (low there, never sent: two rooms both making G from ZK + UL waited
 * for each other's reagent for good)
 */
export function importableFrom(
    others: { amount: (r: ResourceConstant) => number; reaction?: [ResourceConstant, ResourceConstant] }[]
): (r: ResourceConstant) => number {
    return resourceType => {
        let total = 0;
        for (const other of others) if (!other.reaction?.includes(resourceType)) total += other.amount(resourceType);
        return total;
    };
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
