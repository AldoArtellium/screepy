/**
 * TaskDispatcher - Task Assignment & Execution Module
 * Matches tasks to creeps and executes task actions.
 */

import { canPerformCategory, getCategorySuitability, getRoleConfig } from "../config/roleTaskConfig";
import { Task, TASK_TYPE_TO_CATEGORY, TaskCategory, TaskStatus, TaskType } from "../types/TaskTypes";
import { TaskManager } from "./TaskManager";

/**
 * Path reuse for movement
 */
const REUSE_PATH = 5;

/**
 * Result of task execution
 */
export type TaskExecutionResult = "continue" | "completed" | "failed";

/**
 * TaskDispatcherImpl class for assignment and execution
 */
class TaskDispatcherImpl {
    /**
     * Attempt to assign a task to a creep
     * Returns true if a task was assigned, false otherwise
     */
    assignTask(creep: Creep): boolean {
        const room = creep.room;
        const role = creep.memory.role || "harvester";
        const config = getRoleConfig(role);

        // Get pending tasks
        const pendingTasks = TaskManager.getPendingTasks(room);
        if (pendingTasks.length === 0) return false;

        // Score each task for this creep
        let bestTask: Task | null = null;
        let bestScore = Infinity;

        for (const task of pendingTasks) {
            const score = this.scoreTaskForCreep(creep, task, config);
            if (score < bestScore) {
                bestScore = score;
                bestTask = task;
            }
        }

        // Assign best task if found and score is acceptable
        if (bestTask && bestScore < 1000) {
            this.assignTaskToCreep(creep, bestTask);
            return true;
        }

        return false;
    }

    /**
     * Score a task for a creep (lower = better)
     */
    private scoreTaskForCreep(creep: Creep, task: Task, config: ReturnType<typeof getRoleConfig>): number {
        const category = TASK_TYPE_TO_CATEGORY[task.type];

        // Check if creep can perform this category
        if (!canPerformCategory(creep, category)) {
            return Infinity;
        }

        // Base score is task priority
        let score = task.priority;

        // Role suitability modifier
        const suitability = getCategorySuitability(creep, category);
        score -= suitability; // Higher suitability = lower score

        // Category-specific priority modifier (replaces flat taskPriorityModifier)
        const categoryModifier = config.categoryModifiers[category] ?? 0;
        score += categoryModifier;

        // Distance penalty - higher for ongoing work tasks, lower for critical tasks
        const targetPos = new RoomPosition(task.targetPos.x, task.targetPos.y, task.targetPos.roomName);
        const distance = creep.pos.getRangeTo(targetPos);
        const isCritical = task.type === TaskType.FILL_SPAWN || task.type === TaskType.FILL_EXTENSION;
        const distanceWeight = isCritical ? 0.3 : 1.5;
        score += distance * distanceWeight;

        // Task stickiness: Prefer same category as last completed task
        if (creep.memory.lastTaskCategory !== undefined && creep.memory.lastTaskCategory === category) {
            score -= 15; // Bonus for continuing same type of work
        }

        // Task cooldown: Penalize switching categories within 10 ticks of completion
        if (creep.memory.lastTaskCompleted !== undefined && creep.memory.lastTaskCategory !== undefined) {
            const ticksSinceCompletion = Game.time - creep.memory.lastTaskCompleted;
            if (ticksSinceCompletion < 10 && creep.memory.lastTaskCategory !== category) {
                // Penalty decreases over time: 20 at tick 0, 2 at tick 9
                const cooldownPenalty = Math.floor(20 * (1 - ticksSinceCompletion / 10));
                score += cooldownPenalty;
            }
        }

        // For transport tasks, consider current energy state
        if (category === TaskCategory.TRANSPORT) {
            const isPickup = task.type === TaskType.PICKUP_RESOURCE ||
                            task.type === TaskType.WITHDRAW_CONTAINER ||
                            task.type === TaskType.WITHDRAW_STORAGE;

            if (isPickup && creep.store.getFreeCapacity() === 0) {
                // Can't pick up more, penalize heavily
                score += 1000;
            } else if (!isPickup && creep.store.getUsedCapacity() === 0) {
                // Can't deliver with empty store
                score += 1000;
            }
        }

        // For build/repair/upgrade, need energy
        const needsEnergy = category === TaskCategory.BUILD ||
            category === TaskCategory.REPAIR ||
            category === TaskCategory.UPGRADE;
        if (needsEnergy && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
            score += 1000;
        }

        return score;
    }

    /**
     * Assign a task to a creep
     */
    private assignTaskToCreep(creep: Creep, task: Task): void {
        creep.memory.task = {
            id: task.id,
            startedAt: Game.time,
            state: this.getInitialTaskState(creep, task)
        };

        if (task.shared) {
            // For shared tasks, increment worker count and set to IN_PROGRESS
            TaskManager.incrementWorkerCount(creep.room, task.id);
            TaskManager.updateTaskStatus(creep.room, task.id, TaskStatus.IN_PROGRESS);
        } else {
            TaskManager.updateTaskStatus(creep.room, task.id, TaskStatus.ASSIGNED, creep.name);
        }
    }

    /**
     * Determine initial state based on creep's current resources
     */
    private getInitialTaskState(creep: Creep, task: Task): "acquiring" | "executing" | "returning" {
        const category = TASK_TYPE_TO_CATEGORY[task.type];

        // Transport pickup tasks start in executing
        if (task.type === TaskType.PICKUP_RESOURCE ||
            task.type === TaskType.WITHDRAW_CONTAINER ||
            task.type === TaskType.WITHDRAW_STORAGE) {
            return "executing";
        }

        // Transport delivery tasks
        if (category === TaskCategory.TRANSPORT) {
            if (creep.store.getUsedCapacity(RESOURCE_ENERGY) >= creep.store.getCapacity() * 0.8) {
                return "executing";
            }
            return "acquiring";
        }

        // Build/repair/upgrade need energy
        const needsEnergy = category === TaskCategory.BUILD ||
            category === TaskCategory.REPAIR ||
            category === TaskCategory.UPGRADE;
        if (needsEnergy) {
            if (creep.store.getUsedCapacity(RESOURCE_ENERGY) >= creep.store.getCapacity() * 0.8) {
                return "executing";
            }
            return "acquiring";
        }

        return "executing";
    }

    /**
     * Execute the creep's assigned task
     * Returns "continue" if task is ongoing, "completed" if done, "failed" if task failed
     */
    executeTask(creep: Creep): TaskExecutionResult {
        const taskMemory = creep.memory.task;
        if (!taskMemory) return "failed";

        const task = TaskManager.getTask(creep.room, taskMemory.id);
        if (!task) {
            // Task no longer exists
            delete creep.memory.task;
            return "failed";
        }

        // Update task status
        if (task.status !== TaskStatus.IN_PROGRESS) {
            TaskManager.updateTaskStatus(creep.room, task.id, TaskStatus.IN_PROGRESS);
        }

        // Handle task based on current state
        let result: TaskExecutionResult;
        switch (taskMemory.state) {
            case "acquiring":
                result = this.handleAcquiring(creep, task);
                break;
            case "executing":
                result = this.handleExecuting(creep, task);
                break;
            case "returning":
                result = this.handleReturning(creep, task);
                break;
            default:
                result = "failed";
        }

        // Handle task completion
        if (result === "completed") {
            this.completeTask(creep, task, TaskStatus.COMPLETED);
        } else if (result === "failed") {
            this.completeTask(creep, task, TaskStatus.FAILED);
        }

        return result;
    }

    /**
     * Handle acquiring state (getting resources before executing)
     */
    private handleAcquiring(creep: Creep, task: Task): TaskExecutionResult {
        // Need energy for most tasks
        if (creep.store.getUsedCapacity(RESOURCE_ENERGY) >= creep.store.getCapacity() * 0.8) {
            // Have enough energy, switch to executing
            creep.memory.task!.state = "executing";
            return "continue";
        }

        // Find energy source
        const container = creep.pos.findClosestByPath(FIND_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_CONTAINER &&
                        s.store.getUsedCapacity(RESOURCE_ENERGY) > 50
        }) as StructureContainer | null;

        if (container) {
            if (creep.pos.isNearTo(container)) {
                creep.withdraw(container, RESOURCE_ENERGY);
            } else {
                creep.moveTo(container, { reusePath: REUSE_PATH });
            }
            return "continue";
        }

        // Try storage
        if (creep.room.storage && creep.room.storage.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
            if (creep.pos.isNearTo(creep.room.storage)) {
                creep.withdraw(creep.room.storage, RESOURCE_ENERGY);
            } else {
                creep.moveTo(creep.room.storage, { reusePath: REUSE_PATH });
            }
            return "continue";
        }

        // Try dropped resources
        const dropped = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
            filter: r => r.resourceType === RESOURCE_ENERGY && r.amount > 20
        });

        if (dropped) {
            if (creep.pos.isNearTo(dropped)) {
                creep.pickup(dropped);
            } else {
                creep.moveTo(dropped, { reusePath: REUSE_PATH });
            }
            return "continue";
        }

        // Try harvesting directly from source (for creeps with WORK parts in early game)
        if (creep.getActiveBodyparts(WORK) > 0) {
            const source = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE);
            if (source) {
                if (creep.pos.isNearTo(source)) {
                    creep.harvest(source);
                } else {
                    creep.moveTo(source, { reusePath: REUSE_PATH });
                }
                return "continue";
            }
        }

        // No energy available, fail task
        return "failed";
    }

    /**
     * Handle executing state (performing the actual task action)
     */
    private handleExecuting(creep: Creep, task: Task): TaskExecutionResult {
        const target = Game.getObjectById(task.targetId);
        if (!target) {
            this.completeTask(creep, task, TaskStatus.COMPLETED);
            return "completed";
        }

        switch (task.type) {
            // Pickup tasks
            case TaskType.PICKUP_RESOURCE:
                return this.executePickup(creep, target as Resource);

            case TaskType.WITHDRAW_CONTAINER:
            case TaskType.WITHDRAW_STORAGE:
                return this.executeWithdraw(creep, target as StructureContainer | StructureStorage);

            // Delivery tasks
            case TaskType.FILL_SPAWN:
            case TaskType.FILL_EXTENSION:
            case TaskType.FILL_TOWER:
            case TaskType.FILL_STORAGE:
                return this.executeTransfer(creep, target as AnyStoreStructure);

            // Build task
            case TaskType.BUILD_STRUCTURE:
                return this.executeBuild(creep, target as ConstructionSite);

            // Repair tasks
            case TaskType.REPAIR_STRUCTURE:
            case TaskType.REPAIR_WALL:
            case TaskType.REPAIR_RAMPART:
                return this.executeRepair(creep, target as Structure);

            // Upgrade task
            case TaskType.UPGRADE_CONTROLLER:
                return this.executeUpgrade(creep, target as StructureController);

            default:
                return "failed";
        }
    }

    /**
     * Handle returning state (after task complete, returning to a location)
     */
    private handleReturning(creep: Creep, task: Task): TaskExecutionResult {
        // Simple returning - just complete the task
        // Completion is handled in executeTask
        return "completed";
    }

    // Task execution helpers

    private executePickup(creep: Creep, resource: Resource): TaskExecutionResult {
        if (creep.store.getFreeCapacity() === 0) {
            return "completed";
        }

        if (creep.pos.isNearTo(resource)) {
            const result = creep.pickup(resource);
            if (result === OK || result === ERR_FULL) {
                return "completed";
            }
            return result === ERR_NOT_IN_RANGE ? "continue" : "failed";
        } else {
            creep.moveTo(resource, { reusePath: REUSE_PATH });
            return "continue";
        }
    }

    private executeWithdraw(creep: Creep, structure: StructureContainer | StructureStorage): TaskExecutionResult {
        if (creep.store.getFreeCapacity() === 0) {
            return "completed";
        }

        if (structure.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
            return "completed";
        }

        if (creep.pos.isNearTo(structure)) {
            const result = creep.withdraw(structure, RESOURCE_ENERGY);
            if (result === OK || result === ERR_FULL || result === ERR_NOT_ENOUGH_RESOURCES) {
                return "completed";
            }
            return result === ERR_NOT_IN_RANGE ? "continue" : "failed";
        } else {
            creep.moveTo(structure, { reusePath: REUSE_PATH });
            return "continue";
        }
    }

    private executeTransfer(creep: Creep, structure: AnyStoreStructure): TaskExecutionResult {
        if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
            // Creep is empty, task complete
            return "completed";
        }

        if ("store" in structure && structure.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
            // Target is full, task complete
            return "completed";
        }

        if (creep.pos.isNearTo(structure)) {
            const result = creep.transfer(structure, RESOURCE_ENERGY);
            if (result === OK) {
                // Check if creep is now empty after transfer
                if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
                    return "completed";
                }
                // Keep transferring until empty (for larger capacity creeps)
                return "continue";
            }
            if (result === ERR_FULL) {
                // Target became full
                return "completed";
            }
            return result === ERR_NOT_IN_RANGE ? "continue" : "failed";
        } else {
            creep.moveTo(structure, { reusePath: REUSE_PATH, visualizePathStyle: { stroke: "#ffffff" } });
            return "continue";
        }
    }

    private executeBuild(creep: Creep, site: ConstructionSite): TaskExecutionResult {
        if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
            // Complete task when out of energy - creep can get a new task
            return "completed";
        }

        if (creep.pos.inRangeTo(site, 3)) {
            const result = creep.build(site);
            if (result === OK) {
                // Check if we ran out of energy after building
                if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
                    return "completed";
                }
                return "continue";
            }
            if (result === ERR_INVALID_TARGET) {
                // Site completed
                return "completed";
            }
            return "failed";
        } else {
            creep.moveTo(site, { reusePath: REUSE_PATH, visualizePathStyle: { stroke: "#ffaa00" } });
            return "continue";
        }
    }

    private executeRepair(creep: Creep, structure: Structure): TaskExecutionResult {
        if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
            // Complete task when out of energy - creep can get a new task
            return "completed";
        }

        // Check if repair complete
        if (structure.hits >= structure.hitsMax) {
            return "completed";
        }

        // For walls/ramparts, check against threshold
        const isWallOrRampart = structure.structureType === STRUCTURE_WALL ||
            structure.structureType === STRUCTURE_RAMPART;
        if (isWallOrRampart && structure.hits >= 10000) {
            return "completed";
        }

        if (creep.pos.inRangeTo(structure, 3)) {
            const result = creep.repair(structure);
            if (result === OK) {
                // Check if we ran out of energy after repairing
                if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
                    return "completed";
                }
                return "continue";
            }
            return "failed";
        } else {
            creep.moveTo(structure, { reusePath: REUSE_PATH, visualizePathStyle: { stroke: "#00ff00" } });
            return "continue";
        }
    }

    private executeUpgrade(creep: Creep, controller: StructureController): TaskExecutionResult {
        if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
            // Complete task when out of energy - creep can get a new task
            return "completed";
        }

        if (creep.pos.inRangeTo(controller, 3)) {
            const result = creep.upgradeController(controller);
            if (result === OK) {
                // Check if we ran out of energy after upgrading
                if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
                    return "completed";
                }
                return "continue";
            }
            return "failed";
        } else {
            creep.moveTo(controller, { reusePath: REUSE_PATH, visualizePathStyle: { stroke: "#00aaff" } });
            return "continue";
        }
    }

    /**
     * Complete a task
     */
    private completeTask(creep: Creep, task: Task, status: TaskStatus): void {
        if (task.shared) {
            // For shared tasks, decrement worker count but don't change status
            // The task stays IN_PROGRESS for other workers
            TaskManager.decrementWorkerCount(creep.room, task.id);
        } else {
            TaskManager.updateTaskStatus(creep.room, task.id, status);
        }
        delete creep.memory.task;
    }

    /**
     * Release a creep's current task back to pending
     */
    releaseTask(creep: Creep): void {
        if (!creep.memory.task) return;

        const task = TaskManager.getTask(creep.room, creep.memory.task.id);
        if (task) {
            if (task.shared) {
                // For shared tasks, decrement worker count
                TaskManager.decrementWorkerCount(creep.room, task.id);
            } else {
                TaskManager.updateTaskStatus(creep.room, task.id, TaskStatus.PENDING);
                task.assignedTo = undefined;
            }
        }
        delete creep.memory.task;
    }
}

// Singleton instance
export const TaskDispatcher = new TaskDispatcherImpl();
