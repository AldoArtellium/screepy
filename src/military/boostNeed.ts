/**
 * Boosts a squad needs against its target: the cheapest set (spawn energy + compounds, with the
 * replacements) whose squad holds against the room's threat with BOOST_MARGIN, per effect (HEAL,
 * TOUGH, ATTACK) and squad type. Before (Hivemind getCreepBoosts), every member got the best compound
 * in stock whatever the target: a level 3 room with one tower took the T3 boosts a refilled tower
 * calls for. When nothing holds with the margin (forced attacks, a target judged on stale intel), the
 * strongest boosts in stock, as before. Pure functions (tests/squadBoosts/run.mjs). Our design.
 */

export type SquadType = "duo" | "quad";
export type BoostedEffect = "heal" | "tough" | "attack";
/** "auto": the cheapest set that holds (default), "max": the strongest in stock, "none": no boost */
export type BoostMode = "auto" | "max" | "none";

/** The threat is multiplied by this before the boosts are chosen (intel may be stale) */
export const BOOST_MARGIN = 1.2;
/** Ticks the front creep must last at the room edge for a squad to be worth sending */
export const SURVIVE_TICKS = 20;
/**
 * Towers that refill (strongholds: the core refills an empty tower, 1% a tick at level 1) can't be
 * drained for good: the front creep must last this long at close range (the walk out under fire)
 */
export const SURVIVE_CLOSE_TICKS = 10;
const EFFECTS: BoostedEffect[] = ["heal", "tough", "attack"];

/** A boost level of an effect: no compound (multiplier 1, cost 0) or a compound in stock for all the parts */
export interface BoostOption {
    compound: string | null;
    /** BOOSTS multiplier (TOUGH: damage taken, lower is stronger) */
    multiplier: number;
    /** Energy per part boosted: the compound at its market price and the lab energy */
    cost: number;
    /** 0 none, 1 to 3 */
    tier: number;
}

export interface ThreatModel {
    /** Every tower at close range plus the enemy creeps */
    close: number;
    /** Every tower at the room edge plus the enemy creeps */
    edge: number;
    /** Damage needed to beat the enemy healing */
    minDamage: number;
}

export interface SquadShape {
    type: SquadType;
    /** Spawn energy of every member */
    spawnCost: number;
    /** Healing per tick of the squad's healers, unboosted */
    heal: number;
    /** Melee damage per tick of the duo attacker, unboosted (against the enemy healing) */
    damage: number;
    /** TOUGH parts of the front creep and its other parts (its hits) */
    frontTough: number;
    frontOther: number;
    /** A forced squad type: judged on its front creep, whatever the type (sizing.ts before the boost choice) */
    soak?: boolean;
    /** Parts of each boosted type over the whole squad (boost cost) */
    parts: Record<BoostedEffect, number>;
    /** Levels per effect, unboosted first */
    options: Record<BoostedEffect, BoostOption[]>;
}

export type SquadCompounds = Partial<Record<BoostedEffect, string | null>>;

export interface SquadChoice {
    type: SquadType;
    /** The squad holds without the margin (the target is worth sending to) */
    feasible: boolean;
    compounds: Record<BoostedEffect, string | null>;
    /** Boosted healing of the squad */
    heal: number;
    /** Energy of the boosts of one squad */
    boostCost: number;
    /** (Spawn energy + boosts) x attrition */
    cost: number;
}

export interface ChooseOptions {
    mode?: BoostMode;
    margin?: number;
    attrition?: number;
    /** Boosts chosen before (escalation): never weaker */
    floor?: SquadCompounds;
}

type Levels = Record<BoostedEffect, BoostOption>;

/** Tier of a compound from its name length: 2 (UH) T1, 4 (UH2O) T2, 5 (XUH2O) T3 */
export function tierOf(compound: string): number {
    return compound.length <= 2 ? 1 : compound.length === 4 ? 2 : 3;
}

/** Strength of a level: higher is stronger */
function gain(effect: BoostedEffect, option: BoostOption): number {
    return effect === "tough" ? 1 - option.multiplier : option.multiplier - 1;
}

function judge(shape: SquadShape, levels: Levels, threat: ThreatModel, refills: boolean, margin: number) {
    const heal = shape.heal * levels.heal.multiplier;
    const need = (refills ? threat.close : threat.edge) * margin;
    const frontHits = (shape.frontTough * 100) / levels.tough.multiplier + shape.frontOther * 100;
    const ticks = refills ? SURVIVE_CLOSE_TICKS : SURVIVE_TICKS;
    const soaks = heal >= need || frontHits >= (need - heal) * ticks;
    // A duo is only chosen when its healer covers the damage and its attacker beats the enemy healing
    // (old type rule); a forced one is judged on its front creep like a quad
    const holds =
        shape.type === "duo" && !shape.soak
            ? heal >= need && shape.damage * levels.attack.multiplier >= threat.minDamage
            : soaks;
    return { holds, heal };
}

function strongest(options: BoostOption[], effect: BoostedEffect): BoostOption {
    return options.reduce((best, o) => (gain(effect, o) > gain(effect, best) ? o : best), options[0]);
}

function result(shape: SquadShape, levels: Levels, threat: ThreatModel, refills: boolean, attrition: number): SquadChoice {
    const boostCost = Math.round(EFFECTS.reduce((sum, e) => sum + shape.parts[e] * levels[e].cost, 0));
    const { holds, heal } = judge(shape, levels, threat, refills, 1);
    return {
        type: shape.type,
        feasible: holds,
        compounds: { heal: levels.heal.compound, tough: levels.tough.compound, attack: levels.attack.compound },
        heal,
        boostCost,
        cost: (shape.spawnCost + boostCost) * attrition
    };
}

/** Levels of an effect allowed by the mode and the floor */
function allowed(shape: SquadShape, effect: BoostedEffect, mode: BoostMode, floor?: SquadCompounds): BoostOption[] {
    const options = shape.options[effect];
    if (mode === "none") return [options[0]];
    if (mode === "max") return [strongest(options, effect)];
    const compound = floor?.[effect];
    if (!compound) return options;
    const kept = options.find(o => o.compound === compound);
    // A floor compound no longer in stock: its tier or above, else the strongest left
    const above = kept
        ? options.filter(o => gain(effect, o) >= gain(effect, kept))
        : options.filter(o => o.tier >= tierOf(compound));
    return above.length > 0 ? above : [strongest(options, effect)];
}

/**
 * Squad type and boosts against a target: in "auto" the cheapest set over `shapes` that holds with the
 * margin (ties: the lowest tiers), else, and in "max", the strongest boosts in stock with the old type
 * rule (the first shape that holds, the last one otherwise: duo, then quad)
 */
export function chooseSquad(shapes: SquadShape[], threat: ThreatModel, refills: boolean, opts: ChooseOptions = {}): SquadChoice {
    const mode = opts.mode ?? "auto";
    const margin = opts.margin ?? BOOST_MARGIN;
    const attrition = opts.attrition ?? 2;
    if (mode === "auto") {
        let best: { choice: SquadChoice; tiers: number } | null = null;
        for (const shape of shapes) {
            for (const heal of allowed(shape, "heal", mode, opts.floor))
                for (const tough of allowed(shape, "tough", mode, opts.floor))
                    for (const attack of allowed(shape, "attack", mode, opts.floor)) {
                        const levels = { heal, tough, attack };
                        if (!judge(shape, levels, threat, refills, margin).holds) continue;
                        const choice = result(shape, levels, threat, refills, attrition);
                        const tiers = heal.tier + tough.tier + attack.tier;
                        if (!best || choice.cost < best.choice.cost || (choice.cost === best.choice.cost && tiers < best.tiers))
                            best = { choice, tiers };
                    }
        }
        if (best) return best.choice;
    }
    const fallback = mode === "none" ? "none" : "max";
    const choices = shapes.map(shape => {
        const levels = {
            heal: allowed(shape, "heal", fallback)[0],
            tough: allowed(shape, "tough", fallback)[0],
            attack: allowed(shape, "attack", fallback)[0]
        };
        return { shape, levels, holds: judge(shape, levels, threat, refills, 1).holds };
    });
    const pick = choices.find(c => c.holds) ?? choices[choices.length - 1];
    return result(pick.shape, pick.levels, threat, refills, attrition);
}
