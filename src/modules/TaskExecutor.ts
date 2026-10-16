/**
 * TaskExecutor - Executes tasks for all creeps
 * Handles the actual work of moving to targets and performing actions
 */

import { TaskStatus, TaskType, requiresEnergy } from "../types/TaskTypes";
import { log } from "../utils/logger";
import { countStat } from "../utils/stats";
import { getRoleHandler } from "../roles/registry";
import { logistics, NEED_PRIORITY } from "../logistics/LogisticsNetwork";
import { runHaul } from "../logistics/haul";
import { LogisticsTarget } from "../logistics/types";
import { BodyType } from "../config/bodyTypes";
import { metricsCollector } from "./MetricsCollector";
import { taskDispatcher } from "./TaskDispatcher";
import { trafficManager } from "./TrafficManager";

/** Maximum ticks a creep can be stuck before task is marked failed */
const MAX_STUCK_TICKS = 10;

/** Maximum ticks without any successful action before a task times out */
const MAX_TASK_TICKS = 300;

class TaskExecutor {
    /**
     * Execute tasks for all creeps
     */
    executeTasks(): void {
        for (const name in Game.creeps) {
            const creep = Game.creeps[name];
            if (creep.spawning) continue;

            if (creep.memory.role) {
                this.runRole(creep, creep.memory.role);
            } else if (creep.memory.bodyType === BodyType.TRANSPORT) {
                if (!runHaul(creep)) this.handleIdleCreep(creep);
            } else if (this.haulForSpawn(creep)) {
                // worker filling spawn/extensions; its task (if any) resumes afterwards
            } else if (creep.memory.currentTask) {
                this.executeCreepTask(creep);
            } else {
                // A task creep without task holds no energy claim
                if (creep.memory.logistics?.kind === "offer") logistics.release(creep);
                this.handleIdleCreep(creep);
            }
        }
    }

    /**
     * Workers fill the spawn and extensions when haulers don't cover them (early game, haulers dead).
     * A worker never drops a task in progress: it only switches when it has no task or is about
     * to fetch energy, and only as many workers switch as the missing energy needs.
     * Returns true while the creep is hauling this tick.
     */
    private haulForSpawn(creep: Creep): boolean {
        if (creep.getActiveBodyparts(CARRY) === 0) return false;
        const maxPriority = NEED_PRIORITY.EXTENSION;

        if (!creep.memory.hauling) {
            const task = creep.memory.currentTask;
            if (task && task.state !== "acquiring") return false;
            if (!this.spawnNeedsMoreHaulers(creep.room, maxPriority)) return false;
            if (creep.memory.logistics?.kind === "offer") logistics.release(creep);
            creep.memory.hauling = true;
        }

        if (runHaul(creep, { maxPriority })) return true;

        // Nothing left to fetch or deliver
        delete creep.memory.hauling;
        return false;
    }

    /** Missing spawn/extension energy exceeds what switched-but-unreserved workers will carry */
    private spawnNeedsMoreHaulers(room: Room, maxPriority: number): boolean {
        const missing = logistics.uncoveredNeedAmount(room, maxPriority);
        if (missing <= 0) return false;
        const incoming = _.sum(
            room.find(FIND_MY_CREEPS, { filter: c => c.memory.hauling && c.memory.logistics?.kind !== "need" }),
            c => c.store.getCapacity(RESOURCE_ENERGY)
        );
        return missing > incoming;
    }

    /**
     * Run a module-driven creep through its role handler (isolated: one failing creep doesn't stop the others)
     */
    private runRole(creep: Creep, role: string): void {
        const handler = getRoleHandler(role);
        if (!handler) {
            this.handleIdleCreep(creep);
            return;
        }
        try {
            handler(creep);
        } catch (error) {
            log.error("TaskExecutor", `Role ${role} failed for ${creep.name}:`, (error as Error).stack);
            countStat(`roleError:${role}`);
        }
    }

    /**
     * Execute a creep's current task
     */
    private executeCreepTask(creep: Creep): void {
        const taskState = creep.memory.currentTask;
        if (!taskState) return;

        // For cross-room creeps, look up task in target room
        const taskRoom = creep.memory.targetRoom
            ? Game.rooms[creep.memory.targetRoom]
            : creep.room;

        if (!taskRoom) {
            // Target room not visible - move towards it
            if (creep.memory.targetRoom) {
                this.moveToRoom(creep, creep.memory.targetRoom);
            }
            return;
        }

        const task = taskDispatcher.getTaskById(taskRoom, taskState.taskId);

        // Task no longer exists or completed
        if (!task || task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED) {
            this.clearCreepTask(creep);
            return;
        }

        // Check for task timeout (no successful action for too long)
        if (Game.time - (taskState.lastProgress ?? taskState.startedAt) > MAX_TASK_TICKS) {
            log.debug("TaskExecutor", `Task ${task.type} timed out for ${creep.name}`);
            this.failTask(creep, task, "timeout");
            return;
        }

        // Check for stuck creep (wanted to move last ticks but position didn't change)
        taskState.stuckTicks = trafficManager.getStuckTicks(creep);
        if (taskState.stuckTicks >= MAX_STUCK_TICKS) {
            log.debug("TaskExecutor", `Creep ${creep.name} stuck on task ${task.type}`);
            this.failTask(creep, task, "stuck");
            return;
        }

        // Update task status to in progress
        if (task.status === TaskStatus.ASSIGNED) {
            task.status = TaskStatus.IN_PROGRESS;
        }

        // Handle state transitions for energy-based tasks
        if (requiresEnergy(task.type)) {
            if (taskState.state === "acquiring" && creep.store.getFreeCapacity() === 0) {
                creep.memory.currentTask!.state = "executing";
                logistics.release(creep);
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
     * Record a creep action result: any successful action counts as task progress (resets the timeout)
     */
    private act<T extends ScreepsReturnCode>(creep: Creep, result: T): T {
        if (result === OK && creep.memory.currentTask) {
            creep.memory.currentTask.lastProgress = Game.time;
        }
        return result;
    }

    /**
     * Register movement towards a position, or an intent to stay in range when already there.
     * Must be called every tick by working creeps so the traffic reconciler doesn't shove them away.
     * Returns true when the creep is in range.
     */
    private approach(
        creep: Creep,
        pos: RoomPosition,
        range: number,
        opts: { priority?: number; combat?: boolean } = {}
    ): boolean {
        trafficManager.requestMove(creep, pos, { ...opts, range });
        return creep.pos.roomName === pos.roomName && creep.pos.inRangeTo(pos, range);
    }

    /**
     * Get the room where a creep's task exists
     */
    private getTaskRoom(creep: Creep): Room | undefined {
        return creep.memory.targetRoom
            ? Game.rooms[creep.memory.targetRoom]
            : creep.room;
    }

    /**
     * Mark a task as failed and clear creep assignment
     */
    private failTask(creep: Creep, task: { id: string; type: TaskType }, reason: string): void {
        const taskState = creep.memory.currentTask;
        const retryCount = taskState?.retryCount ?? 0;

        // Allow up to 2 retries
        if (retryCount < 2) {
            log.debug("TaskExecutor", `Retrying task ${task.type} for ${creep.name} (attempt ${retryCount + 1})`);
            creep.memory.currentTask = {
                ...taskState!,
                stuckTicks: 0,
                retryCount: retryCount + 1,
                startedAt: Game.time,
                lastProgress: Game.time
            };
            return;
        }

        log.warn("TaskExecutor", `Task ${task.type} failed for ${creep.name} after ${retryCount + 1} attempts`);
        countStat("taskFailed");
        countStat(`taskFailed:${task.type}:${reason}`);
        const taskRoom = this.getTaskRoom(creep);
        if (taskRoom) {
            taskDispatcher.updateTaskStatus(taskRoom, task.id, TaskStatus.FAILED);
        }
        delete creep.memory.currentTask;
    }

    /**
     * Acquire energy for a task through the logistics network (offers with reservations).
     * Fallback: harvest at a source that still has a free tile (cached in energySourceId).
     */
    private acquireEnergy(creep: Creep): void {
        const taskState = creep.memory.currentTask!;

        // Ongoing reservation: go take it
        if (creep.memory.logistics?.kind === "offer") {
            const target = logistics.getTarget(creep);
            if (target) {
                this.takeEnergy(creep, target);
                return;
            }
        }

        const offer = logistics.claimOffer(creep, { forUpgrade: taskState.type === TaskType.UPGRADE_CONTROLLER });
        if (offer) {
            delete taskState.energySourceId;
            const target = logistics.getTarget(creep);
            if (target) this.takeEnergy(creep, target);
            return;
        }

        // Last resort: harvest directly (only with WORK parts)
        let source = taskState.energySourceId
            ? Game.getObjectById(taskState.energySourceId as Id<Source>)
            : null;
        if (!source || source.energy === 0) {
            source = this.findHarvestSource(creep);
            taskState.energySourceId = source?.id;
        }
        if (source) {
            this.moveToAndHarvest(creep, source);
            return;
        }

        // Nothing available - wait near spawn for energy to become available
        this.handleIdleCreep(creep);
    }

    /**
     * Withdraw or pick up the reserved energy, then release the reservation
     */
    private takeEnergy(creep: Creep, target: LogisticsTarget): void {
        if (!this.approach(creep, target.pos, 1)) return;
        if (target instanceof Resource) {
            this.act(creep, creep.pickup(target));
        } else {
            this.act(creep, creep.withdraw(target as AnyStoreStructure, RESOURCE_ENERGY));
        }
        logistics.release(creep);
    }

    /**
     * Closest active source with a free tile. Sources whose container is occupied by a static
     * miner are skipped: their energy is taken from the container (logistics offer).
     * Without the free-tile check every creep picks the closest source; once its few walkable
     * tiles are taken, the others get ERR_NO_PATH forever (seen on W7N3: ~8000 failed moves/run).
     */
    private findHarvestSource(creep: Creep): Source | null {
        if (creep.getActiveBodyparts(WORK) === 0) return null;
        const sources = creep.room.find(FIND_SOURCES_ACTIVE)
            .filter(s => this.harvestSlotsLeft(s, creep) > 0 && !this.hasMinedContainer(s))
            .sort((a, b) => creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b));
        return sources[0] ?? null;
    }

    private hasMinedContainer(source: Source): boolean {
        return source.pos.findInRange(FIND_STRUCTURES, 1, {
            filter: s => s.structureType === STRUCTURE_CONTAINER &&
                s.pos.lookFor(LOOK_CREEPS).some(c => c.memory.bodyType === BodyType.MINER)
        }).length > 0;
    }

    /**
     * Walkable tiles around a source minus creeps already harvesting there or heading to it
     * (harvest tasks and energy acquisition). The asking creep itself doesn't count.
     */
    private harvestSlotsLeft(source: Source, creep: Creep): number {
        const terrain = source.room.getTerrain();
        let slots = 0;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if ((dx || dy) && terrain.get(source.pos.x + dx, source.pos.y + dy) !== TERRAIN_MASK_WALL) slots++;
            }
        }

        const users = source.room.find(FIND_MY_CREEPS, {
            filter: c => c.name !== creep.name && (
                c.memory.currentTask?.energySourceId === source.id ||
                (c.memory.currentTask?.type === TaskType.HARVEST_SOURCE && c.memory.currentTask.targetId === source.id)
            )
        }).length;
        return slots - users;
    }

    /**
     * Execute the main task action
     */
    private executeTask(creep: Creep, task: { type: TaskType; targetId: string; roomName: string }): void {
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
            case TaskType.FILL_STORAGE: {
                type DeliverTarget = StructureSpawn | StructureExtension | StructureTower | StructureStorage;
                this.executeDeliver(creep, target as DeliverTarget);
                break;
            }

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

            case TaskType.CLAIM_ROOM:
            case TaskType.RESERVE_ROOM:
                this.executeClaimOrReserve(creep, task.type, task.roomName);
                break;

            case TaskType.RECYCLE_CREEP:
                this.executeRecycle(creep, target as StructureSpawn);
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

        // Only one creep fits on the container: others harvest from an adjacent tile
        const containerTaken = container && container.pos.lookFor(LOOK_CREEPS).some(c => c.name !== creep.name);

        if (container && !containerTaken) {
            // Stand on container to harvest (static mining)
            if (!this.approach(creep, container.pos, 0, { priority: 5 })) return;

            // Harvest and transfer to container
            const harvestResult = this.act(creep, creep.harvest(source));
            if (harvestResult === OK) {
                // Track energy harvested (2 energy per WORK part per tick)
                const workParts = creep.getActiveBodyparts(WORK);
                metricsCollector.recordEnergyHarvested(creep.room.name, workParts * 2);
            }
            if (creep.store.getFreeCapacity() === 0) {
                this.act(creep, creep.transfer(container, RESOURCE_ENERGY));
            }
        } else if (containerSite && !containerSite.pos.lookFor(LOOK_CREEPS).some(c => c.name !== creep.name)) {
            // Stand on construction site while waiting
            if (!this.approach(creep, containerSite.pos, 0, { priority: 5 })) return;

            // Harvest and drop on site (will be picked up after container built)
            if (creep.pos.isNearTo(source)) {
                const harvestResult = this.act(creep, creep.harvest(source));
                if (harvestResult === OK) {
                    const workParts = creep.getActiveBodyparts(WORK);
                    metricsCollector.recordEnergyHarvested(creep.room.name, workParts * 2);
                }
                if (creep.store.getFreeCapacity() === 0) {
                    creep.drop(RESOURCE_ENERGY);
                }
            }
        } else {
            // No container - find best position adjacent to source
            if (this.approach(creep, source.pos, 1)) {
                const harvestResult = this.act(creep, creep.harvest(source));
                if (harvestResult === OK) {
                    const workParts = creep.getActiveBodyparts(WORK);
                    metricsCollector.recordEnergyHarvested(creep.room.name, workParts * 2);
                }

                // Drop energy when full (haulers will pick up). Creeps without CARRY drop as they harvest.
                if (creep.store.getCapacity() > 0 && creep.store.getFreeCapacity() === 0) {
                    creep.drop(RESOURCE_ENERGY);

                    // In early game (Phase 0-1, no container), release worker for other tasks
                    // This allows flexible workers to cycle between harvesting and upgrading
                    const phase = creep.room.memory.phase ?? 0;
                    if (phase <= 1) {
                        this.completeTask(creep);
                        return;
                    }
                }
            }
        }
    }

    /**
     * Execute delivery task
     */
    private executeDeliver(
        creep: Creep,
        target: StructureSpawn | StructureExtension | StructureTower | StructureStorage
    ): void {
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

        if (this.approach(creep, target.pos, 1)) {
            const result = this.act(creep, creep.transfer(target, RESOURCE_ENERGY));
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
        }
    }

    /**
     * Execute pickup task
     */
    private executePickup(creep: Creep, resource: Resource): void {
        if (this.approach(creep, resource.pos, 1)) {
            const result = this.act(creep, creep.pickup(resource));
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

        if (this.approach(creep, target.pos, 1)) {
            const result = this.act(creep, creep.withdraw(target, RESOURCE_ENERGY));
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
        }
    }

    /**
     * Execute build task
     */
    private executeBuild(creep: Creep, site: ConstructionSite): void {
        if (this.approach(creep, site.pos, 3)) {
            const result = this.act(creep, creep.build(site));
            if (result === ERR_NOT_ENOUGH_RESOURCES) {
                creep.memory.currentTask!.state = "acquiring";
            }
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

        if (this.approach(creep, structure.pos, 3)) {
            const result = this.act(creep, creep.repair(structure));
            if (result === ERR_NOT_ENOUGH_RESOURCES) {
                if (creep.memory.currentTask) {
                    creep.memory.currentTask.state = "acquiring";
                }
            }
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
        if (this.approach(creep, controller.pos, 3)) {
            const result = this.act(creep, creep.upgradeController(controller));
            if (result === ERR_NOT_ENOUGH_RESOURCES) {
                creep.memory.currentTask!.state = "acquiring";
            }
        }
    }

    /**
     * Execute attack task
     */
    private executeAttack(creep: Creep, target: Creep): void {
        if (this.approach(creep, target.pos, 1)) {
            this.act(creep, creep.attack(target));
        }
    }

    /**
     * Execute rampart defense task
     * Move to rampart and attack any adjacent hostiles
     */
    private executeDefendRampart(creep: Creep, rampart: StructureRampart): void {
        // Move to rampart position
        this.approach(creep, rampart.pos, 0, { combat: true, priority: 0 });

        // Attack any adjacent hostiles
        const hostile = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1)[0];
        if (hostile) {
            this.act(creep, creep.attack(hostile));
        }

        // Also use ranged attack if available
        const rangedHostile = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 3)[0];
        if (rangedHostile && creep.getActiveBodyparts(RANGED_ATTACK) > 0) {
            if (creep.pos.getRangeTo(rangedHostile) === 1) {
                creep.rangedMassAttack();
            } else {
                this.act(creep, creep.rangedAttack(rangedHostile));
            }
        }

        // Complete task if no more hostiles in room
        const hostiles = creep.room.find(FIND_HOSTILE_CREEPS);
        if (hostiles.length === 0) {
            this.completeTask(creep);
        }
    }

    /**
     * Execute claim or reserve task
     * Handles cross-room movement and controller interaction
     */
    private executeClaimOrReserve(creep: Creep, taskType: TaskType, targetRoomName: string): void {
        // Cross-room movement if not in target room
        if (creep.room.name !== targetRoomName) {
            this.moveToRoom(creep, targetRoomName);
            return;
        }

        // Find the controller
        const controller = creep.room.controller;
        if (!controller) {
            log.warn("TaskExecutor", `No controller in ${targetRoomName} for claim/reserve`);
            this.completeTask(creep);
            return;
        }

        // Move to controller if not in range
        if (!this.approach(creep, controller.pos, 1)) return;

        // Execute the action
        if (taskType === TaskType.CLAIM_ROOM) {
            const result = this.act(creep, creep.claimController(controller));
            if (result === OK) {
                log.info("TaskExecutor", `Claimed controller in ${targetRoomName}`);
                this.completeTask(creep);
            } else if (result === ERR_GCL_NOT_ENOUGH) {
                log.warn("TaskExecutor", `GCL not enough to claim ${targetRoomName}`);
                this.completeTask(creep);
            } else if (result === ERR_INVALID_TARGET) {
                // Already owned or reserved by enemy
                log.warn("TaskExecutor", `Cannot claim ${targetRoomName}: invalid target`);
                this.completeTask(creep);
            }
        } else {
            // RESERVE_ROOM
            const result = this.act(creep, creep.reserveController(controller));
            if (result === OK) {
                // Keep reserving until creep dies or task expires
                // Don't complete the task - reservation needs to be maintained
            } else if (result === ERR_INVALID_TARGET) {
                // Controller is owned
                log.warn("TaskExecutor", `Cannot reserve ${targetRoomName}: owned by someone`);
                this.completeTask(creep);
            }
        }
    }

    /**
     * Execute recycle task
     * Moves creep to spawn and recycles it to recover energy
     */
    private executeRecycle(creep: Creep, spawn: StructureSpawn): void {
        if (!spawn) {
            log.warn("TaskExecutor", `No spawn for recycling ${creep.name}`);
            this.completeTask(creep);
            return;
        }

        // Move to spawn if not adjacent
        // Low priority - don't block important moves
        if (!this.approach(creep, spawn.pos, 1, { priority: 90 })) return;

        // Attempt to recycle
        const result = spawn.recycleCreep(creep);
        if (result === OK) {
            log.info("TaskExecutor", `Recycled damaged creep ${creep.name} at ${spawn.name}`);
            // Creep will be removed from game - no need to complete task
        } else if (result === ERR_BUSY) {
            // Spawn is busy spawning - wait
        } else {
            log.warn("TaskExecutor", `Failed to recycle ${creep.name}: ${result}`);
            this.failTask(creep, { id: creep.memory.currentTask!.taskId, type: TaskType.RECYCLE_CREEP }, "recycle");
        }
    }

    /**
     * Move creep to a different room
     */
    private moveToRoom(creep: Creep, targetRoom: string): void {
        trafficManager.requestMove(creep, new RoomPosition(25, 25, targetRoom), { range: 20 });
    }

    /**
     * Handle idle creep (no task)
     */
    private handleIdleCreep(creep: Creep): void {
        // Cross-room creeps should move to their target room
        if (creep.memory.targetRoom && creep.room.name !== creep.memory.targetRoom) {
            this.moveToRoom(creep, creep.memory.targetRoom);
            return;
        }

        const spawn = creep.room.find(FIND_MY_SPAWNS)[0];
        if (!spawn) {
            // No spawn in room - stay near controller if we own it
            if (creep.room.controller?.my) {
                trafficManager.requestMove(creep, creep.room.controller.pos, { range: 5, priority: 100 });
            }
            return;
        }

        // Park on an idle spot; the traffic reconciler shoves idle creeps out of the way when needed
        const idlePos = trafficManager.findIdlePosition(creep);
        if (idlePos) {
            trafficManager.requestMove(creep, idlePos, { range: 0, priority: 100 });
        } else {
            trafficManager.requestMove(creep, spawn.pos, { range: 5, priority: 100 });
        }
    }

    /**
     * Complete current task
     */
    private completeTask(creep: Creep): void {
        const taskState = creep.memory.currentTask;
        if (!taskState) return;

        const taskRoom = this.getTaskRoom(creep);
        if (taskRoom) {
            taskDispatcher.updateTaskStatus(taskRoom, taskState.taskId, TaskStatus.COMPLETED);
        }
        countStat("taskCompleted");

        delete creep.memory.currentTask;
    }

    /**
     * Clear creep's task without completing
     */
    private clearCreepTask(creep: Creep): void {
        const taskState = creep.memory.currentTask;
        if (taskState) {
            const taskRoom = this.getTaskRoom(creep);
            if (taskRoom) {
                taskDispatcher.unassignTask(taskRoom, taskState.taskId);
            }
        }
        delete creep.memory.currentTask;
    }

    /**
     * Helper: Move to and harvest source
     */
    private moveToAndHarvest(creep: Creep, source: Source): void {
        if (this.approach(creep, source.pos, 1)) {
            const result = this.act(creep, creep.harvest(source));
            if (result === OK) {
                const workParts = creep.getActiveBodyparts(WORK);
                metricsCollector.recordEnergyHarvested(creep.room.name, workParts * 2);
            }
        }
    }
}

// Singleton instance
const taskExecutorInstance = new TaskExecutor();

export const taskExecutorModule = () => {
    taskExecutorInstance.executeTasks();
};

export const taskExecutor = taskExecutorInstance;
