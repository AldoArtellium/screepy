/**
 * Helper: fills the boost labs with their compound and energy, empties boost labs holding another
 * mineral, parks on the planned helper spot otherwise. Reaction labs are served by the transporters
 * (dispatcher `lab` source and destination). Ported from Hivemind (MIT), src/role/helper.ts.
 */

import { whenInRange } from "../core/movement";
import { bestStorageSource, bestStorageTarget } from "../core/resources";
import { boostLabs, labNeeds } from "../labs/boosts";
import { roomPlanner } from "../planner/RoomPlanner";
import { registerRole } from "./registry";

export const HELPER = "helper";

function park(creep: Creep): void {
    const spot = roomPlanner.getPlan(creep.room.name)?.getLocations("helper_parking")[0];
    if (spot) whenInRange(creep, 1, spot);
}

/** Store whatever is carried (Hivemind: storage if it has room, else terminal) */
function storeAll(creep: Creep): void {
    for (const key in creep.store) {
        const resourceType = key as ResourceConstant;
        const target = bestStorageTarget(creep.room, creep.store[resourceType], resourceType);
        if (!target) return;
        whenInRange(creep, 1, target, () => creep.transfer(target, resourceType));
        return;
    }
}

/** Hivemind performHelperCleanup: a boost lab holding another mineral is emptied first */
function cleanup(creep: Creep): boolean {
    for (const lab of boostLabs(creep.room)) {
        const needs = labNeeds(lab);
        if (!lab.mineralType || !needs || lab.mineralType === needs.compound) continue;
        if (creep.memory.delivering) storeAll(creep);
        else whenInRange(creep, 1, lab, () => creep.withdraw(lab, lab.mineralType!));
        return true;
    }
    return false;
}

/** Hivemind performHelperLabDeliver: compound, then energy, up to what the boost requests need */
function deliverToLabs(creep: Creep): boolean {
    for (const lab of boostLabs(creep.room)) {
        const needs = labNeeds(lab);
        if (!needs) continue;
        const { compound } = needs;
        if (creep.store[compound] > 0) {
            const amount = Math.min(needs.amount - (lab.store[compound] ?? 0), creep.store[compound], lab.store.getFreeCapacity(compound) ?? 0);
            if (amount > 0) {
                whenInRange(creep, 1, lab, () => creep.transfer(lab, compound, amount));
                return true;
            }
        }
        if (creep.store.energy > 0) {
            const amount = Math.min(needs.energy - lab.store.energy, creep.store.energy, lab.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0);
            if (amount > 0) {
                whenInRange(creep, 1, lab, () => creep.transfer(lab, RESOURCE_ENERGY, amount));
                return true;
            }
        }
    }
    return false;
}

/** Hivemind performHelperLabGather + energy gathering */
function gather(creep: Creep): void {
    const room = creep.room;
    const labs = boostLabs(room);
    for (const lab of labs) {
        const needs = labNeeds(lab);
        if (!needs) continue;
        const { compound } = needs;
        const missing = needs.amount - creep.store[compound] - (lab.mineralType === compound ? lab.store[compound] ?? 0 : 0);
        if (missing <= 0) continue;
        const source = bestStorageSource(room, compound);
        if (!source) continue;
        const amount = Math.min(
            missing,
            creep.store.getFreeCapacity(compound),
            source.store[compound] ?? 0,
            (lab.store.getFreeCapacity(compound) ?? LAB_MINERAL_CAPACITY) - creep.store[compound]
        );
        if (amount > 0) {
            whenInRange(creep, 1, source, () => creep.withdraw(source, compound, amount));
            return;
        }
    }
    const energyNeeded = _.sum(labs, lab => {
        const needs = labNeeds(lab);
        return needs ? Math.max(0, Math.min(lab.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0, needs.energy - lab.store.energy)) : 0;
    });
    const source = bestStorageSource(room, RESOURCE_ENERGY);
    if (source) {
        const amount = Math.min(energyNeeded - creep.store.energy, creep.store.getFreeCapacity(RESOURCE_ENERGY), source.store.energy);
        if (amount > 0) {
            whenInRange(creep, 1, source, () => creep.withdraw(source, RESOURCE_ENERGY, amount));
            return;
        }
    }
    // Nothing left to gather: deliver what we have, else park
    if (creep.store.getUsedCapacity() > 0) {
        creep.memory.delivering = true;
        return;
    }
    park(creep);
}

export function runHelper(creep: Creep): void {
    if (creep.memory.delivering && creep.store.getUsedCapacity() === 0) creep.memory.delivering = false;
    else if (!creep.memory.delivering && creep.store.getFreeCapacity() === 0) creep.memory.delivering = true;

    if (cleanup(creep)) return;
    if (creep.memory.delivering) {
        if (!deliverToLabs(creep)) storeAll(creep);
        return;
    }
    gather(creep);
}

registerRole(HELPER, runHelper);
