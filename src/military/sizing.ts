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
import { hostileRoom } from "./intel";

export type SquadType = "duo" | "quad";

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

/** Ticks the front creep must last at the room edge for a squad to be worth sending */
const SURVIVE_TICKS = 20;
/**
 * Towers that refill (strongholds: the core refills an empty tower, 1% a tick at level 1) can't be
 * drained for good: the front creep must last this long at close range (the walk out under fire)
 */
const SURVIVE_CLOSE_TICKS = 10;

export interface SquadPlan {
    type: SquadType;
    /** The front creep of the chosen squad lasts SURVIVE_TICKS at the edge */
    feasible: boolean;
    duoHeal: number;
    quadHeal: number;
    threat: Threat;
}

/** Duo when its healer covers the edge damage and its attacker beats the enemy healing, else quad */
export function planSquad(targetRoom: string, energy: number, forced?: SquadType, refills = false): SquadPlan {
    const threat = threatOf(targetRoom);
    const duoHeal = count(duoHealerBody(energy), HEAL) * HEAL_POWER;
    const duoDamage = count(duoAttackerBody(energy), ATTACK) * ATTACK_POWER;
    const healer = quadHealerBody(energy);
    const quadHeal = 2 * count(healer, HEAL) * HEAL_POWER;
    // Towers that refill must be out-healed where the squad fights, not only at the edge
    const damage = refills ? threat.close : threat.edge;
    const type: SquadType = forced ?? (duoHeal >= damage && duoDamage >= threat.minDamage ? "duo" : "quad");
    const heal = type === "duo" ? duoHeal : quadHeal;
    const frontHits = (type === "duo" ? duoAttackerBody(energy) : quadAttackerBody(energy)).length * 100;
    const feasible = refills
        ? heal >= threat.close || frontHits >= (threat.close - heal) * SURVIVE_CLOSE_TICKS
        : heal >= threat.edge || frontHits >= (threat.edge - heal) * SURVIVE_TICKS;
    return { type, feasible, duoHeal, quadHeal, threat };
}
