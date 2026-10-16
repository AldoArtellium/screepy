/**
 * SpawnManager - Part-count based spawning
 * Spawns generic body types based on part deficits
 */

import { BodyType, generateBody, generateOptimalBody, getBodyCost } from "../config/bodyTypes";
import { log } from "../utils/logger";
import { countStat } from "../utils/stats";

interface SpawnRequest {
    bodyType?: BodyType;
    body: BodyPartConstant[];
    priority: number;
    roomName: string;
    reason?: string;
    /** Target room for cross-room creeps (bootstrap, remote mining) */
    targetRoom?: string;
    /** Extra creep memory (module-driven creeps set `role`) */
    memory?: Partial<CreepMemory>;
    /** Id of the external request this comes from */
    externalId?: string;
}

/**
 * Spawn request from a module (scout, remote miner, claimer...).
 * Creeps spawned this way carry `memory.role`: they are driven by the role handler
 * registered in TaskExecutor (`registerRole`) and never take tasks from the task queue.
 */
export interface ExternalSpawnRequest {
    /** Unique id: re-requesting with the same id updates the request instead of duplicating it */
    id: string;
    /** Room whose spawns should build the creep */
    roomName: string;
    body: BodyPartConstant[];
    /** Same scale as SPAWN_PRIORITIES (lower = sooner). Economy workers use 1-2. */
    priority: number;
    memory: Partial<CreepMemory> & { role: string };
    /** Ticks the request stays queued without being renewed (default 20) */
    ttl?: number;
}

const DEFAULT_REQUEST_TTL = 20;

/**
 * Spawn priorities (lower = higher priority)
 */
const SPAWN_PRIORITIES: Record<BodyType, number> = {
    [BodyType.COMBAT]: 0,
    [BodyType.WORKER]: 1,
    [BodyType.TRANSPORT]: 2,
    [BodyType.CLAIM]: 3,
    [BodyType.SCOUT]: 4,
    [BodyType.RESERVER]: 3,
    // Before workers, even "urgent" ones (0.5): a missing miner inflates the WORK deficit,
    // so workers would otherwise always win and miners never spawn. Phase >= 1 (3+ creeps) only.
    [BodyType.MINER]: 0.4
};

/** WORK parts that fully drain a source (10 energy/tick) */
const SOURCE_WORK_TARGET = 5;

/**
 * Energy thresholds for spawning decisions
 */
const SPAWN_ENERGY = {
    /** Minimum energy ratio to spawn non-emergency creeps */
    MIN_RATIO: 0.5,
    /** Energy ratio to prefer larger bodies */
    PREFER_LARGE_RATIO: 0.8,
    /** Wait for full capacity if above this ratio and no urgency */
    WAIT_FULL_RATIO: 0.9
};

class SpawnManager {
    private spawnQueue: SpawnRequest[] = [];

    /** Module requests, kept until spawned or expired (heap only: modules renew them) */
    private externalRequests: Map<string, ExternalSpawnRequest & { expiresAt: number }> = new Map();

    /**
     * Ask for a creep. Call it each time the module runs while the creep is still needed;
     * the request expires after `ttl` ticks without renewal and is removed once spawned.
     * The caller must count its existing creeps (including spawning ones) to avoid over-requesting.
     */
    requestSpawn(request: ExternalSpawnRequest): void {
        this.externalRequests.set(request.id, {
            ...request,
            expiresAt: Game.time + (request.ttl ?? DEFAULT_REQUEST_TTL)
        });
    }

    /** Whether a request is still queued (not spawned, not expired) */
    hasPendingRequest(id: string): boolean {
        const request = this.externalRequests.get(id);
        return !!request && request.expiresAt >= Game.time;
    }

    private queueExternalRequests(): void {
        for (const [id, request] of this.externalRequests) {
            if (request.expiresAt < Game.time) {
                this.externalRequests.delete(id);
                continue;
            }
            const room = Game.rooms[request.roomName];
            if (!room?.controller?.my) continue;
            if (getBodyCost(request.body) > room.energyCapacityAvailable) {
                log.warn("SpawnManager", `Request ${id} body costs more than ${room.name} capacity, dropped`);
                this.externalRequests.delete(id);
                continue;
            }
            this.spawnQueue.push({
                body: request.body,
                priority: request.priority,
                roomName: request.roomName,
                reason: `request ${id}`,
                memory: request.memory,
                externalId: id
            });
        }
    }

    /**
     * Main spawn management function
     */
    manageSpawns(): void {
        this.spawnQueue = [];

        // Build spawn queue from all rooms
        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];
            if (!room.controller?.my) continue;

            this.calculateSpawnNeeds(room);
        }

        this.queueExternalRequests();

        // Sort by priority
        this.spawnQueue.sort((a, b) => a.priority - b.priority);

        // Process spawn queue
        this.processSpawnQueue();
    }

    /**
     * Calculate spawn needs based on part deficits
     */
    private calculateSpawnNeeds(room: Room): void {
        const demand = room.memory.partDemand;
        const phase = room.memory.phase ?? 0;
        const totalCreeps = room.find(FIND_MY_CREEPS, { filter: c => !c.memory.role }).length;
        const defenseMode = room.memory.defenseMode ?? false;
        const energyRatio = room.energyAvailable / room.energyCapacityAvailable;

        // Emergency mode: spawn basic worker if too few creeps
        if (totalCreeps <= 2) {
            const body = this.getEmergencyBody(room);
            if (body.length === 0) {
                return; // Not enough energy for functional creep
            }
            this.spawnQueue.push({
                bodyType: BodyType.WORKER,
                body,
                priority: -10, // Highest priority
                roomName: room.name,
                reason: "emergency"
            });
            return;
        }

        if (!demand) return;

        // Check combat needs first (defense mode)
        if (defenseMode && demand[ATTACK] && demand[ATTACK].deficit > 0) {
            const body = generateBody(BodyType.COMBAT, room.energyCapacityAvailable);
            if (body.length > 0) {
                this.spawnQueue.push({
                    bodyType: BodyType.COMBAT,
                    body,
                    priority: SPAWN_PRIORITIES[BodyType.COMBAT],
                    roomName: room.name,
                    reason: "defense"
                });
            }
        }

        // Determine spawn energy budget based on urgency
        const hasUrgentDeficit = (demand[WORK]?.deficit ?? 0) > 5 || (demand[CARRY]?.deficit ?? 0) > 10;
        let spawnEnergy = room.energyCapacityAvailable;

        if (!hasUrgentDeficit && energyRatio < SPAWN_ENERGY.PREFER_LARGE_RATIO) {
            // Wait for more energy if no urgency
            if (energyRatio < SPAWN_ENERGY.MIN_RATIO) {
                return; // Don't spawn yet
            }
            // Use available energy for smaller body
            spawnEnergy = room.energyAvailable;
        }

        // Static miners first: they are the energy income
        this.calculateMinerNeeds(room, phase);

        // Check WORK deficit - spawn workers
        if (demand[WORK] && demand[WORK].deficit > 0) {
            // Calculate how many workers needed
            const workPerWorker = Math.min(Math.floor(spawnEnergy / 250), 12); // Based on body config
            const workersNeeded = Math.ceil(demand[WORK].deficit / Math.max(workPerWorker, 1));

            for (let i = 0; i < Math.min(workersNeeded, 2); i++) {
                const body = generateBody(BodyType.WORKER, spawnEnergy);
                if (body.length > 0) {
                    const priority = this.coveragePriority(demand[WORK]) + i * 0.1;

                    this.spawnQueue.push({
                        bodyType: BodyType.WORKER,
                        body,
                        priority,
                        roomName: room.name,
                        reason: `work deficit ${demand[WORK].deficit}`
                    });
                }
            }
        }

        // Check CARRY deficit - spawn transports
        if (demand[CARRY] && demand[CARRY].deficit > 0) {
            // Calculate how many transports needed
            const carryPerTransport = Math.min(Math.floor(spawnEnergy / 150) * 2, 32); // 2 CARRY per unit
            const transportsNeeded = Math.ceil(demand[CARRY].deficit / Math.max(carryPerTransport, 2));

            for (let i = 0; i < Math.min(transportsNeeded, 2); i++) {
                const body = generateBody(BodyType.TRANSPORT, spawnEnergy);
                if (body.length > 0) {
                    const priority = this.coveragePriority(demand[CARRY]) + i * 0.1;

                    this.spawnQueue.push({
                        bodyType: BodyType.TRANSPORT,
                        body,
                        priority,
                        roomName: room.name,
                        reason: `carry deficit ${demand[CARRY].deficit}`
                    });
                }
            }
        }

        // Ensure minimum creep population in higher phases
        if (phase >= 2 && totalCreeps < 5) {
            // Spawn a worker even without deficit to maintain economy
            const body = generateBody(BodyType.WORKER, room.energyAvailable);
            if (body.length > 0) {
                this.spawnQueue.push({
                    bodyType: BodyType.WORKER,
                    body,
                    priority: 0.5, // High priority
                    roomName: room.name,
                    reason: "population"
                });
            }
        }

        // Spawn workers for bootstrap targets (newly claimed rooms)
        this.calculateBootstrapSpawnNeeds(room, spawnEnergy);
    }

    /**
     * Worker/transport priority from how well the part is covered (supplied/total): the least
     * covered type spawns first. With fixed priorities the queue is strictly ordered, and since
     * there is always some WORK deficit (upgrading, building), transports never spawned.
     * Range 1-2: after miners (0.4) and population (0.5), before claimers and remotes (2.4+).
     */
    private coveragePriority(part: { total: number; supplied: number }): number {
        const coverage = part.total > 0 ? Math.min(1, part.supplied / part.total) : 1;
        return 1 + coverage;
    }

    /**
     * Spawn static miners until every source has SOURCE_WORK_TARGET WORK (max 2 miners per source)
     */
    private calculateMinerNeeds(room: Room, phase: number): void {
        if (phase < 1) return;
        // Off by default: on 3 benchmark rooms (8000 ticks) static miners did 12-29% worse than
        // self-harvesting workers. Memory.config.staticMiners = true turns them on (A/B tests).
        if (Memory.config?.staticMiners !== true) return;

        const sources = room.find(FIND_SOURCES).length;
        const miners = _.filter(Game.creeps, c =>
            c.memory.bodyType === BodyType.MINER && c.memory.room === room.name &&
            (c.spawning || (c.ticksToLive ?? 0) > c.body.length * CREEP_SPAWN_TIME + 50)
        );
        const minerWork = _.sum(miners, c => c.getActiveBodyparts(WORK));
        if (minerWork >= sources * SOURCE_WORK_TARGET || miners.length >= sources * 2) return;

        // Full-size miner (waits for full energy): a small miner wastes a source slot for its whole life
        const body = generateBody(BodyType.MINER, room.energyCapacityAvailable);
        this.spawnQueue.push({
            bodyType: BodyType.MINER,
            body,
            priority: SPAWN_PRIORITIES[BodyType.MINER],
            roomName: room.name,
            reason: `miner work ${minerWork}/${sources * SOURCE_WORK_TARGET}`
        });
    }

    /**
     * Calculate spawn needs for bootstrap targets
     */
    private calculateBootstrapSpawnNeeds(room: Room, spawnEnergy: number): void {
        const bootstrapTargets = room.memory.bootstrapTargets ?? [];
        if (bootstrapTargets.length === 0) return;

        for (const targetRoom of bootstrapTargets) {
            // Count existing bootstrap workers for this target
            const existingWorkers = _.filter(Game.creeps, c =>
                c.memory.room === room.name &&
                c.memory.targetRoom === targetRoom &&
                c.memory.bodyType === BodyType.WORKER
            ).length;

            // Need 3-4 workers per bootstrap target
            const desiredWorkers = 4;
            const workersNeeded = desiredWorkers - existingWorkers;

            if (workersNeeded <= 0) continue;

            // Spawn workers for bootstrap
            for (let i = 0; i < Math.min(workersNeeded, 2); i++) {
                const body = generateBody(BodyType.WORKER, spawnEnergy);
                if (body.length > 0) {
                    this.spawnQueue.push({
                        bodyType: BodyType.WORKER,
                        body,
                        priority: SPAWN_PRIORITIES[BodyType.WORKER] + 0.3 + i * 0.1,
                        roomName: room.name,
                        targetRoom,
                        reason: `bootstrap ${targetRoom}`
                    });
                }
            }
        }
    }

    /**
     * Get emergency body using available energy
     */
    private getEmergencyBody(room: Room): BodyPartConstant[] {
        const energy = room.energyAvailable;

        // Minimum functional creep: WORK + CARRY + MOVE = 200 energy.
        // A WORK+MOVE creep can't carry energy to the spawn, so it doesn't bootstrap anything:
        // wait for 200 (the spawn regenerates energy on its own).
        if (energy < 200) {
            return [];
        }

        // Build largest worker possible with available energy
        return generateOptimalBody(BodyType.WORKER, energy);
    }

    /**
     * Process spawn queue and spawn creeps
     */
    private processSpawnQueue(): void {
        if (this.spawnQueue.length === 0) return;

        const availableSpawns = _.filter(Game.spawns, s => !s.spawning);

        for (const spawn of availableSpawns) {
            if (this.spawnQueue.length === 0) break;

            // Find best match for this spawn's room
            const spawnRoomName = spawn.room.name;
            const bestIndex = this.spawnQueue.findIndex(r => r.roomName === spawnRoomName);
            if (bestIndex === -1) continue;

            const request = this.spawnQueue[bestIndex];
            const { bodyType, body } = request;
            const label = request.memory?.role ?? bodyType ?? "creep";

            // Check if spawn can afford this body
            const cost = getBodyCost(body);
            if (spawn.room.energyAvailable < cost) {
                continue;
            }

            const newName = `${label}-${Game.time}-${spawn.name}`;
            const memory: CreepMemory = {
                ...(bodyType && { bodyType }),
                room: request.roomName,
                ...(request.targetRoom && { targetRoom: request.targetRoom }),
                ...request.memory
            };

            const result = spawn.spawnCreep(body, newName, { memory });

            if (result === OK) {
                Memory.creeps[newName] = memory;
                const targetInfo = request.targetRoom ? ` → ${request.targetRoom}` : "";
                log.info("SpawnManager", `Spawning ${label}: ${newName} (${body.length} parts, cost: ${cost})${targetInfo}`);
                this.spawnQueue.splice(bestIndex, 1);
                if (request.externalId) this.externalRequests.delete(request.externalId);
                countStat(`spawned:${label}`);
            } else if (result !== ERR_NOT_ENOUGH_ENERGY) {
                log.warn("SpawnManager", `Failed to spawn ${label}: ${result}`);
                this.spawnQueue.splice(bestIndex, 1);
                if (request.externalId) this.externalRequests.delete(request.externalId);
            }
        }
    }

    /**
     * Get spawn queue snapshot for dashboard
     */
    getSpawnQueueSnapshot(): { bodyType: string; priority: number; roomName: string; bodyCost: number }[] {
        return this.spawnQueue.map(request => ({
            bodyType: request.memory?.role ?? request.bodyType ?? "creep",
            priority: request.priority,
            roomName: request.roomName,
            bodyCost: getBodyCost(request.body)
        }));
    }
}

// Singleton instance
const spawnManagerInstance = new SpawnManager();

export const spawnManagerModule = () => {
    spawnManagerInstance.manageSpawns();
};

export const getSpawnQueueSnapshot = () => spawnManagerInstance.getSpawnQueueSnapshot();

export const spawnManager = spawnManagerInstance;
