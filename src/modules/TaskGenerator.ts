/**
 * TaskGenerator - Task Creation Module
 * Scans rooms for needs and creates tasks for the task queue.
 */

import { createTask, TASK_BASE_PRIORITIES, TaskType } from "../types/TaskTypes";
import { log } from "../utils/logger";
import { TaskManager } from "./TaskManager";

/**
 * Minimum generation interval to prevent CPU spikes
 */
const MIN_GENERATION_INTERVAL = 5;

/**
 * Defense mode priority boost for tower filling
 */
const DEFENSE_TOWER_BOOST = -20;

/**
 * Minimum dropped resource amount to create pickup task
 */
const MIN_PICKUP_AMOUNT = 50;

/**
 * Minimum container energy to create withdraw task
 */
const MIN_CONTAINER_ENERGY = 100;

/**
 * Wall/rampart repair threshold
 */
const WALL_REPAIR_THRESHOLD = 10000;

/**
 * Normal structure repair threshold (percentage)
 */
const REPAIR_THRESHOLD_PCT = 0.8;

class TaskGeneratorImpl {
    /**
     * Generate tasks for a room
     */
    generate(room: Room): number {
        if (!room.controller?.my) return 0;

        // Ensure queue is initialized
        TaskManager.initQueue(room);

        // Check generation interval
        const queue = room.memory.taskQueue!;
        if (Game.time - queue.lastGeneration < MIN_GENERATION_INTERVAL) {
            return 0;
        }
        queue.lastGeneration = Game.time;

        let tasksAdded = 0;
        const phase = room.memory.phase ?? 0;
        const defenseMode = room.memory.defenseMode ?? false;

        // Generate transport tasks
        tasksAdded += this.generateFillTasks(room, defenseMode);
        tasksAdded += this.generatePickupTasks(room);
        tasksAdded += this.generateWithdrawTasks(room, phase);

        // Generate build/repair tasks
        tasksAdded += this.generateBuildTasks(room, phase, defenseMode);
        tasksAdded += this.generateRepairTasks(room, defenseMode);

        // Generate upgrade task (always available, low priority)
        tasksAdded += this.generateUpgradeTasks(room);

        return tasksAdded;
    }

    /**
     * Generate FILL_SPAWN, FILL_EXTENSION, FILL_TOWER tasks
     */
    private generateFillTasks(room: Room, defenseMode: boolean): number {
        let added = 0;

        // Find spawns needing energy
        const spawns = room.find(FIND_MY_SPAWNS, {
            filter: s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
        });

        spawns.forEach(spawn => {
            const task = createTask(
                TaskType.FILL_SPAWN,
                spawn.id,
                spawn.pos,
                {
                    amount: spawn.store.getFreeCapacity(RESOURCE_ENERGY),
                    resourceType: RESOURCE_ENERGY,
                    expiresIn: 50
                }
            );
            if (TaskManager.addTask(room, task)) added++;
        });

        // Find extensions needing energy
        const extensions = room.find(FIND_MY_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_EXTENSION &&
                        s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
        }) as StructureExtension[];

        extensions.forEach(ext => {
            const task = createTask(
                TaskType.FILL_EXTENSION,
                ext.id,
                ext.pos,
                {
                    amount: ext.store.getFreeCapacity(RESOURCE_ENERGY),
                    resourceType: RESOURCE_ENERGY,
                    expiresIn: 50
                }
            );
            if (TaskManager.addTask(room, task)) added++;
        });

        // Find towers needing energy
        const towers = room.find(FIND_MY_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_TOWER &&
                        s.store.getFreeCapacity(RESOURCE_ENERGY) > 100
        }) as StructureTower[];

        towers.forEach(tower => {
            const basePriority = TASK_BASE_PRIORITIES[TaskType.FILL_TOWER];
            const priority = defenseMode ? basePriority + DEFENSE_TOWER_BOOST : basePriority;

            const task = createTask(
                TaskType.FILL_TOWER,
                tower.id,
                tower.pos,
                {
                    priority,
                    amount: tower.store.getFreeCapacity(RESOURCE_ENERGY),
                    resourceType: RESOURCE_ENERGY,
                    expiresIn: 50
                }
            );
            if (TaskManager.addTask(room, task)) added++;
        });

        return added;
    }

    /**
     * Generate PICKUP_RESOURCE tasks for dropped resources
     */
    private generatePickupTasks(room: Room): number {
        let added = 0;

        const droppedResources = room.find(FIND_DROPPED_RESOURCES, {
            filter: r => r.resourceType === RESOURCE_ENERGY && r.amount >= MIN_PICKUP_AMOUNT
        });

        droppedResources.forEach(resource => {
            const task = createTask(
                TaskType.PICKUP_RESOURCE,
                resource.id,
                resource.pos,
                {
                    amount: resource.amount,
                    resourceType: resource.resourceType,
                    expiresIn: Math.min(resource.amount, 100) // Decay consideration
                }
            );
            if (TaskManager.addTask(room, task)) added++;
        });

        return added;
    }

    /**
     * Generate WITHDRAW_CONTAINER and WITHDRAW_STORAGE tasks
     */
    private generateWithdrawTasks(room: Room, phase: number): number {
        let added = 0;

        // Find containers with energy
        const containers = room.find(FIND_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_CONTAINER &&
                        s.store.getUsedCapacity(RESOURCE_ENERGY) >= MIN_CONTAINER_ENERGY
        }) as StructureContainer[];

        containers.forEach(container => {
            const task = createTask(
                TaskType.WITHDRAW_CONTAINER,
                container.id,
                container.pos,
                {
                    amount: container.store.getUsedCapacity(RESOURCE_ENERGY),
                    resourceType: RESOURCE_ENERGY,
                    expiresIn: 100
                }
            );
            if (TaskManager.addTask(room, task)) added++;
        });

        // Phase 4+: Create withdraw from storage task if storage has energy
        if (phase >= 4 && room.storage && room.storage.store.getUsedCapacity(RESOURCE_ENERGY) > 5000) {
            const task = createTask(
                TaskType.WITHDRAW_STORAGE,
                room.storage.id,
                room.storage.pos,
                {
                    amount: Math.min(room.storage.store.getUsedCapacity(RESOURCE_ENERGY), 2000),
                    resourceType: RESOURCE_ENERGY,
                    expiresIn: 50
                }
            );
            if (TaskManager.addTask(room, task)) added++;
        }

        return added;
    }

    /**
     * Generate BUILD_STRUCTURE tasks
     * Marked as shared so multiple builders can work on the same site
     */
    private generateBuildTasks(room: Room, phase: number, defenseMode: boolean): number {
        let added = 0;

        const sites = room.find(FIND_MY_CONSTRUCTION_SITES);

        sites.forEach(site => {
            // In defense mode, prioritize ramparts/walls construction
            let priorityBoost = 0;
            if (defenseMode) {
                if (site.structureType === STRUCTURE_RAMPART || site.structureType === STRUCTURE_WALL) {
                    priorityBoost = -15;
                }
            }

            // Phase-based priority adjustments
            if (phase <= 1 && site.structureType === STRUCTURE_CONTAINER) {
                priorityBoost = -10; // Containers are critical in early phases
            } else if (phase >= 2 && site.structureType === STRUCTURE_EXTENSION) {
                priorityBoost = -5; // Extensions important in foundation phase
            }

            const task = createTask(
                TaskType.BUILD_STRUCTURE,
                site.id,
                site.pos,
                {
                    priority: TASK_BASE_PRIORITIES[TaskType.BUILD_STRUCTURE] + priorityBoost,
                    amount: site.progressTotal - site.progress,
                    expiresIn: 200,
                    shared: true,
                    maxWorkers: 3
                }
            );
            if (TaskManager.addTask(room, task)) added++;
        });

        return added;
    }

    /**
     * Generate REPAIR_STRUCTURE, REPAIR_WALL, REPAIR_RAMPART tasks
     */
    private generateRepairTasks(room: Room, defenseMode: boolean): number {
        let added = 0;

        // Find damaged structures (not walls/ramparts)
        const damagedStructures = room.find(FIND_STRUCTURES, {
            filter: s => s.structureType !== STRUCTURE_WALL &&
                        s.structureType !== STRUCTURE_RAMPART &&
                        s.hits < s.hitsMax * REPAIR_THRESHOLD_PCT &&
                        s.structureType !== STRUCTURE_ROAD // Roads are low priority
        });

        damagedStructures.forEach(structure => {
            const task = createTask(
                TaskType.REPAIR_STRUCTURE,
                structure.id,
                structure.pos,
                {
                    amount: structure.hitsMax - structure.hits,
                    expiresIn: 100
                }
            );
            if (TaskManager.addTask(room, task)) added++;
        });

        // Find damaged roads (lower priority)
        const damagedRoads = room.find(FIND_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_ROAD &&
                        s.hits < s.hitsMax * 0.5 // Roads only at 50%
        });

        damagedRoads.forEach(road => {
            const task = createTask(
                TaskType.REPAIR_STRUCTURE,
                road.id,
                road.pos,
                {
                    priority: TASK_BASE_PRIORITIES[TaskType.REPAIR_STRUCTURE] + 20, // Lower priority
                    amount: road.hitsMax - road.hits,
                    expiresIn: 200
                }
            );
            if (TaskManager.addTask(room, task)) added++;
        });

        // Find walls/ramparts needing repair
        // Marked as shared so multiple creeps can repair the same structure
        const wallsAndRamparts = room.find(FIND_STRUCTURES, {
            filter: s => (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) &&
                        s.hits < WALL_REPAIR_THRESHOLD
        });

        wallsAndRamparts.forEach(structure => {
            const taskType = structure.structureType === STRUCTURE_WALL ?
                TaskType.REPAIR_WALL : TaskType.REPAIR_RAMPART;

            // In defense mode, ramparts have higher priority
            let priorityBoost = 0;
            if (defenseMode && structure.structureType === STRUCTURE_RAMPART) {
                priorityBoost = -30;
            }

            const task = createTask(
                taskType,
                structure.id,
                structure.pos,
                {
                    priority: TASK_BASE_PRIORITIES[taskType] + priorityBoost,
                    amount: WALL_REPAIR_THRESHOLD - structure.hits,
                    expiresIn: 200,
                    shared: true,
                    maxWorkers: 2
                }
            );
            if (TaskManager.addTask(room, task)) added++;
        });

        return added;
    }

    /**
     * Generate UPGRADE_CONTROLLER task (always available, low priority background task)
     * Marked as shared so multiple upgraders can work simultaneously
     */
    private generateUpgradeTasks(room: Room): number {
        if (!room.controller?.my) return 0;

        const task = createTask(
            TaskType.UPGRADE_CONTROLLER,
            room.controller.id,
            room.controller.pos,
            {
                expiresIn: 100,
                shared: true,
                maxWorkers: 5
            }
        );

        return TaskManager.addTask(room, task) ? 1 : 0;
    }
}

// Singleton instance
const taskGeneratorInstance = new TaskGeneratorImpl();

/**
 * Task generator module export for game loop integration
 */
export const taskGeneratorModule = () => {
    Object.values(Game.rooms).forEach(room => {
        if (!room.controller?.my) return;

        const tasksAdded = taskGeneratorInstance.generate(room);

        // Debug logging every 100 ticks
        if (Game.time % 100 === 0 && tasksAdded > 0) {
            log.debug("TaskGenerator", `${room.name}: Generated ${tasksAdded} tasks`);
        }
    });
};

// Export singleton for direct usage
export { taskGeneratorInstance as TaskGenerator };
