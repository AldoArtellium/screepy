/**
 * TaskManager - Queue Management Module
 * Handles task queue initialization, sorting, and cleanup.
 */

import { Task, TaskStatus } from "../types/TaskTypes";
import { log } from "../utils/logger";

/**
 * How often to sort the priority queue (ticks)
 */
const SORT_INTERVAL = 5;

/**
 * TaskManager class for queue operations
 */
class TaskManagerImpl {
    /**
     * Initialize task queue for a room if not already present
     */
    initQueue(room: Room): void {
        if (!room.memory.taskQueue) {
            room.memory.taskQueue = {
                tasks: {},
                byPriority: [],
                lastSort: Game.time,
                lastGeneration: 0
            };
        }
    }

    /**
     * Add a task to the queue
     */
    addTask(room: Room, task: Task): boolean {
        this.initQueue(room);
        const queue = room.memory.taskQueue!;

        // Check for duplicate task on same target
        const existingId = Object.keys(queue.tasks).find(id => {
            const t = queue.tasks[id];
            return t.type === task.type && t.targetId === task.targetId && t.status !== TaskStatus.COMPLETED;
        });

        if (existingId) {
            // Update priority if new task has higher priority
            const existing = queue.tasks[existingId];
            if (task.priority < existing.priority) {
                existing.priority = task.priority;
            }
            return false;
        }

        queue.tasks[task.id] = task;
        queue.byPriority.push(task.id);

        return true;
    }

    /**
     * Get a task by ID
     */
    getTask(room: Room, taskId: string): Task | undefined {
        return room.memory.taskQueue?.tasks[taskId];
    }

    /**
     * Update task status
     */
    updateTaskStatus(room: Room, taskId: string, status: TaskStatus, assignedTo?: string): void {
        const task = this.getTask(room, taskId);
        if (task) {
            task.status = status;
            if (assignedTo !== undefined) {
                task.assignedTo = assignedTo;
            }
        }
    }

    /**
     * Remove a task from the queue
     */
    removeTask(room: Room, taskId: string): void {
        const queue = room.memory.taskQueue;
        if (!queue) return;

        delete queue.tasks[taskId];
        const index = queue.byPriority.indexOf(taskId);
        if (index > -1) {
            queue.byPriority.splice(index, 1);
        }
    }

    /**
     * Get all pending tasks sorted by priority
     * Includes shared IN_PROGRESS tasks that haven't reached maxWorkers
     */
    getPendingTasks(room: Room): Task[] {
        const queue = room.memory.taskQueue;
        if (!queue) return [];

        this.sortIfNeeded(room);

        return queue.byPriority
            .map(id => queue.tasks[id])
            .filter(task => {
                if (!task) return false;
                // Regular pending tasks
                if (task.status === TaskStatus.PENDING) return true;
                // Shared tasks available even when IN_PROGRESS (until maxWorkers reached)
                if (task.shared && task.status === TaskStatus.IN_PROGRESS) {
                    if (task.maxWorkers && (task.workerCount || 0) >= task.maxWorkers) {
                        return false;
                    }
                    return true;
                }
                return false;
            });
    }

    /**
     * Increment worker count for a shared task
     */
    incrementWorkerCount(room: Room, taskId: string): void {
        const task = this.getTask(room, taskId);
        if (task && task.shared) {
            task.workerCount = (task.workerCount || 0) + 1;
        }
    }

    /**
     * Decrement worker count for a shared task
     */
    decrementWorkerCount(room: Room, taskId: string): void {
        const task = this.getTask(room, taskId);
        if (task && task.shared && task.workerCount && task.workerCount > 0) {
            task.workerCount--;
        }
    }

    /**
     * Get count of tasks by status
     */
    getTaskCounts(room: Room): { pending: number; assigned: number; inProgress: number; total: number } {
        const queue = room.memory.taskQueue;
        if (!queue) return { pending: 0, assigned: 0, inProgress: 0, total: 0 };

        let pending = 0;
        let assigned = 0;
        let inProgress = 0;

        Object.values(queue.tasks).forEach(task => {
            switch (task.status) {
                case TaskStatus.PENDING: pending++; break;
                case TaskStatus.ASSIGNED: assigned++; break;
                case TaskStatus.IN_PROGRESS: inProgress++; break;
            }
        });

        return { pending, assigned, inProgress, total: Object.keys(queue.tasks).length };
    }

    /**
     * Sort the priority queue if needed
     */
    private sortIfNeeded(room: Room): void {
        const queue = room.memory.taskQueue;
        if (!queue) return;

        if (Game.time - queue.lastSort >= SORT_INTERVAL) {
            queue.byPriority.sort((a, b) => {
                const taskA = queue.tasks[a];
                const taskB = queue.tasks[b];
                if (!taskA) return 1;
                if (!taskB) return -1;
                return taskA.priority - taskB.priority;
            });
            queue.lastSort = Game.time;
        }
    }

    /**
     * Clean up expired, completed, and invalid tasks
     */
    cleanup(room: Room): number {
        const queue = room.memory.taskQueue;
        if (!queue) return 0;

        let removed = 0;
        const tasksToRemove: string[] = [];

        Object.entries(queue.tasks).forEach(([id, task]) => {
            let shouldRemove = false;

            // Remove completed/failed tasks
            if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED) {
                shouldRemove = true;
            }

            // Remove expired tasks
            if (task.expiresAt && Game.time >= task.expiresAt) {
                shouldRemove = true;
            }

            // Remove tasks where target no longer exists
            const target = Game.getObjectById(task.targetId);
            if (!target) {
                shouldRemove = true;
            }

            // Handle tasks where the assigned creep no longer exists
            if (task.assignedTo && !Game.creeps[task.assignedTo]) {
                if (task.shared) {
                    // For shared tasks, just decrement worker count
                    if (task.workerCount && task.workerCount > 0) {
                        task.workerCount--;
                    }
                    // Note: assignedTo field is not used for shared tasks since multiple creeps can work
                } else {
                    // Reset non-shared tasks to pending
                    task.status = TaskStatus.PENDING;
                }
                delete task.assignedTo;
            }

            if (shouldRemove) {
                tasksToRemove.push(id);
            }
        });

        tasksToRemove.forEach(id => {
            this.removeTask(room, id);
            removed++;
        });

        return removed;
    }

    /**
     * Release all tasks assigned to a specific creep
     */
    releaseCreepTasks(room: Room, creepName: string): void {
        const queue = room.memory.taskQueue;
        if (!queue) return;

        Object.values(queue.tasks).forEach(task => {
            if (task.assignedTo === creepName) {
                if (task.shared) {
                    // For shared tasks, decrement worker count
                    if (task.workerCount && task.workerCount > 0) {
                        task.workerCount--;
                    }
                } else {
                    // Reset non-shared tasks to pending
                    task.status = TaskStatus.PENDING;
                }
                delete task.assignedTo;
            }
        });
    }
}

// Singleton instance
const taskManagerInstance = new TaskManagerImpl();

/**
 * Task manager module export for game loop integration
 */
export const taskManagerModule = () => {
    // Run cleanup for each owned room
    Object.values(Game.rooms).forEach(room => {
        if (!room.controller?.my) return;

        taskManagerInstance.initQueue(room);
        const removed = taskManagerInstance.cleanup(room);

        // Debug logging every 100 ticks
        if (Game.time % 100 === 0) {
            const counts = taskManagerInstance.getTaskCounts(room);
            log.debug("TaskManager", `${room.name}: ${counts.pending} pending, ` +
                `${counts.assigned} assigned, ${counts.inProgress} in progress (removed ${removed})`);
        }
    });
};

// Export singleton for direct usage
export { taskManagerInstance as TaskManager };
