import {
    clearTargetCache,
    ENERGY_THRESHOLDS,
    findEnergySource,
    isCacheValid,
    REUSE_PATH,
    updateEnergyState
} from "../../utils/creepUtils";

/**
 * Upgrader role - Controller upgrading
 * Flexible role: accepts tasks when available, falls back to role behavior
 *
 * Phase-aware behavior:
 * - Phase 4+: Use storage as primary energy source
 * - Defense mode (severe): May pause upgrading to redirect energy
 */
class Upgrader {
    static run(creep: Creep) {
        // Use unified state management
        const state = updateEnergyState(creep);

        if (state === "acquiring") {
            if (creep.memory.state === "executing") {
                clearTargetCache(creep);
            }
            creep.memory.state = "acquiring";
            this.getEnergy(creep);
        } else {
            creep.memory.state = "executing";
            this.upgradeController(creep);
        }
    }

    private static getEnergy(creep: Creep) {
        const room = creep.room;
        const phase = room.memory.phase ?? 0;
        const minerCount = Memory.spawn?.currentCounts?.miner ?? 0;

        // Phase 4+: Use storage as primary source with higher threshold
        if (phase >= 4 && room.storage) {
            const storageEnergy = room.storage.store.getUsedCapacity(RESOURCE_ENERGY);
            if (storageEnergy > ENERGY_THRESHOLDS.STORAGE_DEFENSE) {
                if (creep.pos.isNearTo(room.storage)) {
                    creep.withdraw(room.storage, RESOURCE_ENERGY);
                } else {
                    creep.moveTo(room.storage, { reusePath: REUSE_PATH });
                }
                return;
            }
        }

        // With miners, use containers/dropped resources
        if (minerCount > 0) {
            // Check cached target first
            if (creep.memory.targetId && isCacheValid(creep)) {
                type EnergyTarget = StructureContainer | Resource;
                const cachedTarget = Game.getObjectById(creep.memory.targetId as Id<EnergyTarget>);

                if (cachedTarget) {
                    if ("store" in cachedTarget &&
                        cachedTarget.store.getUsedCapacity(RESOURCE_ENERGY) > ENERGY_THRESHOLDS.CONTAINER_MIN) {
                        this.withdrawFromContainer(creep, cachedTarget);
                        return;
                    } else if ("resourceType" in cachedTarget) {
                        this.pickupResource(creep, cachedTarget);
                        return;
                    }
                }
                clearTargetCache(creep);
            }

            // Find new energy source
            const target = findEnergySource(creep, {
                includeStorage: false,
                includeSources: false
            });

            if (target) {
                creep.memory.targetId = target.id;
                creep.memory.targetTick = Game.time;

                if ("resourceType" in target) {
                    this.pickupResource(creep, target);
                } else if ("store" in target) {
                    this.withdrawFromContainer(creep, target as StructureContainer);
                }
            }
        } else {
            // No miners, harvest directly from source
            const source = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE);
            if (source) {
                if (creep.pos.isNearTo(source)) {
                    creep.harvest(source);
                } else {
                    creep.moveTo(source, { reusePath: REUSE_PATH });
                }
            }
        }
    }

    private static withdrawFromContainer(creep: Creep, target: StructureContainer) {
        if (creep.pos.isNearTo(target)) {
            creep.withdraw(target, RESOURCE_ENERGY);
        } else {
            creep.moveTo(target, { reusePath: REUSE_PATH });
        }
    }

    private static pickupResource(creep: Creep, target: Resource) {
        if (creep.pos.isNearTo(target)) {
            creep.pickup(target);
        } else {
            creep.moveTo(target, { reusePath: REUSE_PATH });
        }
    }

    private static upgradeController(creep: Creep) {
        const controller = creep.room.controller;
        if (!controller) return;

        if (creep.pos.inRangeTo(controller, 3)) {
            creep.upgradeController(controller);
        } else {
            creep.moveTo(controller, { reusePath: REUSE_PATH });
        }
    }
}

export default Upgrader;
