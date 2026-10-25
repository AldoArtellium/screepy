/**
 * Guardian: holds the planned rampart closest to the hostiles and hits whatever is in range from
 * there (melee or ranged), focusing the military target.
 * Ported from Hivemind (MIT), src/role/guardian.ts (no alternate positions in our traffic manager).
 */

import { stayInPlace, whenInRange } from "../core/movement";
import { hostileCreeps, isDangerous, militarySituation } from "../defense/RoomDefense";
import { threatOf } from "../defense/threat";
import { roomPlanner } from "../planner/RoomPlanner";
import { registerRole } from "./registry";

export const GUARDIAN = "guardian";

export function runGuardian(creep: Creep): void {
    const rampart = bestRampartToCover(creep);
    if (rampart) whenInRange(creep, 0, rampart);
    else stayInPlace(creep);
    attackTargetsInRange(creep);
}

/**
 * Free main rampart closest to a hostile, preferring the ones near the guardian and the most threatening
 * hostiles (defense/threat.ts; not in Hivemind: shard0 W28N7, 2026-10-24, 1-WORK decoys drew the
 * guardian away while two 8-WORK dismantlers broke a rampart 6 tiles off)
 */
function bestRampartToCover(creep: Creep): StructureRampart | null {
    const plan = roomPlanner.getPlan(creep.room.name);
    if (!plan) return null;
    const enemies = hostileCreeps(creep.room).filter(isDangerous);
    if (enemies.length === 0) return null;
    const ramparts = (creep.room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_RAMPART }) as StructureRampart[]).filter(
        r => {
            if (!plan.has(r.pos, "rampart") || plan.has(r.pos, "rampart.ramp")) return false;
            const occupant = r.pos.lookFor(LOOK_CREEPS)[0];
            return !occupant || occupant.id === creep.id;
        }
    );
    if (ramparts.length === 0) return null;
    let best: { rampart: StructureRampart; score: number } | null = null;
    for (const enemy of enemies) {
        const closest = _.min(ramparts, r => r.pos.getRangeTo(enemy));
        if (typeof closest === "number") continue;
        const threat = Math.max(threatOf(enemy), 1);
        const score = (closest.pos.getRangeTo(creep) / 2 + closest.pos.getRangeTo(enemy) + 1) / threat;
        if (!best || score < best.score) best = { rampart: closest, score };
    }
    return best?.rampart ?? null;
}

function priorityOf(creep: Creep): number {
    return militarySituation(creep.room).targets.find(t => t.creep.id === creep.id)?.priority ?? 0;
}

function attackTargetsInRange(creep: Creep): void {
    if (creep.getActiveBodyparts(RANGED_ATTACK) > 0) {
        const targets = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 3, { filter: isDangerous });
        if (targets.length > 0) {
            const best = _.max(targets, priorityOf);
            if (priorityOf(best) > 0) creep.rangedAttack(best);
            else if (targets.length > 2 || targets.some(t => t.pos.getRangeTo(creep) === 1)) creep.rangedMassAttack();
            else creep.rangedAttack(_.sample(targets)!);
        }
    }
    if (creep.getActiveBodyparts(ATTACK) > 0) {
        const targets = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1, { filter: isDangerous });
        if (targets.length === 0) return;
        const best = _.max(targets, priorityOf);
        creep.attack(priorityOf(best) > 0 ? best : _.sample(targets)!);
    }
}

registerRole(GUARDIAN, runGuardian);
