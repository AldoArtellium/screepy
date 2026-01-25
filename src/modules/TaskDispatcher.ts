/**
 * TaskDispatcher - Matches idle creeps to pending tasks
 * Assigns tasks based on capability and proximity
 */

import { countParts, hasRequiredParts } from "../config/bodyTypes";
import {
    getTaskCategory,
    Task,
    TASK_PART_REQUIREMENTS,
    TaskStatus,
    TaskType
} from "../types/TaskTypes";
import { log } from "../utils/logger";

class TaskDispatcher {
    /**
     * Dispatch tasks to idle creeps in a room
     */
    dispatchTasks(room: Room): void {
        if (!room.controller?.my) return;

        const queue = room.memory.taskQueue ?? [];
        const pendingTasks = queue
            .filter(t => t.status === TaskStatus.PENDING)
            .sort((a, b) => a.priority - b.priority);

        if (pendingTasks.length === 0) return;

        // Find idle creeps (no current task)
        const idleCreeps = room.find(FIND_MY_CREEPS, {
            filter: c => !c.spawning && !c.memory.currentTask
        });

        if (idleCreeps.length === 0) return;

        // Match tasks to creeps
        for (const task of pendingTasks) {
            if (task.status !== TaskStatus.PENDING) continue;

            const bestCreep = this.findBestCreepForTask(task, idleCreeps);
            if (bestCreep) {
                this.assignTask(task, bestCreep);
                // Remove creep from idle list
                const index = idleCreeps.indexOf(bestCreep);
                if (index > -1) {
                    idleCreeps.splice(index, 1);
                }
            }
        }
    }

    /**
     * Find the best creep for a task based on capability and proximity
     */
    private findBestCreepForTask(task: Task, creeps: Creep[]): Creep | null {
        // Category computed for potential future use in task filtering
        getTaskCategory(task.type);

        let bestCreep: Creep | null = null;
        let bestScore = -Infinity;

        for (const creep of creeps) {
            // Check if creep can perform this task
            if (!this.canPerformTask(creep, task)) {
                continue;
            }

            // Score based on proximity and capability
            const score = this.scoreCreepForTask(creep, task);
            if (score > bestScore) {
                bestScore = score;
                bestCreep = creep;
            }
        }

        return bestCreep;
    }

    /**
     * Check if a creep can perform a task
     */
    canPerformTask(creep: Creep, task: Task): boolean {
        const category = getTaskCategory(task.type);
        const requirements = TASK_PART_REQUIREMENTS[category];

        // Check part requirements
        if (!hasRequiredParts(creep, requirements)) {
            return false;
        }

        // Special checks for specific task types
        switch (task.type) {
            case TaskType.FILL_SPAWN:
            case TaskType.FILL_EXTENSION:
            case TaskType.FILL_TOWER:
            case TaskType.FILL_STORAGE:
                // Transport tasks need CARRY parts
                return countParts(creep, CARRY) > 0;

            case TaskType.HARVEST_SOURCE:
                // Harvest needs WORK parts
                return countParts(creep, WORK) > 0;

            case TaskType.BUILD_STRUCTURE:
            case TaskType.REPAIR_STRUCTURE:
            case TaskType.REPAIR_RAMPART:
            case TaskType.REPAIR_WALL:
            case TaskType.UPGRADE_CONTROLLER:
                // These need both WORK and CARRY
                return countParts(creep, WORK) > 0 && countParts(creep, CARRY) > 0;

            case TaskType.ATTACK_HOSTILE:
            case TaskType.DEFEND_RAMPART:
                // Combat needs ATTACK parts
                return countParts(creep, ATTACK) > 0;

            default:
                return true;
        }
    }

    /**
     * Score a creep for a task (higher = better)
     */
    private scoreCreepForTask(creep: Creep, task: Task): number {
        let score = 0;

        // Get target position
        const target = Game.getObjectById(task.targetId as Id<any>);
        if (!target) return -1000;

        const targetPos = "pos" in target ? (target as RoomObject).pos : null;
        if (!targetPos) return -1000;

        const category = getTaskCategory(task.type);
        const requirements = TASK_PART_REQUIREMENTS[category];

        // Base capability score - prefer specialized creeps
        const workParts = countParts(creep, WORK);
        const carryParts = countParts(creep, CARRY);

        // Specialization bonus: creeps with more of a part type are better for that task
        for (const [part, minCount] of Object.entries(requirements)) {
            const actualCount = countParts(creep, part as BodyPartConstant);
            score += (actualCount - minCount) * 10;
        }

        // Proximity score (closer is better, but capped impact)
        const distance = creep.pos.getRangeTo(targetPos);
        score -= Math.min(distance * 2, 40); // Cap distance penalty at 40

        // Task urgency bonus (older tasks get priority)
        const taskAge = Game.time - task.createdAt;
        score += Math.min(taskAge / 10, 10); // Up to +10 for old tasks

        // Energy state scoring for transport tasks
        if (category === "transport") {
            const freeCapacity = creep.store.getFreeCapacity() ?? 0;
            const usedCapacity = creep.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
            const totalCapacity = creep.store.getCapacity() ?? 1;
            const fillRatio = usedCapacity / totalCapacity;

            // Delivery tasks: prefer creeps with energy
            if (task.type === TaskType.FILL_SPAWN ||
                task.type === TaskType.FILL_EXTENSION ||
                task.type === TaskType.FILL_TOWER ||
                task.type === TaskType.FILL_STORAGE) {
                // Strong preference for full creeps
                if (fillRatio >= 0.8) {
                    score += 50;
                } else if (fillRatio >= 0.5) {
                    score += 25;
                } else if (fillRatio > 0) {
                    score += 10;
                } else {
                    // Empty creep - penalize for delivery tasks
                    score -= 30;
                }
            }
            // Pickup/withdraw tasks: prefer creeps with capacity
            else if (task.type === TaskType.PICKUP_RESOURCE ||
                     task.type === TaskType.WITHDRAW_CONTAINER ||
                     task.type === TaskType.WITHDRAW_STORAGE) {
                if (freeCapacity >= totalCapacity * 0.8) {
                    score += 50;
                } else if (freeCapacity >= totalCapacity * 0.5) {
                    score += 25;
                } else if (freeCapacity > 0) {
                    score += 10;
                } else {
                    // Full creep - penalize for pickup tasks
                    score -= 30;
                }
            }
        }

        // Work task scoring
        if (category === "build" || category === "repair" || category === "upgrade") {
            const usedCapacity = creep.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
            // Prefer creeps with energy for work tasks
            if (usedCapacity > 0) {
                score += 20;
            }
            // Bonus for having more WORK parts
            score += workParts * 5;
        }

        // Harvest task scoring - prefer creeps with high WORK
        if (category === "harvest") {
            score += workParts * 15; // Strongly prefer high WORK creeps
            // Penalize creeps with lots of CARRY (they should haul instead)
            if (carryParts > workParts * 2) {
                score -= 20;
            }
        }

        return score;
    }

    /**
     * Assign a task to a creep
     */
    private assignTask(task: Task, creep: Creep): void {
        // Update task status
        task.status = TaskStatus.ASSIGNED;
        task.assignedTo = creep.name;

        // Set creep's current task
        creep.memory.currentTask = {
            taskId: task.id,
            type: task.type,
            targetId: task.targetId,
            state: this.getInitialTaskState(task, creep),
            startedAt: Game.time
        };

        log.debug("TaskDispatcher", `Assigned ${task.type} to ${creep.name}`);
    }

    /**
     * Determine initial task state
     */
    private getInitialTaskState(task: Task, creep: Creep): "acquiring" | "executing" {
        const usedEnergy = creep.store.getUsedCapacity(RESOURCE_ENERGY) ?? 0;
        const totalCapacity = creep.store.getCapacity() ?? 0;
        const energyRatio = totalCapacity > 0 ? usedEnergy / totalCapacity : 0;

        switch (task.type) {
            case TaskType.FILL_SPAWN:
            case TaskType.FILL_EXTENSION:
            case TaskType.FILL_TOWER:
            case TaskType.FILL_STORAGE:
                // Delivery tasks - need significant energy (>20%) to execute
                return energyRatio >= 0.2 ? "executing" : "acquiring";

            case TaskType.BUILD_STRUCTURE:
            case TaskType.REPAIR_STRUCTURE:
            case TaskType.REPAIR_RAMPART:
            case TaskType.REPAIR_WALL:
            case TaskType.UPGRADE_CONTROLLER:
                // Work tasks - need at least some energy to execute
                return usedEnergy > 0 ? "executing" : "acquiring";

            case TaskType.PICKUP_RESOURCE:
            case TaskType.WITHDRAW_CONTAINER:
            case TaskType.WITHDRAW_STORAGE:
            case TaskType.HARVEST_SOURCE:
            case TaskType.ATTACK_HOSTILE:
            case TaskType.DEFEND_RAMPART:
                // These tasks don't need energy to start
                return "executing";

            default:
                return "executing";
        }
    }

    /**
     * Get a task by ID from a room's queue
     */
    getTaskById(room: Room, taskId: string): Task | undefined {
        return (room.memory.taskQueue ?? []).find(t => t.id === taskId);
    }

    /**
     * Update a task's status
     */
    updateTaskStatus(room: Room, taskId: string, status: TaskStatus): void {
        const task = this.getTaskById(room, taskId);
        if (task) {
            task.status = status;
        }
    }

    /**
     * Unassign a task (when creep dies or abandons)
     */
    unassignTask(room: Room, taskId: string): void {
        const task = this.getTaskById(room, taskId);
        if (task) {
            task.status = TaskStatus.PENDING;
            delete task.assignedTo;
        }
    }

    /**
     * Dispatch tasks for creeps with targetRoom (bootstrap/remote creeps)
     * These creeps look at tasks in their target room, not their home room
     */
    dispatchCrossRoomTasks(): void {
        // Find all idle creeps with a targetRoom
        const crossRoomCreeps = _.filter(Game.creeps, c =>
            !c.spawning &&
            !c.memory.currentTask &&
            c.memory.targetRoom
        );

        if (crossRoomCreeps.length === 0) return;

        // Group creeps by their target room
        const creepsByTarget: { [roomName: string]: Creep[] } = {};
        for (const creep of crossRoomCreeps) {
            const target = creep.memory.targetRoom!;
            if (!creepsByTarget[target]) {
                creepsByTarget[target] = [];
            }
            creepsByTarget[target].push(creep);
        }

        // Dispatch tasks for each target room
        for (const targetRoomName in creepsByTarget) {
            const targetRoom = Game.rooms[targetRoomName];
            const creeps = creepsByTarget[targetRoomName];

            // If we have visibility of target room
            if (targetRoom?.controller?.my) {
                const queue = targetRoom.memory.taskQueue ?? [];
                const pendingTasks = queue
                    .filter(t => t.status === TaskStatus.PENDING)
                    .sort((a, b) => a.priority - b.priority);

                if (pendingTasks.length === 0) continue;

                // Match tasks to creeps (even if creep is in different room)
                for (const task of pendingTasks) {
                    if (task.status !== TaskStatus.PENDING) continue;

                    // Find best creep that can perform this task
                    const capableCreeps = creeps.filter(c =>
                        !c.memory.currentTask && this.canPerformTask(c, task)
                    );

                    if (capableCreeps.length === 0) continue;

                    // For cross-room, prefer creeps already in the target room
                    const inRoomCreeps = capableCreeps.filter(c => c.room.name === targetRoomName);
                    const bestCreep = inRoomCreeps.length > 0
                        ? this.findBestCreepForTask(task, inRoomCreeps)
                        : capableCreeps[0]; // Just pick first capable if none in room yet

                    if (bestCreep) {
                        this.assignTaskCrossRoom(task, bestCreep, targetRoom);
                        // Remove from available list
                        const idx = creeps.indexOf(bestCreep);
                        if (idx > -1) creeps.splice(idx, 1);
                    }
                }
            }
        }
    }

    /**
     * Assign a task to a creep for cross-room work
     */
    private assignTaskCrossRoom(task: Task, creep: Creep, targetRoom: Room): void {
        // Update task status in the target room
        task.status = TaskStatus.ASSIGNED;
        task.assignedTo = creep.name;

        // Set creep's current task
        creep.memory.currentTask = {
            taskId: task.id,
            type: task.type,
            targetId: task.targetId,
            state: this.getInitialTaskState(task, creep),
            startedAt: Game.time
        };

        log.debug("TaskDispatcher", `Cross-room assigned ${task.type} in ${targetRoom.name} to ${creep.name}`);
    }
}

// Singleton instance
const taskDispatcherInstance = new TaskDispatcher();

export const taskDispatcherModule = () => {
    // Dispatch for owned rooms
    for (const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if (!room.controller?.my) continue;

        taskDispatcherInstance.dispatchTasks(room);
    }

    // Handle cross-room assignment for bootstrap creeps
    taskDispatcherInstance.dispatchCrossRoomTasks();
};

export const taskDispatcher = taskDispatcherInstance;
