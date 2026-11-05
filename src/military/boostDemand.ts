/**
 * Offensive boost demand (our design, 2026-11-05; pure functions, offline check tests/squadBoosts/run.mjs).
 *
 * A target is only picked when a squad holds with the boosts already in stock (targets.ts
 * feasibleOrigin), and since 2026-11-04 the labs make military compounds only for a running mission or
 * enemies at home (labs/chain.ts demandTargets): a target that needs boosts was never picked, so its
 * boosts were never made. shard0 after the CPU unlock: doorknobnob's W28N8 (RCL 6) and W27N9 (RCL 5),
 * 2 refilled towers each, stayed out of reach with nothing in stock. Now the best target blocked only
 * by the stock (the squad holds with compounds at market price, return of at least 1) writes a demand
 * `Memory.military.boostDemand` for its closest origin with labs; the labs make those compounds (kind
 * `offense`) and the market buys their base minerals while the credits stay above OFFENSE_CREDIT_FLOOR.
 * A demand is only made when its estimated purchase fits OFFENSE_CREDIT_SHARE of the credits above the
 * floor (shard0 2026-11-04: buys for unused military stocks drained the credits to 5.64). It ends once a
 * mission targets the room (the mission's own boosts take over), after DEMAND_TTL, or when the room is no
 * longer a blocked candidate.
 */

export type BoostedEffect = "heal" | "tough" | "attack";

export interface BoostDemand {
    /** Origin room whose labs make the compounds */
    home: string;
    target: string;
    /** Amount of each compound */
    compounds: { [compound: string]: number };
    since: number;
    /** Estimated credits of the base minerals to buy */
    credits: number;
}

/** A demand not turned into a mission is dropped after this long */
export const DEMAND_TTL = 20000;
/** Credits kept whatever an offensive demand asks */
export const OFFENSE_CREDIT_FLOOR = 100000;
/** Share of the credits above the floor one demand may cost */
export const OFFENSE_CREDIT_SHARE = 0.5;
/** LAB_BOOST_MINERAL (a literal: the module stays pure for the offline check) */
const BOOST_MINERAL = 30;

/** Compound amounts for the squad's boosted parts, with its replacements (`attrition`) */
export function demandAmounts(
    compounds: Record<BoostedEffect, string | null>,
    parts: Record<BoostedEffect, number>,
    attrition: number
): { [compound: string]: number } {
    const result: { [compound: string]: number } = {};
    for (const effect of Object.keys(compounds) as BoostedEffect[]) {
        const compound = compounds[effect];
        if (!compound || !parts[effect]) continue;
        result[compound] = (result[compound] ?? 0) + parts[effect] * BOOST_MINERAL * attrition;
    }
    return result;
}

/** The estimated purchase fits the share of the credits above the floor */
export function demandAffordable(estimate: number, credits: number): boolean {
    return estimate <= Math.max(0, credits - OFFENSE_CREDIT_FLOOR) * OFFENSE_CREDIT_SHARE;
}

/** Highest price the market pays for an offensive demand's base minerals: none (0) at the floor */
export function offenseMaxPrice(credits: number): number | null {
    return credits > OFFENSE_CREDIT_FLOOR ? null : 0;
}

/** keep, or why the demand ends */
export function demandState(
    demand: BoostDemand,
    now: number,
    state: { mission: boolean; blocked: boolean }
): "keep" | "expired" | "served" | "gone" {
    if (state.mission) return "served";
    if (now - demand.since >= DEMAND_TTL) return "expired";
    if (!state.blocked) return "gone";
    return "keep";
}
