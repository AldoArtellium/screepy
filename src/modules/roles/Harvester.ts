import {
    ENERGY_THRESHOLDS,
    findEnergySource,
    findEnergyTarget,
    idleNearSpawn,
    REUSE_PATH,
    updateEnergyState
} from "../../utils/creepUtils";

/**
 * Harvester role - Basic energy gathering
 * Flexible role: accepts tasks when available, falls back to role behavior
 *
 * Phase-aware behavior:
 * - Phase 0 (EMERGENCY): Harvest directly from sources
 * - Phase 1+ with miners: Pick up from containers/dropped resources only
 */
class Harvester {
    static run(creep: Creep) {
        const state = updateEnergyState(creep);

        if (state === "acquiring") {
            creep.memory.state = "acquiring";
            this.harvestEnergy(creep);
        } else {
            // Try to deliver - if no target, switch to acquiring
            const hasTarget = this.deliverEnergy(creep);
            if (hasTarget) {
                creep.memory.state = "executing";
            } else {
                creep.memory.state = "acquiring";
                this.harvestEnergy(creep);
            }
        }
    }

    private static harvestEnergy(creep: Creep) {
        const room = creep.room;
        const phase = room.memory.phase ?? 0;
        const minerCount = Memory.spawn?.currentCounts?.miner ?? 0;

        // In EMERGENCY phase (0) or when no miners exist, harvest directly from sources
        const includeSources = phase === 0 || minerCount === 0;

        const target = findEnergySource(creep, {
            includeSources,
            includeStorage: phase >= 4,
            storageMinEnergy: 1000
        });

        if (!target) {
            idleNearSpawn(creep);  // Truly idle only when no sources AND no delivery targets
            return;
        }

        this.moveToAndInteract(creep, target);
    }

    private static deliverEnergy(creep: Creep): boolean {
        const target = findEnergyTarget(creep);

        if (target) {
            if (creep.pos.isNearTo(target)) {
                creep.transfer(target, RESOURCE_ENERGY);
            } else {
                creep.moveTo(target, { reusePath: REUSE_PATH, visualizePathStyle: { stroke: "#ffaa00" } });
            }
            return true;
        }

        return false;
    }

    private static moveToAndInteract(creep: Creep, target: Structure | Resource | Source) {
        if (creep.pos.isNearTo(target)) {
            if ("resourceType" in target) {
                creep.pickup(target);
            } else if ("store" in target) {
                creep.withdraw(target as StructureContainer | StructureStorage, RESOURCE_ENERGY);
            } else if ("energy" in target) {
                creep.harvest(target as Source);
            }
        } else {
            creep.moveTo(target, { reusePath: REUSE_PATH, visualizePathStyle: { stroke: "#ffaa00" } });
        }
    }
}

export default Harvester;
