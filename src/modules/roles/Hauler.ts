import {
    clearTargetCache,
    ENERGY_THRESHOLDS,
    findEnergySource,
    findEnergyTarget,
    idleNearSpawn,
    isCacheValid,
    REUSE_PATH
} from "../../utils/creepUtils";
import { findStructuresNeedingEnergy } from "../../utils/roomUtils";

/**
 * Hauler role - Energy transport
 * Task-driven role: primarily works from task queue, idle when no tasks
 *
 * This is fallback behavior only - should rarely execute since
 * TaskDispatcher assigns FILL_SPAWN, FILL_EXTENSION, FILL_TOWER tasks.
 */
class Hauler {
    static run(creep: Creep) {
        // Simple state based on capacity (using standardized states)
        if (creep.store.getUsedCapacity() === 0) {
            creep.memory.state = "acquiring";
            clearTargetCache(creep);
        } else if (creep.store.getFreeCapacity() === 0) {
            creep.memory.state = "executing";
            clearTargetCache(creep);
        }

        if (creep.memory.state === "executing" || creep.store.getFreeCapacity() === 0) {
            this.deliverEnergy(creep);
        } else {
            this.collectEnergy(creep);
        }
    }

    private static collectEnergy(creep: Creep) {
        const room = creep.room;
        const phase = room.memory.phase ?? 0;

        // Check cached target first
        if (creep.memory.targetId && isCacheValid(creep)) {
            type CollectTarget = StructureContainer | StructureStorage | Resource;
            const cachedTarget = Game.getObjectById(creep.memory.targetId as Id<CollectTarget>);

            if (cachedTarget) {
                if ("store" in cachedTarget &&
                    cachedTarget.store.getUsedCapacity(RESOURCE_ENERGY) > ENERGY_THRESHOLDS.CONTAINER_MIN) {
                    this.withdrawFrom(creep, cachedTarget);
                    return;
                } else if ("resourceType" in cachedTarget) {
                    this.pickupFrom(creep, cachedTarget);
                    return;
                }
            }
            clearTargetCache(creep);
        }

        // Find energy source (containers, dropped resources)
        const target = findEnergySource(creep, {
            includeStorage: false, // Don't pull from storage for general collection
            includeSources: false
        });

        if (target) {
            creep.memory.targetId = target.id;
            creep.memory.targetTick = Game.time;

            if ("resourceType" in target) {
                this.pickupFrom(creep, target);
            } else if ("store" in target) {
                this.withdrawFrom(creep, target as StructureContainer);
            }
            return;
        }

        // Phase 4+: Pull from storage if structures need energy
        if (phase >= 4 && room.storage) {
            const storageEnergy = room.storage.store.getUsedCapacity(RESOURCE_ENERGY);
            const needsEnergy = findStructuresNeedingEnergy(room);

            if (storageEnergy > ENERGY_THRESHOLDS.STORAGE_PULL && needsEnergy.length > 0) {
                creep.memory.targetId = room.storage.id;
                creep.memory.targetTick = Game.time;
                this.withdrawFrom(creep, room.storage);
                return;
            }
        }

        // Nothing to collect, idle
        idleNearSpawn(creep);
    }

    private static deliverEnergy(creep: Creep) {
        // Check cached target first
        if (creep.memory.targetId && isCacheValid(creep)) {
            type DeliverTarget = StructureSpawn | StructureExtension | StructureTower | StructureStorage;
            const cachedTarget = Game.getObjectById(creep.memory.targetId as Id<DeliverTarget>);

            if (cachedTarget && "store" in cachedTarget &&
                cachedTarget.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                this.transferTo(creep, cachedTarget);
                return;
            }
            clearTargetCache(creep);
        }

        // Use shared finder - it handles defense mode priorities
        const target = findEnergyTarget(creep);

        if (target) {
            creep.memory.targetId = target.id;
            creep.memory.targetTick = Game.time;
            this.transferTo(creep, target);
            return;
        }

        // No delivery targets, idle
        idleNearSpawn(creep);
    }

    private static withdrawFrom(creep: Creep, target: StructureContainer | StructureStorage) {
        if (creep.pos.isNearTo(target)) {
            creep.withdraw(target, RESOURCE_ENERGY);
        } else {
            creep.moveTo(target, { reusePath: REUSE_PATH });
        }
    }

    private static pickupFrom(creep: Creep, target: Resource) {
        if (creep.pos.isNearTo(target)) {
            creep.pickup(target);
        } else {
            creep.moveTo(target, { reusePath: REUSE_PATH });
        }
    }

    private static transferTo(creep: Creep, target: Structure) {
        if (creep.pos.isNearTo(target)) {
            creep.transfer(target, RESOURCE_ENERGY);
        } else {
            const pathColor = this.getPathColor(target);
            creep.moveTo(target, { reusePath: REUSE_PATH, visualizePathStyle: { stroke: pathColor } });
        }
    }

    private static getPathColor(target: Structure): string {
        switch (target.structureType) {
            case STRUCTURE_TOWER: return "#ff0000";
            case STRUCTURE_STORAGE: return "#00ff00";
            default: return "#ffffff";
        }
    }
}

export default Hauler;
