/**
 * Squad bodies and sizing: duo or quad from the threat of the target room, after The International's
 * combat requests (minimum healing = towers x TOWER_POWER_ATTACK + enemy damage, minimum damage =
 * enemy healing x 1.2). Without boosts no squad out-heals a tower at close range below RCL 7, so the
 * squads drain towers from the room edge (tower damage at range 20+): the duo when its healer covers
 * the edge damage, else the quad; automatic targets only when the front creep of the chosen squad
 * lasts SURVIVE_TICKS at the edge (net damage against its hits), or SURVIVE_CLOSE_TICKS at close range
 * against towers that refill (strongholds). Our design.
 */

import { buildBody, MoveMode } from "../core/bodyBuilder";
import { boostableParts, BoostEffect, canBoost } from "../labs/boosts";
import { energyPrice } from "../modules/MarketManager";
import { BoostedEffect, BoostOption, chooseSquad, SquadCompounds, SquadShape, SquadType, tierOf } from "./boostNeed";
import { hostileRoom, militaryMemory } from "./intel";
import { ATTRITION } from "./roi";

export type { SquadType } from "./boostNeed";

/** Towers of the bunker templates by stronghold level (@screeps/common strongholds.js) */
const STRONGHOLD_TOWERS: Record<number, number> = { 1: 1, 2: 2, 3: 3, 4: 4, 5: 6 };

/** Damage of a tower at range 20 or more */
export const TOWER_EDGE_DAMAGE = TOWER_POWER_ATTACK * (1 - TOWER_FALLOFF);

export function duoAttackerBody(energy: number): BodyPartConstant[] {
    // ATTACK only (Hivemind's attacker body)
    return buildBody({ weights: { [ATTACK]: 1 }, moveMode: MoveMode.PLAINS, energyLimit: energy });
}

export function duoHealerBody(energy: number): BodyPartConstant[] {
    return buildBody({ weights: { [HEAL]: 1 }, moveMode: MoveMode.PLAINS, energyLimit: energy });
}

/** Quad front: melee, a few TOUGH (cheap hits: 60 energy per 100 hits with their MOVE) */
export function quadAttackerBody(energy: number): BodyPartConstant[] {
    return buildBody({ weights: { [TOUGH]: 1, [ATTACK]: 3 }, moveMode: MoveMode.PLAINS, energyLimit: energy });
}

/** Quad back: healing first, a ranged part per three heals once affordable */
export function quadHealerBody(energy: number): BodyPartConstant[] {
    return buildBody({ weights: { [HEAL]: 3, [RANGED_ATTACK]: 1 }, moveMode: MoveMode.PLAINS, energyLimit: energy });
}

/** Spawn cost of each member of a squad (roi.ts squadCost) */
export function squadMemberCosts(type: SquadType, energy: number): number[] {
    const cost = (body: BodyPartConstant[]) => _.sum(body, p => BODYPART_COST[p]);
    if (type === "duo") return [cost(duoAttackerBody(energy)), cost(duoHealerBody(energy))];
    const attacker = cost(quadAttackerBody(energy));
    const healer = cost(quadHealerBody(energy));
    return [attacker, attacker, healer, healer];
}

function count(body: BodyPartConstant[], type: BodyPartConstant): number {
    return body.filter(p => p === type).length;
}

export interface Threat {
    /** Every tower at close range, plus the enemy creeps (TI's minimum healing) */
    close: number;
    /** Every tower at the room edge, plus the enemy creeps */
    edge: number;
    /** Damage needed to beat the enemy healing (TI: x 1.2) */
    minDamage: number;
}

/** Threat of a room: live when visible, else from military intel (unknown: one tower, to be safe) */
export function threatOf(roomName: string): Threat {
    const room = Game.rooms[roomName];
    let towers: number;
    let damage: number;
    let heal: number;
    if (room) {
        towers = room.find(FIND_HOSTILE_STRUCTURES, { filter: s => s.structureType === STRUCTURE_TOWER }).length;
        const enemies = room.find(FIND_HOSTILE_CREEPS, { filter: c => c.owner.username !== "Source Keeper" });
        damage = _.sum(
            enemies,
            c => c.getActiveBodyparts(ATTACK) * ATTACK_POWER + c.getActiveBodyparts(RANGED_ATTACK) * RANGED_ATTACK_POWER
        );
        heal = _.sum(enemies, c => c.getActiveBodyparts(HEAL) * HEAL_POWER);
    } else {
        const intel = hostileRoom(roomName);
        // A stronghold seen before it deployed gets the towers of its template
        towers = Math.max(intel?.towers ?? 1, STRONGHOLD_TOWERS[intel?.coreLevel ?? 0] ?? 0);
        damage = intel?.damage ?? 0;
        heal = intel?.heal ?? 0;
    }
    return {
        close: towers * TOWER_POWER_ATTACK + damage,
        edge: towers * TOWER_EDGE_DAMAGE + damage,
        minDamage: heal * 1.2
    };
}

export interface SquadPlan {
    type: SquadType;
    /** The front creep of the chosen squad lasts SURVIVE_TICKS at the edge (boostNeed.ts) */
    feasible: boolean;
    /** Healing of the chosen squad, its boosts included */
    heal: number;
    threat: Threat;
    /** Compound per boosted part type (null: plain), boostNeed.ts */
    compounds: Record<BoostedEffect, string | null>;
    /** Energy of one squad's boosts (compounds at market price + lab energy) */
    boostCost: number;
}

/** Part type and boost effect of each boosted effect of a squad */
export const SQUAD_BOOST_PARTS: Record<BoostedEffect, [BodyPartConstant, BoostEffect]> = {
    heal: [HEAL, "heal"],
    tough: [TOUGH, "damage"],
    attack: [ATTACK, "attack"]
};

/**
 * Boost levels of an effect for `parts` parts: unboosted, then each compound in `room`'s stock for all
 * of them. The stock is read without the pending requests (boostableParts countRequested), so a squad
 * being boosted doesn't make its own target infeasible.
 */
function boostOptions(room: Room | undefined, effect: BoostedEffect, parts: number): BoostOption[] {
    const options: BoostOption[] = [{ compound: null, multiplier: 1, cost: 0, tier: 0 }];
    if (!room || parts === 0 || !canBoost(room)) return options;
    const [part, name] = SQUAD_BOOST_PARTS[effect];
    const table = (BOOSTS as unknown as Record<string, Record<string, Record<string, number>>>)[part] ?? {};
    for (const compound in table) {
        const multiplier = table[compound][name];
        if (multiplier === undefined || boostableParts(room, compound as ResourceConstant, false) < parts) continue;
        const cost = LAB_BOOST_MINERAL * energyPrice(compound as ResourceConstant) + LAB_BOOST_ENERGY;
        options.push({ compound, multiplier, cost, tier: tierOf(compound) });
    }
    return options;
}

/** A squad's numbers for boostNeed.ts: `bodies` front creep first, `healers` among them */
function shape(
    room: Room | undefined,
    type: SquadType,
    bodies: BodyPartConstant[][],
    healers: BodyPartConstant[][],
    soak: boolean
): SquadShape {
    const all = bodies.flat();
    const front = bodies[0];
    const parts = { heal: count(all, HEAL), tough: count(all, TOUGH), attack: count(all, ATTACK) };
    return {
        type,
        spawnCost: _.sum(all, p => BODYPART_COST[p]),
        heal: _.sum(healers, b => count(b, HEAL)) * HEAL_POWER,
        damage: count(front, ATTACK) * ATTACK_POWER,
        frontTough: count(front, TOUGH),
        frontOther: front.length - count(front, TOUGH),
        soak,
        parts,
        options: {
            heal: boostOptions(room, "heal", parts.heal),
            tough: boostOptions(room, "tough", parts.tough),
            attack: boostOptions(room, "attack", parts.attack)
        }
    };
}

/**
 * Squad type and boosts against a target (boostNeed.ts chooseSquad): the cheapest duo or quad, with
 * the fewest boosts from `boostRoom`'s stock, that holds against the threat with a margin; the
 * strongest boosts when none does. `Memory.military.boosts` ("auto", "max", "none") changes the rule;
 * `escalation` (floor and margin): after losses (military.ts).
 */
export function planSquad(
    targetRoom: string,
    energy: number,
    forced?: SquadType,
    refills = false,
    boostRoom?: Room,
    escalation: { floor?: SquadCompounds; margin?: number } = {}
): SquadPlan {
    const threat = threatOf(targetRoom);
    const shapes: SquadShape[] = [];
    if (forced !== "quad") {
        const duo = [duoAttackerBody(energy), duoHealerBody(energy)];
        shapes.push(shape(boostRoom, "duo", duo, [duo[1]], forced === "duo"));
    }
    if (forced !== "duo") {
        const healer = quadHealerBody(energy);
        const quad = [quadAttackerBody(energy), quadAttackerBody(energy), healer, healer];
        shapes.push(shape(boostRoom, "quad", quad, [healer, healer], forced === "quad"));
    }
    const choice = chooseSquad(shapes, threat, refills, {
        mode: militaryMemory().boosts,
        attrition: ATTRITION,
        floor: escalation.floor,
        margin: escalation.margin
    });
    return {
        type: choice.type,
        feasible: choice.feasible,
        heal: choice.heal,
        threat,
        compounds: choice.compounds,
        boostCost: choice.boostCost
    };
}

/** "heal XLHO2, tough -, attack -" (logs) */
export function describeBoosts(compounds: SquadCompounds): string {
    return (Object.keys(SQUAD_BOOST_PARTS) as BoostedEffect[]).map(e => `${e} ${compounds[e] ?? "-"}`).join(", ");
}
