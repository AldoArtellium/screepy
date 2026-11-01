/**
 * Power harvester: an attacker or, with `memory.isHealer`, a healer of the power bank in
 * `Memory.powerMining`. Walks the squad route to the bank room; the attacker hits an adjacent hostile
 * first, else the bank while it keeps 70% of its hits (the bank hits back half the damage); the healer
 * heals the most damaged power harvester. Once the bank is gone it waits off the power piles, and dies
 * where it stands when the operation is over (a trip home costs more than it gives back).
 * Ported from Hivemind (MIT), src/role/harvester.power.ts.
 */

import { whenInRange } from "../core/movement";
import { POWER_HARVESTER } from "../highway/PowerMining";
import { travelTo } from "../highway/travel";
import { registerRole } from "./registry";

function attackNearby(creep: Creep): boolean {
    const targets = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1);
    if (targets.length === 0) return false;
    const target = _.max(
        targets,
        c => c.getActiveBodyparts(ATTACK) + c.getActiveBodyparts(RANGED_ATTACK) + 2 * c.getActiveBodyparts(HEAL)
    );
    return creep.attack(target) === OK;
}

function heal(creep: Creep, bank: StructurePowerBank): void {
    const damaged = creep.room.find(FIND_MY_CREEPS, {
        filter: c => c.memory.role === POWER_HARVESTER && c.hits < c.hitsMax
    });
    if (damaged.length === 0) {
        whenInRange(creep, 2, bank);
        return;
    }
    const target = _.min(damaged, c => c.hits / c.hitsMax);
    whenInRange(creep, 1, target);
    if (creep.pos.isNearTo(target)) creep.heal(target);
    else if (creep.pos.inRangeTo(target, 3)) creep.rangedHeal(target);
}

export function runPowerHarvester(creep: Creep): void {
    const op = Memory.powerMining;
    if (!op || op.id !== creep.memory.powerBank) {
        creep.suicide();
        return;
    }
    if (!creep.memory.isHealer && attackNearby(creep)) return;
    if (travelTo(creep, op.room)) return;

    const bank = Game.getObjectById(op.id as Id<StructurePowerBank>);
    if (bank) {
        if (creep.memory.isHealer) heal(creep, bank);
        else {
            whenInRange(creep, 1, bank, () => {
                if (creep.hits >= creep.hitsMax * 0.7) creep.attack(bank);
            });
        }
        return;
    }
    // Bank cracked: stay out of the haulers' way until the operation ends
    whenInRange(creep, 5, new RoomPosition(25, 25, op.room));
}

registerRole(POWER_HARVESTER, runPowerHarvester);
