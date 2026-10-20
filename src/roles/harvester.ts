/**
 * Harvester: bound to one source. Stationary on its planned harvest position (the source container)
 * as soon as the room has a transporter; delivers like a transporter before that. Fills its source
 * link before the container (RCL 5+).
 * Ported from Hivemind (MIT), src/role/harvester.ts.
 */

import { whenInRange } from "../core/movement";
import { clearOrder, creepsByRole, roomBays, sourceContainer, sourceLink, structuresOfType } from "../core/roomState";
import { roomPlanner } from "../planner/RoomPlanner";
import { countStat } from "../utils/stats";
import { registerRole } from "./registry";
import { performDeliver } from "./transporter";

declare global {
    interface CreepMemory {
        harvesting?: boolean;
        fixedSource?: Id<Source>;
        /** Planned harvest position, x + 50 * y */
        harvestPos?: number;
        noHarvestPos?: boolean;
    }
}

const DEPOSIT_ROLES = ["transporter", "upgrader", "builder"];

function isStationary(creep: Creep): boolean {
    return creepsByRole(creep.memory.room ?? creep.room.name, "transporter").length > 0;
}

export function runHarvester(creep: Creep): void {
    if (!creep.memory.harvesting && creep.store.getUsedCapacity() === 0) {
        setHarvesting(creep, true);
    } else if (creep.memory.harvesting && creep.store.getFreeCapacity() === 0 && !isStationary(creep)) {
        setHarvesting(creep, false);
    }

    if (creep.memory.harvesting) performHarvest(creep);
    else deliver(creep);
}

function setHarvesting(creep: Creep, harvesting: boolean): void {
    creep.memory.harvesting = harvesting;
    clearOrder(creep);
}

function harvestPosition(creep: Creep, source: Source): RoomPosition | null {
    if (creep.memory.harvestPos === undefined && !creep.memory.noHarvestPos) {
        const plan = roomPlanner.getPlan(source.room.name);
        if (plan) {
            const pos = _.sample(plan.getLocations(`harvester.${source.id}`));
            if (pos) creep.memory.harvestPos = pos.x + 50 * pos.y;
            else creep.memory.noHarvestPos = true;
        }
    }
    if (creep.memory.harvestPos === undefined) return null;
    return new RoomPosition(creep.memory.harvestPos % 50, Math.floor(creep.memory.harvestPos / 50), source.room.name);
}

function performHarvest(creep: Creep): void {
    const source = Game.getObjectById(creep.memory.fixedSource!);
    if (!source) return;

    let target = source.pos;
    let range = 1;
    const harvestPos = harvestPosition(creep, source);
    // On its spot no other creep can hold it: skip the look
    if (harvestPos && (creep.pos.isEqualTo(harvestPos) || !harvestPos.lookFor(LOOK_CREEPS).some(c => c !== creep))) {
        target = harvestPos;
        range = 0;
    }
    const container = sourceContainer(source);
    if (container && container.pos.getRangeTo(target) > 1 && creep.store.getFreeCapacity() < creep.getActiveBodyparts(WORK) * HARVEST_POWER) {
        target = container.pos;
        range = 1;
    }

    const arrived = whenInRange(creep, range, target, () => {
        // An empty source would only fail the call (Overmind miner: harvest only with energy left)
        if (source.energy > 0 && creep.harvest(source) === OK) countStat("work:harvest", creep.getActiveBodyparts(WORK));
        if (depositInBay(creep)) return;
        depositResources(creep, source);
    });
    if (!arrived) countStat("harvester:walking");
}

/** On a harvester bay: fill its extensions/spawn, refuel from the pile or container below */
function depositInBay(creep: Creep): boolean {
    if (creep.memory.harvestPos === undefined) return false;
    const bay = roomBays(creep.room).find(b => b.pos.isEqualTo(creep.pos));
    if (!bay) return false;
    if (creep.store.getUsedCapacity() >= creep.store.getCapacity() * (bay.needsRefill() ? 0.6 : 1)) bay.refillFrom(creep);
    if (bay.needsRefill()) pickupEnergy(creep);
    return bay.energyCapacity > 0;
}

function pickupEnergy(creep: Creep): void {
    const pile = creep.pos.lookFor(LOOK_RESOURCES).find(r => r.resourceType === RESOURCE_ENERGY);
    if (pile) {
        creep.pickup(pile);
        return;
    }
    const container = creep.pos
        .lookFor(LOOK_STRUCTURES)
        .find(s => s.structureType === STRUCTURE_CONTAINER) as StructureContainer | undefined;
    if (container && container.store.energy > 0) creep.withdraw(container, RESOURCE_ENERGY);
}

function depositResources(creep: Creep, source: Source): void {
    const work = creep.getActiveBodyparts(WORK);
    if (creep.store.getFreeCapacity() >= work * HARVEST_POWER) return;

    const container = sourceContainer(source);
    // Build our own container when no builder has room for energy
    if (
        !container &&
        creep.store.energy > Math.max(work * BUILD_POWER, creep.store.getCapacity() - work * HARVEST_POWER) &&
        !creepsByRole(creep.room.name, "builder").some(c => c.store.getFreeCapacity() > 20)
    ) {
        const site = source.pos
            .findInRange(FIND_CONSTRUCTION_SITES, 3)
            .find(s => s.structureType === STRUCTURE_CONTAINER);
        if (site) {
            whenInRange(creep, 3, site, () => creep.build(site));
            return;
        }
    }

    // The source link (else another link within 3 of the source) beats the container while it has room
    let target: StructureContainer | StructureLink | null = container && container.store.getFreeCapacity() > 0 ? container : null;
    if (creep.store.energy > 0) {
        const link = sourceLink(source);
        if (link && link.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            target = link;
        } else {
            const other = structuresOfType<StructureLink>(creep.room, STRUCTURE_LINK).find(
                l => l.my && l.store.getFreeCapacity(RESOURCE_ENERGY) > 0 && l.pos.inRangeTo(source, 3)
            );
            if (other) target = other;
        }
    }
    const depositTarget = target;
    if (depositTarget && !(depositTarget.structureType === STRUCTURE_CONTAINER && creep.pos.isEqualTo(depositTarget.pos))) {
        whenInRange(creep, 1, depositTarget, () => creep.transfer(depositTarget, RESOURCE_ENERGY));
    }

    // Hand energy to adjacent workers (RCL < 6)
    if ((creep.room.controller?.level ?? 0) < 6 && creep.store.energy > 0) {
        const near = creep.pos.findInRange(FIND_MY_CREEPS, 1, {
            filter: c => DEPOSIT_ROLES.includes(c.memory.role ?? "") && c.store.getFreeCapacity() > 0
        });
        if (near.length > 0) {
            const target = _.sample(near);
            creep.transfer(target, RESOURCE_ENERGY, Math.min(creep.store.energy, target.store.getFreeCapacity()));
        }
    }
}

/** No transporter yet: deliver like one */
function deliver(creep: Creep): void {
    if (!isStationary(creep)) {
        countStat("harvester:delivering");
        performDeliver(creep);
        return;
    }
    setHarvesting(creep, true);
}

registerRole("harvester", runHarvester);
