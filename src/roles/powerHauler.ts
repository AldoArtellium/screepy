/**
 * Power hauler: walks the squad route to the power bank of `Memory.powerMining`, waits near it (next to
 * it once it is about to break), picks up the power piles and ruins, carries the power home to the
 * storage or terminal, then recycles.
 * Ported from Hivemind (MIT), src/role/hauler.power.ts.
 */

import { whenInRange } from "../core/movement";
import { POWER_HAULER } from "../highway/PowerMining";
import { deliverHome, travelTo } from "../highway/travel";
import { performRecycle } from "./recycle";
import { registerRole } from "./registry";

/** Hivemind: next to the bank once it has less than 5 full attackers' hits left */
const CLOSE_IN_HITS = ATTACK_POWER * MAX_CREEP_SIZE * 5;

/** Picks up power from a pile or a ruin of the room; false when there is none */
function pickUpPower(creep: Creep): boolean {
    const pile = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
        filter: r => r.resourceType === RESOURCE_POWER
    });
    if (pile) {
        whenInRange(creep, 1, pile, () => creep.pickup(pile));
        return true;
    }
    const ruin = creep.pos.findClosestByRange(FIND_RUINS, { filter: r => r.store[RESOURCE_POWER] > 0 });
    if (ruin) {
        whenInRange(creep, 1, ruin, () => creep.withdraw(ruin, RESOURCE_POWER));
        return true;
    }
    return false;
}

export function runPowerHauler(creep: Creep): void {
    const op = Memory.powerMining;
    const mine = op && op.id === creep.memory.powerBank ? op : undefined;
    const home = creep.memory.room ?? creep.room.name;
    const used = creep.store.getUsedCapacity();

    if (!creep.memory.delivering && (creep.store.getFreeCapacity() === 0 || (used > 0 && !mine))) {
        creep.memory.delivering = true;
    }
    if (creep.memory.delivering || !mine) {
        if (used === 0) performRecycle(creep);
        else deliverHome(creep, home, "power:delivered");
        return;
    }

    if (travelTo(creep, mine.room)) return;
    const bank = Game.getObjectById(mine.id as Id<StructurePowerBank>);
    if (bank) {
        whenInRange(creep, bank.hits < CLOSE_IN_HITS ? 1 : 4, bank);
        return;
    }
    if (pickUpPower(creep)) return;
    // Nothing left to pick up: home with what it carries
    if (used > 0) creep.memory.delivering = true;
    else performRecycle(creep);
}

registerRole(POWER_HAULER, runPowerHauler);
