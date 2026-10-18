/**
 * Upgrader: upgrades the controller, refilling from the controller link, else the controller
 * container, while working.
 * Ported from Hivemind (MIT), src/role/upgrader.ts.
 */

import { whenInRange } from "../core/movement";
import { controllerContainer, controllerLink, creepsByRole, creepsWithOrder } from "../core/roomState";
import { roomPlanner } from "../planner/RoomPlanner";
import { countStat } from "../utils/stats";
import { registerRole } from "./registry";
import { performGetEnergy } from "./transporter";

/** Heap only: RCL when the upgrader was first seen */
const seenAtRcl: Map<string, number> = new Map();

export function runUpgrader(creep: Creep): void {
    const room = creep.room;
    const rcl = room.controller?.level ?? 0;
    const firstRcl = seenAtRcl.get(creep.name);
    if (firstRcl === undefined) {
        seenAtRcl.set(creep.name, rcl);
    } else if (firstRcl !== rcl && rcl < 5 && room.find(FIND_MY_CONSTRUCTION_SITES).length > 0) {
        // Level up with new construction: become a builder for good
        delete creep.memory.upgrading;
        creep.memory.role = "builder";
        seenAtRcl.delete(creep.name);
        return;
    }

    const container = controllerContainer(room);
    const link = controllerLink(room);
    if (creep.memory.upgrading && creep.store.energy === 0) creep.memory.upgrading = false;
    if (!creep.memory.upgrading && (creep.store.getFreeCapacity() === 0 || (creep.store.energy > 0 && (container || link)))) {
        creep.memory.upgrading = true;
    }

    if (creep.memory.upgrading) performUpgrade(creep, container, link);
    else getUpgraderEnergy(creep, container, link);
}

function performUpgrade(creep: Creep, container: StructureContainer | null, link: StructureLink | null): void {
    const controller = creep.room.controller;
    if (!controller) return;
    const isOnlyUpgrader = creepsByRole(creep.memory.room ?? creep.room.name, "upgrader").length === 1;
    if (isOnlyUpgrader && creep.pos.getRangeTo(controller) > 3) {
        const spot = roomPlanner.getPlan(creep.room.name)?.getLocations("upgrader.0")[0];
        whenInRange(creep, 0, spot ?? controller.pos);
    } else {
        whenInRange(creep, 3, controller, () => creep.upgradeController(controller) === OK && countStat("work:upgrade"));
    }

    // Keep refilling at the link, else the container, while upgrading
    if (creep.store.energy < creep.getActiveBodyparts(WORK) * 2) {
        if (link && link.store.energy > 50 && creep.pos.isNearTo(link) && creep.withdraw(link, RESOURCE_ENERGY) === OK) return;
        if (container && container.store.energy > 50 && creep.pos.isNearTo(container)) creep.withdraw(container, RESOURCE_ENERGY);
    }
}

function getUpgraderEnergy(creep: Creep, container: StructureContainer | null, link: StructureLink | null): void {
    const room = creep.room;
    const controller = room.controller!;
    if (link && link.store.energy > 50) {
        whenInRange(creep, 1, link, () => creep.withdraw(link, RESOURCE_ENERGY));
        return;
    }
    if (container && container.store.energy > 50) {
        whenInRange(creep, 1, container, () => creep.withdraw(container, RESOURCE_ENERGY));
        return;
    }

    const radius = (controller.level ?? 0) < 4 ? 10 : 3;
    const pile = controller.pos
        .findInRange(FIND_DROPPED_RESOURCES, radius)
        .find(r => r.resourceType === RESOURCE_ENERGY && r.amount >= creep.store.getCapacity());
    if (pile) {
        whenInRange(creep, 1, pile, () => creep.pickup(pile));
        return;
    }

    const other = controller.pos
        .findInRange(FIND_STRUCTURES, radius)
        .find(
            s => s.structureType === STRUCTURE_CONTAINER && s.id !== container?.id && (s as StructureContainer).store.energy > CONTAINER_CAPACITY / 4
        ) as StructureContainer | undefined;
    if (other) {
        whenInRange(creep, 1, other, () => creep.withdraw(other, RESOURCE_ENERGY));
        return;
    }

    if (creep.store.energy > 0) creep.memory.upgrading = true;

    const deliverer = creepsWithOrder(room, "workerCreep", creep.id)[0];
    if (deliverer) {
        whenInRange(creep, 1, deliverer);
        return;
    }

    if (!container && !link) performGetEnergy(creep);
    else whenInRange(creep, 3, controller);
}

registerRole("upgrader", runUpgrader);
