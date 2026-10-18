/**
 * Mineral harvester: stands on the mineral container (else next to the mineral), harvests whenever the
 * extractor is ready, fills the container; transporters bring the minerals to storage or terminal.
 * Recycled once the mineral is empty. Ported from Hivemind (MIT), src/role/harvester.ts (creeps with
 * `fixedMineralSource`). Not in Hivemind: a role of its own, no planned harvest position (the
 * container next to the mineral is the spot), no harvest call while the extractor cools down.
 */

import { whenInRange } from "../core/movement";
import { creepsByRole, mineralContainer } from "../core/roomState";
import { countStat } from "../utils/stats";
import { registerRole } from "./registry";
import { performRecycle } from "./recycle";
import { performDeliver } from "./transporter";

declare global {
    interface CreepMemory {
        fixedMineralSource?: Id<Mineral>;
    }
}

export function runMineralHarvester(creep: Creep): void {
    const mineral = Game.getObjectById(creep.memory.fixedMineralSource!);
    if (!mineral || mineral.mineralAmount <= 0) {
        performRecycle(creep);
        return;
    }

    // No transporter: carry the minerals home like one
    if (creep.store.getFreeCapacity() === 0 && creepsByRole(creep.memory.room ?? creep.room.name, "transporter").length === 0) {
        performDeliver(creep);
        return;
    }

    const container = mineralContainer(mineral);
    let target = mineral.pos;
    let range = 1;
    if (container && !container.pos.lookFor(LOOK_CREEPS).some(c => c !== creep)) {
        target = container.pos;
        range = 0;
    }

    whenInRange(creep, range, target, () => {
        const extractor = mineral.pos.lookFor(LOOK_STRUCTURES).find(s => s.structureType === STRUCTURE_EXTRACTOR) as StructureExtractor | undefined;
        if (extractor && extractor.cooldown === 0 && creep.harvest(mineral) === OK) {
            countStat("work:mineral", creep.getActiveBodyparts(WORK) * HARVEST_MINERAL_POWER);
        }
        depositResources(creep, container);
    });
}

/** Into the container when nearly full (standing on it, the overflow drops into it anyway) */
function depositResources(creep: Creep, container: StructureContainer | null): void {
    if (creep.store.getFreeCapacity() >= creep.getActiveBodyparts(WORK) * HARVEST_MINERAL_POWER) return;
    if (!container || container.store.getFreeCapacity() === 0 || creep.pos.isEqualTo(container.pos)) return;
    if (!creep.pos.isNearTo(container)) return;
    for (const resourceType in creep.store) {
        creep.transfer(container, resourceType as ResourceConstant);
        return;
    }
}

registerRole("mineralHarvester", runMineralHarvester);
