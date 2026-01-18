import { PHASE_CONFIGS } from "../config/phaseConfigs";
import { log } from "../utils/logger";
import { phaseManager } from "./PhaseManager";

interface CreepSpawnInfo {
    role: string;
    body: BodyPartConstant[];
    memory: CreepMemory;
    priority: number;
    roomName: string;
}

class SpawnManager {
    private spawnQueue: CreepSpawnInfo[] = [];

    private updateDesiredCounts(): void {
        const globalCounts: { [role: string]: number } = {
            harvester: 0,
            miner: 0,
            hauler: 0,
            builder: 0,
            upgrader: 0,
            defender: 0,
            claimer: 0
        };

        const currentCounts = _.countBy(Game.creeps, creep => creep.memory.role);

        // Cache current counts in memory
        Memory.spawn.currentCounts = {
            harvester: currentCounts.harvester ?? 0,
            miner: currentCounts.miner ?? 0,
            hauler: currentCounts.hauler ?? 0,
            builder: currentCounts.builder ?? 0,
            upgrader: currentCounts.upgrader ?? 0,
            defender: currentCounts.defender ?? 0,
            claimer: currentCounts.claimer ?? 0
        };

        // Aggregate desired counts from all owned rooms
        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];
            if (!room.controller?.my) continue;

            const roomDesired = phaseManager.getDesiredCreepCounts(room);
            for (const role in roomDesired) {
                globalCounts[role] = (globalCounts[role] ?? 0) + roomDesired[role];
            }
        }

        Memory.spawn.desiredCounts = globalCounts;
    }

    private determineBodyParts(role: string, room: Room): BodyPartConstant[] {
        const phase = room.memory.phase ?? 0;
        const config = PHASE_CONFIGS[phase];
        const energyAvailable = room.energyAvailable;
        const energyCapacity = room.energyCapacityAvailable;

        // Use full capacity for better creeps, but have minimum fallback
        if (energyAvailable < 200) {
            return [WORK, CARRY, MOVE];
        }

        // In emergency (totalCreeps < 3), use available energy; otherwise wait for capacity
        const totalCreeps = Object.keys(Game.creeps).length;
        const energy = totalCreeps < 3 ? energyAvailable : energyCapacity;

        // Get scaling config for this role and phase
        const bodyConfig = config.bodyScaling[role];
        const maxParts = bodyConfig?.maxParts ?? 10;

        const configurations: { [key: string]: (energy: number) => BodyPartConstant[] } = {
            harvester: (e) => {
                // Simple harvesters for emergency
                const workCount = Math.min(Math.floor(e / 200), maxParts);
                return [
                    ...Array(Math.max(1, workCount)).fill(WORK),
                    CARRY,
                    ...Array(Math.ceil(workCount / 2) + 1).fill(MOVE)
                ];
            },

            builder: (e) => {
                const workCount = Math.min(Math.floor(e / 200), maxParts);
                return [
                    ...Array(Math.max(1, workCount)).fill(WORK),
                    ...Array(Math.ceil(workCount / 2)).fill(CARRY),
                    ...Array(Math.ceil(workCount / 2)).fill(MOVE)
                ];
            },

            upgrader: (e) => {
                const workCount = Math.min(Math.floor(e / 200), maxParts);
                return [
                    ...Array(Math.max(1, workCount)).fill(WORK),
                    ...Array(Math.ceil(workCount / 2)).fill(CARRY),
                    ...Array(Math.ceil(workCount / 2)).fill(MOVE)
                ];
            },

            defender: (e) => {
                const attackCount = Math.min(Math.floor(e / 200), Math.floor(maxParts / 2));
                const toughCount = Math.floor(attackCount / 2);
                return [
                    ...Array(toughCount).fill(TOUGH),
                    ...Array(Math.max(1, attackCount)).fill(ATTACK),
                    ...Array(Math.ceil((toughCount + attackCount) / 2) + 1).fill(MOVE)
                ];
            },

            miner: (e) => {
                // 5 WORK parts is optimal (10 energy/tick = source depletes in 300 ticks)
                const workCount = Math.min(Math.floor(e / 150), Math.min(maxParts, 5));
                const moveCount = Math.ceil(workCount / 2);
                return [
                    ...Array(Math.max(1, workCount)).fill(WORK),
                    ...Array(Math.max(1, moveCount)).fill(MOVE)
                ];
            },

            hauler: (e) => {
                // 1 MOVE per 2 CARRY for road movement
                const carryCount = Math.min(Math.floor(e / 100), maxParts);
                const moveCount = Math.ceil(carryCount / 2);
                return [
                    ...Array(Math.max(1, carryCount)).fill(CARRY),
                    ...Array(Math.max(1, moveCount)).fill(MOVE)
                ];
            },

            claimer: () => [CLAIM, MOVE],
        };

        return configurations[role] ? configurations[role](energy) : [WORK, CARRY, MOVE];
    }

    private populateSpawnQueue(): void {
        this.updateDesiredCounts();
        this.spawnQueue = [];

        // Process each room separately for accurate body sizing
        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];
            if (!room.controller?.my) continue;

            const roomDesired = phaseManager.getDesiredCreepCounts(room);
            const priorities = phaseManager.getSpawnPriorities(room);
            const roomCreeps = room.find(FIND_MY_CREEPS);

            for (const role in roomDesired) {
                const desired = roomDesired[role];
                const current = roomCreeps.filter(c => c.memory.role === role).length;
                const needed = desired - current;

                if (needed > 0) {
                    const body = this.determineBodyParts(role, room);
                    const priority = priorities[role] ?? 99;

                    // Add one entry per needed creep (up to a reasonable limit)
                    // IMPORTANT: Create fresh memory object each iteration to avoid shared reference bugs
                    for (let i = 0; i < Math.min(needed, 3); i++) {
                        this.spawnQueue.push({
                            role,
                            body,
                            memory: { role, room: roomName },
                            priority,
                            roomName
                        });
                    }
                }
            }
        }

        // Sort by priority (lower = higher priority)
        this.spawnQueue.sort((a, b) => a.priority - b.priority);
    }

    private processSpawnQueue(): void {
        if (this.spawnQueue.length === 0) return;

        // Try to spawn from available spawns
        const availableSpawns = _.filter(Game.spawns, s => !s.spawning);

        for (const spawn of availableSpawns) {
            if (this.spawnQueue.length === 0) break;

            // Find best match: prefer creeps for this spawn's room
            const spawnRoomName = spawn.room.name;
            let bestIndex = 0;

            // Look for a creep from the same room first
            for (let i = 0; i < this.spawnQueue.length; i++) {
                if (this.spawnQueue[i].roomName === spawnRoomName) {
                    bestIndex = i;
                    break;
                }
            }

            const entry = this.spawnQueue[bestIndex];
            const { role, body, memory } = entry;

            // Check if spawn can afford this body
            const cost = _.sum(body, part => BODYPART_COST[part]);
            if (spawn.room.energyAvailable < cost) {
                continue;
            }

            const newName = `${role}-${Game.time}-${spawn.name}`;
            const result = spawn.spawnCreep(body, newName, { memory });

            if (result === OK) {
                log.info("SpawnManager", `Spawning ${role}: ${newName} (body: ${body.length} parts, cost: ${cost})`);
                // Verify memory was set correctly
                if (Memory.creeps[newName]?.role !== role) {
                    log.error("SpawnManager", `Memory mismatch! Expected role=${role}, got=${Memory.creeps[newName]?.role}`);
                }
                this.spawnQueue.splice(bestIndex, 1);
            } else if (result !== ERR_NOT_ENOUGH_ENERGY) {
                log.warn("SpawnManager", `Failed to spawn ${role}: ${result}`);
                this.spawnQueue.splice(bestIndex, 1);
            }
        }
    }

    manageSpawns(): void {
        this.populateSpawnQueue();
        this.processSpawnQueue();
    }

    /**
     * Get a snapshot of the spawn queue for dashboard display
     */
    getSpawnQueueSnapshot(): { role: string; priority: number; roomName: string; bodyCost: number }[] {
        return this.spawnQueue.map(entry => ({
            role: entry.role,
            priority: entry.priority,
            roomName: entry.roomName,
            bodyCost: _.sum(entry.body, part => BODYPART_COST[part])
        }));
    }
}

// Singleton instance
const spawnManagerInstance = new SpawnManager();

export const spawnManagerModule = () => {
    spawnManagerInstance.manageSpawns();
};

export const getSpawnQueueSnapshot = () => spawnManagerInstance.getSpawnQueueSnapshot();
