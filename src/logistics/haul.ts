/**
 * Haul behaviour: take energy from an offer, deliver it to a need, through logistics reservations.
 * Run by TRANSPORT creeps, and by workers while the spawn/extensions lack energy.
 */

import { trafficManager } from "../modules/TrafficManager";
import { countStat } from "../utils/stats";
import { logistics } from "./LogisticsNetwork";

/**
 * One haul step. `maxPriority` limits deliveries to important needs (workers: spawn/extensions).
 * Returns false when there is nothing to do (no reservation and nothing to claim).
 */
export function runHaul(creep: Creep, opts: { maxPriority?: number } = {}): boolean {
    if (!creep.memory.logistics && !claim(creep, opts)) return false;

    const reservation = creep.memory.logistics!;
    const target = logistics.getTarget(creep);
    if (!target) return true; // gone: reservation released, claim again next tick

    trafficManager.requestMove(creep, target.pos, { range: 1, priority: reservation.kind === "need" ? 10 : 30 });
    if (!creep.pos.isNearTo(target)) return true;

    if (reservation.kind === "offer") {
        if (target instanceof Resource) creep.pickup(target);
        else creep.withdraw(target as AnyStoreStructure, RESOURCE_ENERGY);
    } else {
        const amount = Math.min(reservation.amount, creep.store.getUsedCapacity(RESOURCE_ENERGY));
        if (creep.transfer(target as AnyStoreStructure, RESOURCE_ENERGY, amount) === OK) {
            countStat("logistics:delivered", amount);
        }
    }
    logistics.release(creep);
    return true;
}

/** Carrying energy: deliver (or top up when nothing needs it). Empty: fetch. */
function claim(creep: Creep, opts: { maxPriority?: number }): boolean {
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        if (logistics.claimNeed(creep, opts)) return true;
        return creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0 && opts.maxPriority === undefined &&
            !!logistics.claimOffer(creep);
    }
    return !!logistics.claimOffer(creep);
}
