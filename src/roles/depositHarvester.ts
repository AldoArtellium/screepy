/**
 * Deposit harvester: walks the squad route (military/route.ts: no other player's room, no keeper room)
 * to the deposit of `Memory.depositMining`, harvests until full, carries it home to the storage or
 * terminal, and goes again while its life allows a round trip. Flees military hostiles.
 * Ported from Hivemind (MIT), src/role/harvester.deposit.ts; recycles at home instead of suiciding.
 */

import { whenInRange } from "../core/movement";
import { DEPOSIT_HARVESTER } from "../highway/DepositMining";
import { deliverHome, travelTo } from "../highway/travel";
import { countStat } from "../utils/stats";
import { fleeIfThreatened } from "./flee";
import { performRecycle } from "./recycle";
import { registerRole } from "./registry";

export function runDepositHarvester(creep: Creep): void {
    const op = Memory.depositMining;
    const mine = op && op.id === creep.memory.deposit ? op : undefined;
    const home = creep.memory.room ?? op?.home ?? creep.room.name;
    const used = creep.store.getUsedCapacity();
    const ttl = creep.ticksToLive ?? CREEP_LIFE_TIME;

    if (creep.memory.delivering && used === 0) {
        // Hivemind: a round trip plus harvesting is not realistic with less than 2.5 trips of life
        if (!mine || ttl <= 2.5 * mine.travel) {
            performRecycle(creep);
            return;
        }
        creep.memory.delivering = false;
    } else if (!creep.memory.delivering) {
        const full = used >= creep.store.getCapacity() * 0.95;
        const late = ttl <= 1.1 * (mine?.travel ?? 0) + 10;
        if (used > 0 && (full || late || !mine)) creep.memory.delivering = true;
        else if (!mine) {
            performRecycle(creep);
            return;
        }
    }

    if (fleeIfThreatened(creep)) return;
    if (creep.memory.delivering || !mine) {
        deliverHome(creep, home, "deposit:delivered");
        return;
    }

    if (travelTo(creep, mine.room)) return;
    const deposit = Game.getObjectById(mine.id as Id<Deposit>);
    if (!deposit) {
        // Gone: DepositMining ends the operation on its next choice
        if (used > 0) creep.memory.delivering = true;
        return;
    }
    whenInRange(creep, 1, deposit, () => {
        if (deposit.cooldown === 0 && creep.harvest(deposit) === OK) {
            countStat("deposit:harvested", creep.getActiveBodyparts(WORK) * HARVEST_DEPOSIT_POWER);
        }
    });
}

registerRole(DEPOSIT_HARVESTER, runDepositHarvester);
