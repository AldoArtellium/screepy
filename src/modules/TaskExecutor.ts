/**
 * TaskExecutor - Executes tasks for all creeps
 * Handles the actual work of moving to targets and performing actions
 */

import { TaskStatus, TaskType, requiresEnergy } from "../types/TaskTypes";
import { ENERGY_THRESHOLDS, REUSE_PATH } from "../utils/creepUtils";
import { log } from "../utils/logger";
import { taskDispatcher } from "./TaskDispatcher";

/** Maximum ticks a creep can be stuck before task is marked failed */
const MAX_STUCK_TICKS = 10;

/** Maximum ticks for a task before timeout */
const MAX_TASK_TICKS = 300;

class TaskExecutor {
    /**
     * Execute tasks for all creeps
     */
    executeTasks(): void {
        for (const name in Game.creeps) {
            const creep = Game.creeps[name];
            if (creep.spawning) continue;

            if (creep.memory.currentTask) {
                this.executeCreepTask(creep);
            } else {
                this.handleIdleCreep(creep);
            }
        }
    }

    /**
     * Execute a creep's current task
     */
    private executeCreepTask(creep: Creep): void {
        const taskState = creep.memory.currentTask;
        if (!taskState) return;

        const room = creep.room;
        const task = taskDispatcher.getTaskById(room, taskState.taskId);

        // Task no longer exists or completed
        if (!task || task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED) {
            this.clearCreepTask(creep);
            return;
        }

        // Check for task timeout
        if (Game.time - taskState.startedAt > MAX_TASK_TICKS) {
            log.debug("TaskExecutor", `Task ${task.type} timed out for ${creep.name}`);
            this.failTask(creep, task);
            return;
        }

        // Check for stuck creep
        if (this.isCreepStuck(creep, taskState)) {
            taskState.stuckTicks = (taskState.stuckTicks ?? 0) + 1;
            if (taskState.stuckTicks >= MAX_STUCK_TICKS) {
                log.debug("TaskExecutor", `Creep ${creep.name} stuck on task ${task.type}`);
                this.failTask(creep, task);
                return;
            }
        } else {
            taskState.stuckTicks = 0;
        }

        // Update last position for stuck detection
        taskState.lastPos = { x: creep.pos.x, y: creep.pos.y };

        // Update task status to in progress
        if (task.status === TaskStatus.ASSIGNED) {
            task.status = TaskStatus.IN_PROGRESS;
        }

        // Handle state transitions for energy-based tasks
        if (requiresEnergy(task.type)) {
            if (taskState.state === "acquiring" && creep.store.getFreeCapacity() === 0) {
                creep.memory.currentTask!.state = "executing";
            } else if (taskState.state === "executing" && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
                creep.memory.currentTask!.state = "acquiring";
            }
        }

        // Execute based on current state
        if (taskState.state === "acquiring") {
            this.acquireEnergy(creep);
        } else {
            this.executeTask(creep, task);
        }
    }

    /**
     * Check if creep is stuck (same position as last tick)
     */
    private isCreepStuck(creep: Creep, taskState: { lastPos?: { x: number; y: number } }): boolean {
        if (!taskState.lastPos) return false;
        return creep.pos.x === taskState.lastPos.x && creep.pos.y === taskState.lastPos.y;
    }

    /**
     * Mark a task as failed and clear creep assignment
     */
    private failTask(creep: Creep, task: { id: string; type: TaskType }): void {
        const taskState = creep.memory.currentTask;
        const retryCount = taskState?.retryCount ?? 0;

        // Allow up to 2 retries
        if (retryCount < 2) {
            log.debug("TaskExecutor", `Retrying task ${task.type} for ${creep.name} (attempt ${retryCount + 1})`);
            creep.memory.currentTask = {
                ...taskState!,
                stuckTicks: 0,
                retryCount: retryCount + 1,
                startedAt: Game.time
            };
            return;
        }

        log.warn("TaskExecutor", `Task ${task.type} failed for ${creep.name} after ${retryCount + 1} attempts`);
        taskDispatcher.updateTaskStatus(creep.room, task.id, TaskStatus.FAILED);
        delete creep.memory.currentTask;
    }

    /**
     * Acquire energy for a task
     */
    private acquireEnergy(creep: Creep): void {
        const room = creep.room;
        const phase = room.memory.phase ?? 0;

        // Priority: dropped (urgent) > container > storage > harvest
        // Try dropped resources first (they decay quickly)
        const dropped = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
            filter: r => r.resourceType === RESOURCE_ENERGY && r.amount > ENERGY_THRESHOLDS.DROPPED_MIN
        });

        if (dropped) {
            this.moveToAndPickup(creep, dropped);
            return;
        }

        // Try containers
        const container = creep.pos.findClosestByPath(FIND_STRUCTURES, {
            filter: (s): s is StructureContainer =>
                s.structureType === STRUCTURE_CONTAINER &&
                s.store.getUsedCapacity(RESOURCE_ENERGY) > ENERGY_THRESHOLDS.CONTAINER_MIN
        });

        if (container) {
            this.moveToAndWithdraw(creep, container);
            return;
        }

        // Try storage (phase 4+)
        if (phase >= 4 && room.storage) {
            if (room.storage.store.getUsedCapacity(RESOURCE_ENERGY) > ENERGY_THRESHOLDS.STORAGE_PULL) {
                this.moveToAndWithdraw(creep, room.storage);
                return;
            }
        }

        // Try tombstones and ruins
        const tombstone = creep.pos.findClosestByPath(FIND_TOMBSTONES, {
            filter: t => t.store.getUsedCapacity(RESOURCE_ENERGY) > 0
        });
        if (tombstone) {
            this.moveToAndWithdraw(creep, tombstone as unknown as StructureContainer);
            return;
        }

        const ruin = creep.pos.findClosestByPath(FIND_RUINS, {
            filter: r => r.store.getUsedCapacity(RESOURCE_ENERGY) > 0
        });
        if (ruin) {
            this.moveToAndWithdraw(creep, ruin as unknown as StructureContainer);
            return;
        }

        // Last resort: harvest directly (only if creep has WORK parts)
        if (creep.getActiveBodyparts(WORK) > 0) {
            const source = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE);
            if (source) {
                this.moveToAndHarvest(creep, source);
                return;
            }
        }

        // Nothing available - wait near spawn for energy to become available
        this.handleIdleCreep(creep);
    }

    /**
     * Execute the main task action
     */
    private executeTask(creep: Creep, task: { type: TaskType; targetId: string }): void {
        const target = Game.getObjectById(task.targetId as Id<any>);

        if (!target) {
            // Target gone - mark task complete
            this.completeTask(creep);
            return;
        }

        switch (task.type) {
            case TaskType.HARVEST_SOURCE:
                this.executeHarvest(creep, target as Source);
                break;

            case TaskType.FILL_SPAWN:
            case TaskType.FILL_EXTENSION:
            case TaskType.FILL_TOWER:
            case TaskType.FILL_STORAGE:
                this.executeDeliver(creep, target as StructureSpawn | StructureExtension | StructureTower | StructureStorage);
                break;

            case TaskType.PICKUP_RESOURCE:
                this.executePickup(creep, target as Resource);
                break;

            case TaskType.WITHDRAW_CONTAINER:
            case TaskType.WITHDRAW_STORAGE:
                this.executeWithdraw(creep, target as StructureContainer | StructureStorage);
                break;

            case TaskType.BUILD_STRUCTURE:
                this.executeBuild(creep, target as ConstructionSite);
                break;

            case TaskType.REPAIR_STRUCTURE:
            case TaskType.REPAIR_RAMPART:
            case TaskType.REPAIR_WALL:
                this.executeRepair(creep, target as Structure);
                break;

            case TaskType.UPGRADE_CONTROLLER:
                this.executeUpgrade(creep, target as StructureController);
                break;

            case TaskType.ATTACK_HOSTILE:
                this.executeAttack(creep, target as Creep);
                break;

            case TaskType.DEFEND_RAMPART:
                this.executeDefendRampart(creep, target as StructureRampart);
                break;

            default:
                log.warn("TaskExecutor", `Unknown task type: ${task.type}`);
                this.completeTask(creep);
        }
    }

    /**
     * Execute harvest task
     */
    private executeHarvest(creep: Creep, source: Source): void {
        // Check if source has a container
        const container = source.pos.findInRange(FIND_STRUCTURES, 1, {
            filter: (s): s is StructureContainer => s.structureType === STRUCTURE_CONTAINER
        })[0];

        // Check for container construction site
        const containerSite = source.pos.findInRange(FIND_MY_CONSTRUCTION_SITES, 1, {
            filter: s => s.structureType === STRUCTURE_CONTAINER
        })[0];

        if (container) {
            // Stand on container to harvest (static mining)
            if (!creep.pos.isEqualTo(container.pos)) {
                creep.moveTo(container, { reusePath: REUSE_PATH });
                return;
            }

            // Harvest and transfer to container
            const harvestResult = creep.harvest(source);
            if (creep.store.getFreeCapacity() === 0) {
                creep.transfer(container, RESOURCE_ENERGY);
            }
        } else if (containerSite) {
            // Stand on construction site while waiting
            if (!creep.pos.isEqualTo(containerSite.pos)) {
                creep.moveTo(containerSite, { reusePath: REUSE_PATH });
                return;
            }

            // Harvest and drop on site (will be picked up after container built)
            if (creep.pos.isNearTo(source)) {
                creep.harvest(source);
                if (creep.store.getFreeCapacity() === 0) {
                    creep.drop(RESOURCE_ENERGY);
                }
            }
        } else {
            // No container - find best position adjacent to source
            if (creep.pos.isNearTo(source)) {
                creep.harvest(source);

                // Drop energy when full (haulers will pick up)
                if (creep.store.getFreeCapacity() === 0) {
                    creep.drop(RESOURCE_ENERGY);
                }
            } else {
                creep.moveTo(source, { reusePath: REUSE_PATH, visualizePathStyle: { stroke: "#ffaa00" } });
            }
        }
    }

    /**
     * Execute delivery task
     */
    private executeDeliver(creep: Creep, target: StructureSpawn | StructureExtension | StructureTower | StructureStorage): void {
        // Check if target still needs energy
        if (target.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
            this.completeTask(creep);
            return;
        }

        // Check if creep has energy to deliver
        if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
            // Switch to acquiring state
            if (creep.memory.currentTask) {
                creep.memory.currentTask.state = "acquiring";
            }
            return;
        }

        if (creep.pos.isNearTo(target)) {
            const result = creep.transfer(target, RESOURCE_ENERGY);
            if (result === OK) {
                // Check if task is complete
                if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0 ||
                    target.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
                    this.completeTask(creep);
                }
            } else if (result === ERR_FULL) {
                // Target is full
                this.completeTask(creep);
            } else if (result === ERR_NOT_ENOUGH_RESOURCES) {
                // Creep is empty, switch to acquiring
                if (creep.memory.currentTask) {
                    creep.memory.currentTask.state = "acquiring";
                }
            }
        } else {
            creep.moveTo(target, { reusePath: REUSE_PATH, visualizePathStyle: { stroke: "#ffffff" } });
        }
    }

    /**
     * Execute pickup task
     */
    private executePickup(creep: Creep, resource: Resource): void {
        if (creep.pos.isNearTo(resource)) {
            const result = creep.pickup(resource);
            if (result === OK) {
                // Only complete if we picked up everything or are full
                if (!Game.getObjectById(resource.id) || creep.store.getFreeCapacity() === 0) {
                    this.completeTask(creep);
                }
            } else if (result === ERR_FULL) {
                // Creep is full, complete the task
                this.completeTask(creep);
            } else if (result === ERR_INVALID_TARGET) {
                // Resource is gone
                this.completeTask(creep);
            }
        } else {
            creep.moveTo(resource, { reusePath: REUSE_PATH, visualizePathStyle: { stroke: "#ffff00" } });
        }
    }

    /**
     * Execute withdraw task
     */
    private executeWithdraw(creep: Creep, target: StructureContainer | StructureStorage): void {
        if (target.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
            this.completeTask(creep);
            return;
        }

        if (creep.pos.isNearTo(target)) {
            const result = creep.withdraw(target, RESOURCE_ENERGY);
            if (result === OK) {
                // Complete after successful withdraw
                this.completeTask(creep);
            } else if (result === ERR_FULL) {
                // Creep is full
                this.completeTask(creep);
            } else if (result === ERR_NOT_ENOUGH_RESOURCES) {
                // Container is empty
                this.completeTask(creep);
            }
        } else {
            creep.moveTo(target, { reusePath: REUSE_PATH, visualizePathStyle: { stroke: "#00ff00" } });
        }
    }

    /**
     * Execute build task
     */
    private executeBuild(creep: Creep, site: ConstructionSite): void {
        if (creep.pos.inRangeTo(site, 3)) {
            const result = creep.build(site);
            if (result === ERR_NOT_ENOUGH_RESOURCES) {
                creep.memory.currentTask!.state = "acquiring";
            }
        } else {
            creep.moveTo(site, { reusePath: REUSE_PATH, visualizePathStyle: { stroke: "#00ffff" } });
        }
    }

    /**
     * Execute repair task
     */
    private executeRepair(creep: Creep, structure: Structure): void {
        // Check if structure is fully repaired
        if (structure.hits >= structure.hitsMax) {
            this.completeTask(creep);
            return;
        }

        // For walls/ramparts, use RCL-based hit targets
        if (structure.structureType === STRUCTURE_WALL ||
            structure.structureType === STRUCTURE_RAMPART) {
            const targetHits = this.getWallTargetHits(creep.room);
            if (structure.hits >= targetHits) {
                this.completeTask(creep);
                return;
            }
        }

        // Check if creep has energy
        if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
            if (creep.memory.currentTask) {
                creep.memory.currentTask.state = "acquiring";
            }
            return;
        }

        if (creep.pos.inRangeTo(structure, 3)) {
            const result = creep.repair(structure);
            if (result === ERR_NOT_ENOUGH_RESOURCES) {
                if (creep.memory.currentTask) {
                    creep.memory.currentTask.state = "acquiring";
                }
            }
        } else {
            creep.moveTo(structure, { reusePath: REUSE_PATH, visualizePathStyle: { stroke: "#ff00ff" } });
        }
    }

    /**
     * Get target hit points for walls/ramparts based on RCL
     */
    private getWallTargetHits(room: Room): number {
        const rcl = room.controller?.level ?? 1;
        const targets: Record<number, number> = {
            1: 1000,
            2: 5000,
            3: 25000,
            4: 50000,
            5: 100000,
            6: 300000,
            7: 500000,
            8: 1000000
        };
        return targets[rcl] ?? 10000;
    }

    /**
     * Execute upgrade task
     */
    private executeUpgrade(creep: Creep, controller: StructureController): void {
        if (creep.pos.inRangeTo(controller, 3)) {
            const result = creep.upgradeController(controller);
            if (result === ERR_NOT_ENOUGH_RESOURCES) {
                creep.memory.currentTask!.state = "acquiring";
            }
        } else {
            creep.moveTo(controller, { reusePath: REUSE_PATH, visualizePathStyle: { stroke: "#0000ff" } });
        }
    }

    /**
     * Execute attack task
     */
    private executeAttack(creep: Creep, target: Creep): void {
        if (creep.pos.isNearTo(target)) {
            creep.attack(target);
        } else {
            creep.moveTo(target, { reusePath: 3, visualizePathStyle: { stroke: "#ff0000" } });
        }
    }

    /**
     * Execute rampart defense task
     * Move to rampart and attack any adjacent hostiles
     */
    private executeDefendRampart(creep: Creep, rampart: StructureRampart): void {
        // Move to rampart position
        if (!creep.pos.isEqualTo(rampart.pos)) {
            creep.moveTo(rampart, { reusePath: 3, visualizePathStyle: { stroke: "#ff0000" } });
        }

        // Attack any adjacent hostiles
        const hostile = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1)[0];
        if (hostile) {
            creep.attack(hostile);
        }

        // Also use ranged attack if available
        const rangedHostile = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 3)[0];
        if (rangedHostile && creep.getActiveBodyparts(RANGED_ATTACK) > 0) {
            if (creep.pos.getRangeTo(rangedHostile) === 1) {
                creep.rangedMassAttack();
            } else {
                creep.rangedAttack(rangedHostile);
            }
        }

        // Complete task if no more hostiles in room
        const hostiles = creep.room.find(FIND_HOSTILE_CREEPS);
        if (hostiles.length === 0) {
            this.completeTask(creep);
        }
    }

    /**
     * Handle idle creep (no task)
     */
    private handleIdleCreep(creep: Creep): void {
        const spawn = creep.room.find(FIND_MY_SPAWNS)[0];
        if (!spawn) return;

        // Move towards spawn but not too close
        if (!creep.pos.inRangeTo(spawn, 3)) {
            creep.moveTo(spawn, { reusePath: REUSE_PATH });
        } else if (creep.pos.isNearTo(spawn) && Game.time % 5 === 0) {
            // Occasionally move away from spawn to avoid blocking
            const directions: DirectionConstant[] = [
                TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT
            ];
            const direction = directions[Math.floor(Math.random() * directions.length)];
            creep.move(direction);
        }
    }

    /**
     * Complete current task
     */
    private completeTask(creep: Creep): void {
        const taskState = creep.memory.currentTask;
        if (!taskState) return;

        const room = creep.room;
        taskDispatcher.updateTaskStatus(room, taskState.taskId, TaskStatus.COMPLETED);

        delete creep.memory.currentTask;
    }

    /**
     * Clear creep's task without completing
     */
    private clearCreepTask(creep: Creep): void {
        const taskState = creep.memory.currentTask;
        if (taskState) {
            taskDispatcher.unassignTask(creep.room, taskState.taskId);
        }
        delete creep.memory.currentTask;
    }

    /**
     * Helper: Move to and withdraw from structure
     */
    private moveToAndWithdraw(creep: Creep, target: StructureContainer | StructureStorage): void {
        if (creep.pos.isNearTo(target)) {
            creep.withdraw(target, RESOURCE_ENERGY);
        } else {
            creep.moveTo(target, { reusePath: REUSE_PATH });
        }
    }

    /**
     * Helper: Move to and pickup resource
     */
    private moveToAndPickup(creep: Creep, target: Resource): void {
        if (creep.pos.isNearTo(target)) {
            creep.pickup(target);
        } else {
            creep.moveTo(target, { reusePath: REUSE_PATH });
        }
    }

    /**
     * Helper: Move to and harvest source
     */
    private moveToAndHarvest(creep: Creep, source: Source): void {
        if (creep.pos.isNearTo(source)) {
            creep.harvest(source);
        } else {
            creep.moveTo(source, { reusePath: REUSE_PATH });
        }
    }
}

// Singleton instance
const taskExecutorInstance = new TaskExecutor();

export const taskExecutorModule = () => {
    taskExecutorInstance.executeTasks();
};

export const taskExecutor = taskExecutorInstance;
