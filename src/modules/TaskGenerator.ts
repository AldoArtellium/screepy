/**
 * TaskGenerator - Scans rooms and creates tasks for the queue
 * Generates tasks based on room state and needs
 */

import {
    generateTaskId,
    getEffectivePriority,
    Task,
    TaskCategory,
    TaskStatus,
    TaskType
} from "../types/TaskTypes";
import { ENERGY_THRESHOLDS } from "../utils/creepUtils";
import { log } from "../utils/logger";

class TaskGenerator {
    /**
     * Generate tasks for a room
     */
    generateTasks(room: Room): void {
        if (!room.controller?.my) return;

        // Initialize task queue if needed
        if (!room.memory.taskQueue) {
            room.memory.taskQueue = [];
        }

        const defenseMode = room.memory.defenseMode ?? false;
        const phase = room.memory.phase ?? 0;

        // Clean up old tasks first
        this.cleanupTasks(room);

        // Generate tasks by category
        this.generateCombatTasks(room, defenseMode);
        this.generateTransportTasks(room, defenseMode, phase);
        this.generateHarvestTasks(room);
        this.generateBuildTasks(room);
        this.generateRepairTasks(room, defenseMode);
        this.generateUpgradeTasks(room);
    }

    /**
     * Clean up completed, failed, or expired tasks
     */
    private cleanupTasks(room: Room): void {
        const queue = room.memory.taskQueue;
        if (!queue) return;

        const now = Game.time;

        room.memory.taskQueue = queue.filter(task => {
            // Remove completed or failed tasks
            if (task.status === TaskStatus.COMPLETED ||
                task.status === TaskStatus.FAILED) {
                return false;
            }

            // Remove expired tasks
            if (task.expiresAt && now > task.expiresAt) {
                return false;
            }

            // Remove very old pending tasks (stale)
            if (task.status === TaskStatus.PENDING && now - task.createdAt > 500) {
                return false;
            }

            // Remove tasks for dead/invalid targets
            const target = Game.getObjectById(task.targetId as Id<any>);
            if (!target) {
                return false;
            }

            // Special checks for transport tasks - remove if target is full/empty
            if (task.type === TaskType.FILL_SPAWN ||
                task.type === TaskType.FILL_EXTENSION ||
                task.type === TaskType.FILL_TOWER) {
                const structure = target as StructureSpawn | StructureExtension | StructureTower;
                if (structure.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
                    return false;
                }
            }

            if (task.type === TaskType.WITHDRAW_CONTAINER ||
                task.type === TaskType.WITHDRAW_STORAGE) {
                const structure = target as StructureContainer | StructureStorage;
                if (structure.store.getUsedCapacity(RESOURCE_ENERGY) < ENERGY_THRESHOLDS.CONTAINER_MIN) {
                    return false;
                }
            }

            // Remove assigned tasks if assignee is dead
            if (task.assignedTo && !Game.creeps[task.assignedTo]) {
                task.status = TaskStatus.PENDING;
                delete task.assignedTo;
            }

            // Remove in-progress tasks that have been running too long (stuck)
            if (task.status === TaskStatus.IN_PROGRESS && now - task.createdAt > 300) {
                task.status = TaskStatus.PENDING;
                delete task.assignedTo;
            }

            return true;
        });
    }

    /**
     * Generate combat tasks for hostile creeps
     */
    private generateCombatTasks(room: Room, defenseMode: boolean): void {
        if (!defenseMode) return;

        const hostiles = room.find(FIND_HOSTILE_CREEPS);
        for (const hostile of hostiles) {
            if (this.hasExistingTask(room, TaskType.ATTACK_HOSTILE, hostile.id)) {
                continue;
            }

            this.addTask(room, {
                id: generateTaskId(TaskType.ATTACK_HOSTILE, hostile.id),
                type: TaskType.ATTACK_HOSTILE,
                category: TaskCategory.ATTACK,
                targetId: hostile.id,
                roomName: room.name,
                priority: getEffectivePriority(TaskType.ATTACK_HOSTILE, defenseMode),
                status: TaskStatus.PENDING,
                createdAt: Game.time,
                expiresAt: Game.time + 50
            });
        }
    }

    /**
     * Generate transport tasks for spawn, extensions, towers, storage
     */
    private generateTransportTasks(room: Room, defenseMode: boolean, phase: number): void {
        // Fill spawn (highest transport priority)
        const spawns = room.find(FIND_MY_SPAWNS, {
            filter: s => s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
        });
        for (const spawn of spawns) {
            if (this.hasExistingTask(room, TaskType.FILL_SPAWN, spawn.id)) continue;

            // Boost priority if spawn is empty
            const priorityBoost = spawn.store.getUsedCapacity(RESOURCE_ENERGY) === 0 ? -5 : 0;

            this.addTask(room, {
                id: generateTaskId(TaskType.FILL_SPAWN, spawn.id),
                type: TaskType.FILL_SPAWN,
                category: TaskCategory.TRANSPORT,
                targetId: spawn.id,
                roomName: room.name,
                priority: getEffectivePriority(TaskType.FILL_SPAWN, defenseMode) + priorityBoost,
                status: TaskStatus.PENDING,
                createdAt: Game.time,
                data: { amount: spawn.store.getFreeCapacity(RESOURCE_ENERGY) }
            });
        }

        // Fill extensions
        const extensions = room.find(FIND_MY_STRUCTURES, {
            filter: (s): s is StructureExtension =>
                s.structureType === STRUCTURE_EXTENSION &&
                s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
        });
        for (const ext of extensions) {
            if (this.hasExistingTask(room, TaskType.FILL_EXTENSION, ext.id)) continue;

            this.addTask(room, {
                id: generateTaskId(TaskType.FILL_EXTENSION, ext.id),
                type: TaskType.FILL_EXTENSION,
                category: TaskCategory.TRANSPORT,
                targetId: ext.id,
                roomName: room.name,
                priority: getEffectivePriority(TaskType.FILL_EXTENSION, defenseMode),
                status: TaskStatus.PENDING,
                createdAt: Game.time,
                data: { amount: ext.store.getFreeCapacity(RESOURCE_ENERGY) }
            });
        }

        // Fill towers (priority boost in defense mode or when low)
        const towers = room.find(FIND_MY_STRUCTURES, {
            filter: (s): s is StructureTower =>
                s.structureType === STRUCTURE_TOWER &&
                s.store.getFreeCapacity(RESOURCE_ENERGY) > 100
        });
        for (const tower of towers) {
            if (this.hasExistingTask(room, TaskType.FILL_TOWER, tower.id)) continue;

            // Boost priority if tower is below 50% or in defense mode
            const energyRatio = tower.store.getUsedCapacity(RESOURCE_ENERGY) / 1000;
            const priorityBoost = energyRatio < 0.5 ? -10 : 0;

            this.addTask(room, {
                id: generateTaskId(TaskType.FILL_TOWER, tower.id),
                type: TaskType.FILL_TOWER,
                category: TaskCategory.TRANSPORT,
                targetId: tower.id,
                roomName: room.name,
                priority: getEffectivePriority(TaskType.FILL_TOWER, defenseMode) + priorityBoost,
                status: TaskStatus.PENDING,
                createdAt: Game.time,
                data: { amount: tower.store.getFreeCapacity(RESOURCE_ENERGY) }
            });
        }

        // Pickup dropped resources (higher priority for larger amounts, decay urgency)
        const dropped = room.find(FIND_DROPPED_RESOURCES, {
            filter: r => r.resourceType === RESOURCE_ENERGY && r.amount > ENERGY_THRESHOLDS.DROPPED_MIN
        });
        for (const resource of dropped) {
            if (this.hasExistingTask(room, TaskType.PICKUP_RESOURCE, resource.id)) continue;

            // Priority boost for large amounts (urgent to collect before decay)
            const priorityBoost = resource.amount > 500 ? -10 : (resource.amount > 200 ? -5 : 0);

            this.addTask(room, {
                id: generateTaskId(TaskType.PICKUP_RESOURCE, resource.id),
                type: TaskType.PICKUP_RESOURCE,
                category: TaskCategory.TRANSPORT,
                targetId: resource.id,
                roomName: room.name,
                priority: getEffectivePriority(TaskType.PICKUP_RESOURCE, defenseMode) + priorityBoost,
                status: TaskStatus.PENDING,
                createdAt: Game.time,
                expiresAt: Game.time + 100,
                data: { amount: resource.amount }
            });
        }

        // Withdraw from containers
        const containers = room.find(FIND_STRUCTURES, {
            filter: (s): s is StructureContainer =>
                s.structureType === STRUCTURE_CONTAINER &&
                s.store.getUsedCapacity(RESOURCE_ENERGY) > ENERGY_THRESHOLDS.CONTAINER_MIN
        });
        for (const container of containers) {
            if (this.hasExistingTask(room, TaskType.WITHDRAW_CONTAINER, container.id)) continue;

            // Higher priority if container is nearly full (at mining capacity)
            const fillRatio = container.store.getUsedCapacity(RESOURCE_ENERGY) / container.store.getCapacity();
            const priorityBoost = fillRatio > 0.8 ? -5 : 0;

            this.addTask(room, {
                id: generateTaskId(TaskType.WITHDRAW_CONTAINER, container.id),
                type: TaskType.WITHDRAW_CONTAINER,
                category: TaskCategory.TRANSPORT,
                targetId: container.id,
                roomName: room.name,
                priority: getEffectivePriority(TaskType.WITHDRAW_CONTAINER, defenseMode) + priorityBoost,
                status: TaskStatus.PENDING,
                createdAt: Game.time,
                data: { amount: container.store.getUsedCapacity(RESOURCE_ENERGY) }
            });
        }

        // Withdraw from storage (phase 4+ when structures need energy)
        if (phase >= 4 && room.storage) {
            const storageEnergy = room.storage.store.getUsedCapacity(RESOURCE_ENERGY);
            const structuresNeedEnergy = spawns.length > 0 || extensions.length > 0 || towers.length > 0;

            // Create withdraw from storage if there's enough energy and structures need it
            if (structuresNeedEnergy && storageEnergy > ENERGY_THRESHOLDS.STORAGE_PULL) {
                if (!this.hasExistingTask(room, TaskType.WITHDRAW_STORAGE, room.storage.id)) {
                    this.addTask(room, {
                        id: generateTaskId(TaskType.WITHDRAW_STORAGE, room.storage.id),
                        type: TaskType.WITHDRAW_STORAGE,
                        category: TaskCategory.TRANSPORT,
                        targetId: room.storage.id,
                        roomName: room.name,
                        priority: getEffectivePriority(TaskType.WITHDRAW_STORAGE, defenseMode),
                        status: TaskStatus.PENDING,
                        createdAt: Game.time,
                        data: { amount: storageEnergy }
                    });
                }
            }

            // Fill storage if structures are satisfied and we have excess energy
            if (!structuresNeedEnergy && room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
                if (!this.hasExistingTask(room, TaskType.FILL_STORAGE, room.storage.id)) {
                    this.addTask(room, {
                        id: generateTaskId(TaskType.FILL_STORAGE, room.storage.id),
                        type: TaskType.FILL_STORAGE,
                        category: TaskCategory.TRANSPORT,
                        targetId: room.storage.id,
                        roomName: room.name,
                        priority: getEffectivePriority(TaskType.FILL_STORAGE, defenseMode),
                        status: TaskStatus.PENDING,
                        createdAt: Game.time
                    });
                }
            }
        }
    }

    /**
     * Generate harvest tasks for sources
     */
    private generateHarvestTasks(room: Room): void {
        const sources = room.find(FIND_SOURCES);
        const phase = room.memory.phase ?? 0;

        for (const source of sources) {
            // Check if source has available energy (or will soon regenerate)
            if (source.energy === 0 && source.ticksToRegeneration > 50) continue;

            // Count existing harvest tasks for this source
            const existingTasks = (room.memory.taskQueue ?? []).filter(
                t => t.type === TaskType.HARVEST_SOURCE &&
                     t.targetId === source.id &&
                     t.status !== TaskStatus.COMPLETED &&
                     t.status !== TaskStatus.FAILED
            );

            // Check if source has a container (static mining)
            const hasContainer = source.pos.findInRange(FIND_STRUCTURES, 1, {
                filter: s => s.structureType === STRUCTURE_CONTAINER
            }).length > 0;

            // For static mining (phase 1+), only need 1 miner per source
            // For early game (phase 0), allow multiple miners
            const maxMiners = (hasContainer || phase >= 1) ? 1 : this.getSourceAccessPositions(source);

            if (existingTasks.length >= maxMiners) continue;

            // Priority boost if source has lots of energy and no miner
            const priorityBoost = (source.energy > 2000 && existingTasks.length === 0) ? -5 : 0;

            this.addTask(room, {
                id: generateTaskId(TaskType.HARVEST_SOURCE, source.id),
                type: TaskType.HARVEST_SOURCE,
                category: TaskCategory.HARVEST,
                targetId: source.id,
                roomName: room.name,
                priority: getEffectivePriority(TaskType.HARVEST_SOURCE, false) + priorityBoost,
                status: TaskStatus.PENDING,
                createdAt: Game.time,
                data: {
                    targetPos: { x: source.pos.x, y: source.pos.y }
                }
            });
        }
    }

    /**
     * Count accessible positions around a source
     */
    private getSourceAccessPositions(source: Source): number {
        const terrain = source.room.getTerrain();
        let positions = 0;

        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;
                const x = source.pos.x + dx;
                const y = source.pos.y + dy;
                if (terrain.get(x, y) !== TERRAIN_MASK_WALL) {
                    positions++;
                }
            }
        }

        return positions;
    }

    /**
     * Generate build tasks for construction sites
     */
    private generateBuildTasks(room: Room): void {
        const sites = room.find(FIND_MY_CONSTRUCTION_SITES);

        for (const site of sites) {
            if (this.hasExistingTask(room, TaskType.BUILD_STRUCTURE, site.id)) continue;

            this.addTask(room, {
                id: generateTaskId(TaskType.BUILD_STRUCTURE, site.id),
                type: TaskType.BUILD_STRUCTURE,
                category: TaskCategory.BUILD,
                targetId: site.id,
                roomName: room.name,
                priority: getEffectivePriority(TaskType.BUILD_STRUCTURE, false),
                status: TaskStatus.PENDING,
                createdAt: Game.time,
                data: {
                    structureType: site.structureType,
                    amount: site.progressTotal - site.progress
                }
            });
        }
    }

    /**
     * Generate repair tasks for damaged structures
     */
    private generateRepairTasks(room: Room, defenseMode: boolean): void {
        // Regular structures (not walls/ramparts)
        const damagedStructures = room.find(FIND_STRUCTURES, {
            filter: s => {
                if (s.structureType === STRUCTURE_WALL ||
                    s.structureType === STRUCTURE_RAMPART) {
                    return false;
                }
                return s.hits < s.hitsMax * 0.8;
            }
        });

        for (const structure of damagedStructures) {
            if (this.hasExistingTask(room, TaskType.REPAIR_STRUCTURE, structure.id)) continue;

            this.addTask(room, {
                id: generateTaskId(TaskType.REPAIR_STRUCTURE, structure.id),
                type: TaskType.REPAIR_STRUCTURE,
                category: TaskCategory.REPAIR,
                targetId: structure.id,
                roomName: room.name,
                priority: getEffectivePriority(TaskType.REPAIR_STRUCTURE, defenseMode),
                status: TaskStatus.PENDING,
                createdAt: Game.time,
                data: {
                    structureType: structure.structureType,
                    amount: structure.hitsMax - structure.hits
                }
            });
        }

        // Ramparts (defense priority)
        const damagedRamparts = room.find(FIND_MY_STRUCTURES, {
            filter: (s): s is StructureRampart =>
                s.structureType === STRUCTURE_RAMPART &&
                s.hits < 10000 // Only repair low ramparts
        });

        for (const rampart of damagedRamparts) {
            if (this.hasExistingTask(room, TaskType.REPAIR_RAMPART, rampart.id)) continue;

            this.addTask(room, {
                id: generateTaskId(TaskType.REPAIR_RAMPART, rampart.id),
                type: TaskType.REPAIR_RAMPART,
                category: TaskCategory.REPAIR,
                targetId: rampart.id,
                roomName: room.name,
                priority: getEffectivePriority(TaskType.REPAIR_RAMPART, defenseMode),
                status: TaskStatus.PENDING,
                createdAt: Game.time,
                data: { amount: 10000 - rampart.hits }
            });
        }

        // Walls
        const damagedWalls = room.find(FIND_STRUCTURES, {
            filter: (s): s is StructureWall =>
                s.structureType === STRUCTURE_WALL &&
                s.hits < 10000 // Only repair low walls
        });

        for (const wall of damagedWalls) {
            if (this.hasExistingTask(room, TaskType.REPAIR_WALL, wall.id)) continue;

            this.addTask(room, {
                id: generateTaskId(TaskType.REPAIR_WALL, wall.id),
                type: TaskType.REPAIR_WALL,
                category: TaskCategory.REPAIR,
                targetId: wall.id,
                roomName: room.name,
                priority: getEffectivePriority(TaskType.REPAIR_WALL, defenseMode),
                status: TaskStatus.PENDING,
                createdAt: Game.time,
                data: { amount: 10000 - wall.hits }
            });
        }
    }

    /**
     * Generate upgrade controller tasks
     */
    private generateUpgradeTasks(room: Room): void {
        if (!room.controller?.my) return;

        const phase = room.memory.phase ?? 0;
        const controller = room.controller;

        // Create multiple upgrade tasks based on demand
        const existingTasks = (room.memory.taskQueue ?? []).filter(
            t => t.type === TaskType.UPGRADE_CONTROLLER &&
                 t.status !== TaskStatus.COMPLETED &&
                 t.status !== TaskStatus.FAILED
        );

        // Scale max upgraders with phase
        const maxUpgradersByPhase: Record<number, number> = {
            0: 1,  // Emergency - minimal upgrading
            1: 2,  // Bootstrap
            2: 3,  // Foundation
            3: 5,  // Expansion
            4: 6,  // Established
            5: 8,  // Advanced
            6: 10  // Dominant
        };
        const maxUpgraders = maxUpgradersByPhase[phase] ?? 3;

        if (existingTasks.length >= maxUpgraders) return;

        // Check for controller downgrade risk
        const ticksToDowngrade = controller.ticksToDowngrade ?? 20000;
        const downgradeRisk = ticksToDowngrade < 5000;

        // Priority boost if at risk of downgrade
        const priorityBoost = downgradeRisk ? -20 : 0;

        this.addTask(room, {
            id: generateTaskId(TaskType.UPGRADE_CONTROLLER, controller.id),
            type: TaskType.UPGRADE_CONTROLLER,
            category: TaskCategory.UPGRADE,
            targetId: controller.id,
            roomName: room.name,
            priority: getEffectivePriority(TaskType.UPGRADE_CONTROLLER, false) + priorityBoost,
            status: TaskStatus.PENDING,
            createdAt: Game.time
        });
    }

    /**
     * Check if a task already exists for a target
     */
    private hasExistingTask(room: Room, type: TaskType, targetId: string): boolean {
        const queue = room.memory.taskQueue ?? [];
        return queue.some(
            t => t.type === type &&
                 t.targetId === targetId &&
                 t.status !== TaskStatus.COMPLETED &&
                 t.status !== TaskStatus.FAILED
        );
    }

    /**
     * Add a task to the queue
     */
    private addTask(room: Room, task: Task): void {
        if (!room.memory.taskQueue) {
            room.memory.taskQueue = [];
        }
        room.memory.taskQueue.push(task);
    }

    /**
     * Get task queue for a room
     */
    getTaskQueue(room: Room): Task[] {
        return room.memory.taskQueue ?? [];
    }

    /**
     * Get pending tasks sorted by priority
     */
    getPendingTasks(room: Room): Task[] {
        return this.getTaskQueue(room)
            .filter(t => t.status === TaskStatus.PENDING)
            .sort((a, b) => a.priority - b.priority);
    }
}

// Singleton instance
const taskGeneratorInstance = new TaskGenerator();

export const taskGeneratorModule = () => {
    for (const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if (!room.controller?.my) continue;

        taskGeneratorInstance.generateTasks(room);
    }
};

export const taskGenerator = taskGeneratorInstance;
