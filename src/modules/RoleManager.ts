/**
 * RoleManager - Creep Dispatch Module
 * Integrates the hybrid role-task system:
 * - Strict roles: Always follow role logic (miner, defender, claimer)
 * - Task-driven roles: All work from task queue (hauler)
 * - Flexible roles: Accept tasks when idle, fallback to role behavior
 */

import { getRoleConfig } from "../config/roleTaskConfig";
import { TASK_TYPE_TO_CATEGORY } from "../types/TaskTypes";
import { idleNearSpawn } from "../utils/creepUtils";
import { log } from "../utils/logger";
import Builder from "./roles/Builder";
import Claimer from "./roles/Claimer";
import Defender from "./roles/Defender";
import Harvester from "./roles/Harvester";
import Hauler from "./roles/Hauler";
import Miner from "./roles/Miner";
import Upgrader from "./roles/Upgrader";
import { TaskDispatcher } from "./TaskDispatcher";
import { TaskManager } from "./TaskManager";

/**
 * Role handlers map
 */
const roleHandlers: { [role: string]: { run: (creep: Creep) => void } } = {
    harvester: Harvester,
    builder: Builder,
    upgrader: Upgrader,
    defender: Defender,
    hauler: Hauler,
    claimer: Claimer,
    miner: Miner
};

export const roleManagerModule = () => {
    _.forEach(Game.creeps, (creep) => {
        if (creep.spawning) return;

        // Default undefined roles to harvester
        const role = creep.memory.role || "harvester";
        if (!creep.memory.role) {
            creep.memory.role = "harvester";
        }

        const config = getRoleConfig(role);
        const handler = roleHandlers[role];

        if (!handler) {
            log.error("RoleManager", "Unhandled role:", role);
            return;
        }

        // Strict roles: Always run role logic, never accept tasks
        if (config.flexibility === "strict") {
            handler.run(creep);
            return;
        }

        // Has an active task? Execute it
        if (creep.memory.task?.id) {
            const result = TaskDispatcher.executeTask(creep);

            if (result === "continue") {
                // Task is ongoing, continue next tick
                return;
            }

            // Task completed or failed - track completion info before clearing
            const completedTaskId = creep.memory.task?.id;
            if (completedTaskId) {
                const task = TaskManager.getTask(creep.room, completedTaskId);
                if (task) {
                    creep.memory.lastTaskCategory = TASK_TYPE_TO_CATEGORY[task.type];
                }
            }
            creep.memory.lastTaskCompleted = Game.time;
            delete creep.memory.task;
            delete creep.memory.state;

            // For task-driven roles, try to get another task immediately
            if (config.flexibility === "task-driven") {
                if (TaskDispatcher.assignTask(creep)) {
                    TaskDispatcher.executeTask(creep);
                    return;
                }
                // No task available, idle
                idleNearSpawn(creep);
                return;
            }

            // For flexible roles, fall through to try getting a new task or fallback
        }

        // Try to get a new task
        if (TaskDispatcher.assignTask(creep)) {
            TaskDispatcher.executeTask(creep);
            return;
        }

        // Task-driven roles: Idle if no tasks available
        if (config.flexibility === "task-driven") {
            idleNearSpawn(creep);
            return;
        }

        // Flexible roles: Fallback to role behavior when no tasks available
        handler.run(creep);
    });
};
