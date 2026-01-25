/**
 * SpawnManager - Part-count based spawning
 * Spawns generic body types based on part deficits
 */

import { BodyType, generateBody, generateOptimalBody, getBodyCost } from "../config/bodyTypes";
import { PartDemand } from "../types/TaskTypes";
import { log } from "../utils/logger";

interface SpawnRequest {
    bodyType: BodyType;
    body: BodyPartConstant[];
    priority: number;
    roomName: string;
    reason?: string;
}

/**
 * Spawn priorities (lower = higher priority)
 */
const SPAWN_PRIORITIES: Record<BodyType, number> = {
    [BodyType.COMBAT]: 0,
    [BodyType.WORKER]: 1,
    [BodyType.TRANSPORT]: 2,
    [BodyType.CLAIM]: 3,
    [BodyType.SCOUT]: 4
};

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
        const totalCreeps = room.find(FIND_MY_CREEPS).length;
        const defenseMode = room.memory.defenseMode ?? false;
        const energyRatio = room.energyAvailable / room.energyCapacityAvailable;

        // Emergency mode: spawn basic worker if too few creeps
        if (totalCreeps <= 2) {
            const body = this.getEmergencyBody(room);
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

        // Check WORK deficit - spawn workers
        if (demand[WORK] && demand[WORK].deficit > 0) {
            // Calculate how many workers needed
            const workPerWorker = Math.min(Math.floor(spawnEnergy / 250), 12); // Based on body config
            const workersNeeded = Math.ceil(demand[WORK].deficit / Math.max(workPerWorker, 1));

            for (let i = 0; i < Math.min(workersNeeded, 2); i++) {
                const body = generateBody(BodyType.WORKER, spawnEnergy);
                if (body.length > 0) {
                    // Prioritize first worker higher if deficit is severe
                    const priority = i === 0 && demand[WORK].deficit > 5
                        ? SPAWN_PRIORITIES[BodyType.WORKER] - 0.5
                        : SPAWN_PRIORITIES[BodyType.WORKER] + i * 0.1;

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
                    // Prioritize first transport higher if deficit is severe
                    const priority = i === 0 && demand[CARRY].deficit > 10
                        ? SPAWN_PRIORITIES[BodyType.TRANSPORT] - 0.5
                        : SPAWN_PRIORITIES[BodyType.TRANSPORT] + i * 0.1;

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
    }

    /**
     * Get emergency body using available energy
     */
    private getEmergencyBody(room: Room): BodyPartConstant[] {
        const energy = room.energyAvailable;

        // Minimum viable worker: 1 WORK, 1 CARRY, 1 MOVE = 200 energy
        if (energy < 200) {
            // Return whatever we can afford
            if (energy >= 200) {
                return [WORK, CARRY, MOVE];
            } else if (energy >= 150) {
                return [WORK, MOVE]; // Can at least harvest
            } else if (energy >= 100) {
                return [CARRY, MOVE]; // Can at least transport
            }
            return [MOVE]; // Absolute minimum
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
            let bestIndex = 0;

            for (let i = 0; i < this.spawnQueue.length; i++) {
                if (this.spawnQueue[i].roomName === spawnRoomName) {
                    bestIndex = i;
                    break;
                }
            }

            const request = this.spawnQueue[bestIndex];
            const { bodyType, body } = request;

            // Check if spawn can afford this body
            const cost = getBodyCost(body);
            if (spawn.room.energyAvailable < cost) {
                continue;
            }

            const newName = `${bodyType}-${Game.time}-${spawn.name}`;
            const memory: CreepMemory = {
                bodyType,
                room: request.roomName
            };

            const result = spawn.spawnCreep(body, newName, { memory });

            if (result === OK) {
                Memory.creeps[newName] = memory;
                log.info("SpawnManager", `Spawning ${bodyType}: ${newName} (${body.length} parts, cost: ${cost})`);
                this.spawnQueue.splice(bestIndex, 1);
            } else if (result !== ERR_NOT_ENOUGH_ENERGY) {
                log.warn("SpawnManager", `Failed to spawn ${bodyType}: ${result}`);
                this.spawnQueue.splice(bestIndex, 1);
            }
        }
    }

    /**
     * Get spawn queue snapshot for dashboard
     */
    getSpawnQueueSnapshot(): { bodyType: string; priority: number; roomName: string; bodyCost: number }[] {
        return this.spawnQueue.map(request => ({
            bodyType: request.bodyType,
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
