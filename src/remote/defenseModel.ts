/**
 * Remote defense model: which defender answers the hostiles of a remote (Hivemind getDefenseCreepSize,
 * src/spawn-role/brawler.ts, MIT), whether it wins the fight, and with which boosts when it only wins
 * boosted. No game state: the bodies and the compounds in stock are given, so
 * tests/remoteDefense/run.mjs checks it offline.
 */

import { buildBody, MoveMode } from "../core/bodyBuilder";
import type { EnemyData } from "./RemoteMining";

export const enum DefenseResponse {
    /** Melee only, against invader cores */
    ATTACKER = "attacker",
    MINI_BRAWLER = "miniBrawler",
    MINI_BLINKY = "miniBlinky",
    /** Blinky sized to the energy capacity */
    BLINKY = "blinky",
    /** Two blinkies leaving together (Hivemind RESPONSE_BLINKY_BLINKY_TRAIN, without the train) */
    BLINKY_PAIR = "blinkyPair"
}

/** 5 ATTACK + 3 HEAL; heal weighs 3 against melee */
const SMALL_DEFENDER_POWER = 5 * ATTACK_POWER + 3 * HEAL_POWER * 3;
/** 6 RANGED_ATTACK + 2 HEAL; heal weighs 5 */
const SMALL_BLINKY_POWER = 6 * RANGED_ATTACK_POWER + 2 * HEAL_POWER * 5;

/** Hivemind's power of a blinky body: heal weighs 5 */
function blinkyPower(body: BodyPartConstant[]): number {
    return _.sum(body, p => (p === RANGED_ATTACK ? RANGED_ATTACK_POWER : p === HEAL ? HEAL_POWER * 5 : 0));
}

/** Margin of the fight model: the hostiles must die this many times faster than our focused creep */
const WIN_MARGIN = 1.5;

/** Effects a remote defender's boosts change */
export type DefenseEffect = "heal" | "rangedAttack" | "attack" | "tough";

/** BOOSTS multipliers per effect (TOUGH: damage taken, lower is stronger); 1 = unboosted */
export type BoostMultipliers = Record<DefenseEffect, number>;

export const PLAIN: BoostMultipliers = { heal: 1, rangedAttack: 1, attack: 1, tough: 1 };

/**
 * Our damage against their hits faster, by WIN_MARGIN, than their incoming damage kills our focused
 * creep. TOUGH parts (in front) take `tough` x the damage: while our healing covers that they hold
 * (military/combat.ts canTank); past it each counts 100 / `tough` hits.
 */
function wins(
    enemies: EnemyData,
    body: BodyPartConstant[],
    damage: number,
    heal: number,
    incoming: number,
    tough = 1
): boolean {
    if (damage <= 0) return false;
    const toughParts = body.filter(p => p === TOUGH).length;
    if (incoming * (toughParts > 0 ? tough : 1) <= heal) return true;
    const killTicks = enemies.hits / damage;
    const deathTicks = ((body.length - toughParts) * 100 + (toughParts * 100) / tough) / (incoming - heal);
    return killTicks * WIN_MARGIN < deathTicks;
}

/**
 * Whether `count` creeps of `body` win against the hostiles (not in Hivemind, whose power alone sent a
 * blinky pair against 720 boosted ranged damage): our ranged damage minus their healing against their
 * hits, their damage minus our healing against the hits of the creep they focus. Kiting keeps melee
 * hostiles out of reach unless they are as fast as us (W7N4 mockup: a bigMelee* caught a lone blinky
 * along the room edge and killed it). `boosts`: multipliers of the compounds the creeps get.
 */
export function blinkyWins(enemies: EnemyData, body: BodyPartConstant[], count: number, boosts = PLAIN): boolean {
    const ranged = body.filter(p => p === RANGED_ATTACK).length;
    const damage = count * RANGED_ATTACK_POWER * ranged * boosts.rangedAttack - enemies.heal;
    const heal = count * HEAL_POWER * body.filter(p => p === HEAL).length * boosts.heal;
    const incoming = enemies.fastMelee ? enemies.damage : enemies.rangedDamage;
    return wins(enemies, body, damage, heal, incoming, boosts.tough);
}

/** Ticks a brawler fight is simulated for: past it, our heal holds against theirs */
const MELEE_FIGHT_TICKS = 200;

/**
 * Whether a melee brawler wins at range 1, where every hostile part reaches it. Only against invaders
 * with ATTACK: they walk up to us, whereas a ranged-only hostile or a player can kite it. Simulated tick
 * by tick with their damage x WIN_MARGIN: damage destroys parts from the front (the engine keeps the
 * hits on the last parts), so ATTACK parts in front stop hitting long before the creep dies (mockup
 * W7N4: an ATTACK-first brawler left a smallMelee at 310 of its 1000 hits). `boosts`: ATTACK and HEAL.
 */
export function brawlerWins(enemies: EnemyData, body: BodyPartConstant[], boosts = PLAIN): boolean {
    if (enemies.players || enemies.damage <= enemies.rangedDamage) return false;
    const maxHits = body.length * 100;
    let hits = maxHits;
    let enemyHits = enemies.hits;
    for (let tick = 0; tick < MELEE_FIGHT_TICKS; tick++) {
        const alive = body.slice(body.length - Math.ceil(hits / 100));
        enemyHits -= ATTACK_POWER * alive.filter(p => p === ATTACK).length * boosts.attack - enemies.heal;
        if (enemyHits <= 0) return true;
        const heal = HEAL_POWER * alive.filter(p => p === HEAL).length * boosts.heal;
        hits = Math.min(maxHits, hits - enemies.damage * WIN_MARGIN + heal);
        if (hits <= 0) return false;
    }
    return false;
}

/**
 * MOVE parts first on a melee defender: the invaders it fights walk up to it, so its MOVE parts are a
 * buffer that keeps the ATTACK parts hitting (bodyBuilder puts the military parts in front)
 */
export function meleeOrder(body: BodyPartConstant[]): BodyPartConstant[] {
    return [...body.filter(p => p === MOVE), ...body.filter(p => p !== MOVE)];
}

/** Mini brawler: at most 5 ATTACK, a HEAL per 2, MOVE parts in front */
export function miniBrawlerBody(energy: number): BodyPartConstant[] {
    const body = buildBody({
        weights: { [ATTACK]: 2, [HEAL]: 1 },
        partLimits: { [ATTACK]: 5 },
        moveMode: MoveMode.PLAINS,
        moveBufferRatio: 0.4,
        energyLimit: energy
    });
    return meleeOrder(body);
}

/**
 * Blinky (7 RANGED_ATTACK for 3 HEAL); `tough` TOUGH parts in front with their MOVE parts at the back,
 * for boosted TOUGH only (an empty body when it doesn't fit)
 */
export function blinkyBody(energy: number, maxRanged?: number, tough = 0): BodyPartConstant[] {
    if (tough > 0) {
        const body = blinkyBody(energy - tough * (BODYPART_COST[TOUGH] + BODYPART_COST[MOVE]), maxRanged);
        if (body.length === 0 || body.length + 2 * tough > MAX_CREEP_SIZE) return [];
        return [..._.fill(Array(tough), TOUGH), ...body, ..._.fill(Array(tough), MOVE)] as BodyPartConstant[];
    }
    return buildBody({
        weights: { [RANGED_ATTACK]: 7, [HEAL]: 3 },
        partLimits: maxRanged ? { [RANGED_ATTACK]: maxRanged } : undefined,
        moveMode: MoveMode.PLAINS,
        moveBufferRatio: 0.4,
        energyLimit: energy
    });
}

/**
 * Response to the hostiles (Hivemind getDefenseCreepSize); `miniBrawler` / `miniBlinky` / `blinky`: the
 * bodies the home can spawn. Not in Hivemind: a blinky response also has to win the fight (blinkyWins),
 * else the next step, else none: the remote waits for the hostiles to die (or boostedResponse). A mini
 * brawler also answers ranged invaders it beats at range 1 (shard0 W28N5: Hivemind's rule left a lone
 * smallMelee, one RANGED_ATTACK, to an RCL 3 home whose 800-energy blinkies all lose).
 */
export function defenseResponse(
    enemies: EnemyData,
    miniBrawler: BodyPartConstant[],
    miniBlinky: BodyPartConstant[],
    blinky: BodyPartConstant[]
): DefenseResponse | null {
    const power = enemies.damage + 5 * enemies.heal;
    if (enemies.hasInvaderCore && power < SMALL_DEFENDER_POWER) return DefenseResponse.ATTACKER;
    if (power < SMALL_DEFENDER_POWER / 2 && (!enemies.ranged || brawlerWins(enemies, miniBrawler))) {
        return DefenseResponse.MINI_BRAWLER;
    }
    if (power < SMALL_BLINKY_POWER && blinkyWins(enemies, miniBlinky, 1)) return DefenseResponse.MINI_BLINKY;
    if (power < blinkyPower(blinky) && blinkyWins(enemies, blinky, 1)) return DefenseResponse.BLINKY;
    if (power < 2 * blinkyPower(blinky) && blinkyWins(enemies, blinky, 2)) return DefenseResponse.BLINKY_PAIR;
    return null;
}

// ------------------------------------------------------------------ boosts

/** A boost level of an effect: a compound in stock for all the parts, its multiplier and its cost per part */
export interface DefenseBoost {
    compound: string;
    multiplier: number;
    /** Energy per part: the compound at its market price and the lab energy */
    cost: number;
    /** 1 to 3 */
    tier: number;
}

/** Compounds in the home's stock for `parts` parts of an effect (unboosted not included) */
export type BoostStock = (effect: DefenseEffect, parts: number) => DefenseBoost[];

/** A defender the home can spawn: its response, body, creep count and TOUGH parts */
export interface DefenseCandidate {
    response: DefenseResponse;
    body: BodyPartConstant[];
    count: number;
    tough: number;
}

export interface BoostedDefense {
    response: DefenseResponse;
    /** TOUGH parts in front of the blinky bodies */
    tough: number;
    /** Compound per effect */
    compounds: Partial<Record<DefenseEffect, string>>;
    /** Spawn energy + boosts of every creep */
    cost: number;
}

/** TOUGH parts of a boosted blinky variant (in front, one MOVE each) */
export const DEFENDER_TOUGH_PARTS = 4;

/**
 * The defenders the home can spawn with `energy`, for boostedResponse: the ladder's bodies, the blinky
 * ones also with DEFENDER_TOUGH_PARTS TOUGH parts (only chosen with a TOUGH compound)
 */
export function defenseCandidates(energy: number): DefenseCandidate[] {
    const candidates: DefenseCandidate[] = [
        { response: DefenseResponse.MINI_BRAWLER, body: miniBrawlerBody(energy), count: 1, tough: 0 }
    ];
    for (const tough of [0, DEFENDER_TOUGH_PARTS]) {
        candidates.push(
            { response: DefenseResponse.MINI_BLINKY, body: blinkyBody(energy, 6, tough), count: 1, tough },
            { response: DefenseResponse.BLINKY, body: blinkyBody(energy, undefined, tough), count: 1, tough },
            { response: DefenseResponse.BLINKY_PAIR, body: blinkyBody(energy, undefined, tough), count: 2, tough }
        );
    }
    return candidates.filter(c => c.body.length > 0);
}

const EFFECT_PARTS: [DefenseEffect, BodyPartConstant][] = [
    ["heal", "heal"],
    ["rangedAttack", "ranged_attack"],
    ["attack", "attack"],
    ["tough", "tough"]
];

/** Effects that matter for a response: ATTACK and HEAL for the brawler, RANGED_ATTACK, HEAL and TOUGH for blinkies */
function effectsOf(candidate: DefenseCandidate): DefenseEffect[] {
    return candidate.response === DefenseResponse.MINI_BRAWLER ? ["attack", "heal"] : ["rangedAttack", "heal", "tough"];
}

/**
 * Not in Hivemind (its remote defenders are never boosted): when no ladder step wins unboosted
 * (defenseResponse null), the cheapest candidate (spawn energy + compounds at their energy price, ties:
 * the lowest tiers) that wins the same fight model (blinkyWins / brawlerWins, WIN_MARGIN, here also on
 * their healing) with compounds from the home's stock, at least one, at most `maxCompounds` different ones (a boost lab
 * each). Hivemind's power thresholds are left out: the fight model decides. shard0 W29N6
 * (2026-10-26): a boosted smallMelee + smallHealer pair held W29N7's two remote sources for its life,
 * no step won unboosted.
 */
export function boostedResponse(
    enemies: EnemyData,
    candidates: DefenseCandidate[],
    stock: BoostStock,
    maxCompounds: number
): BoostedDefense | null {
    if (maxCompounds <= 0 || enemies.hasInvaderCore) return null;
    // Their healing x WIN_MARGIN too: a boosted brawler 30 damage a tick above a healer's 120 heal
    // (W7N3 mockup) never killed the pair, every tick spent chasing gave the hits back
    const judged = { ...enemies, heal: enemies.heal * WIN_MARGIN };
    let best: { defense: BoostedDefense; tiers: number } | null = null;
    for (const candidate of candidates) {
        const effects = effectsOf(candidate);
        const parts = (effect: DefenseEffect) =>
            candidate.count * candidate.body.filter(p => p === EFFECT_PARTS.find(e => e[0] === effect)![1]).length;
        const levels = effects.map(e => (parts(e) > 0 ? [null, ...stock(e, parts(e))] : [null]));
        const spawnCost = candidate.count * _.sum(candidate.body, p => BODYPART_COST[p]);
        for (const combo of product(levels)) {
            const chosen = combo.filter((b): b is DefenseBoost => !!b);
            if (chosen.length === 0 || chosen.length > maxCompounds) continue;
            const toughBoost = combo[effects.indexOf("tough")];
            if (candidate.tough > 0 && !toughBoost) continue;
            const multipliers = { ...PLAIN };
            const compounds: Partial<Record<DefenseEffect, string>> = {};
            let cost = spawnCost;
            let tiers = 0;
            effects.forEach((effect, i) => {
                const boost = combo[i];
                if (!boost) return;
                multipliers[effect] = boost.multiplier;
                compounds[effect] = boost.compound;
                cost += boost.cost * parts(effect);
                tiers += boost.tier;
            });
            const won =
                candidate.response === DefenseResponse.MINI_BRAWLER
                    ? brawlerWins(judged, candidate.body, multipliers)
                    : blinkyWins(judged, candidate.body, candidate.count, multipliers);
            if (!won) continue;
            if (!best || cost < best.defense.cost || (cost === best.defense.cost && tiers < best.tiers)) {
                best = { defense: { response: candidate.response, tough: candidate.tough, compounds, cost }, tiers };
            }
        }
    }
    return best?.defense ?? null;
}

/** Every combination picking one level per list */
function product<T>(lists: T[][]): T[][] {
    return lists.reduce<T[][]>((combos, list) => _.flatten(combos.map(c => list.map(item => [...c, item]))), [[]]);
}

/**
 * Hivemind defends no remote while the home has less than 5000 effective energy: before the storage
 * that is almost always, and an RCL 3 room living off its remotes lost them for each invader's 1500
 * ticks (shard0 W27N5). Not in Hivemind: before the storage, invaders get a defender anyway.
 */
export function skipsEnergyGate(hasStorage: boolean, enemies: EnemyData): boolean {
    return !hasStorage && !enemies.players;
}
