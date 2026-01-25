/**
 * DefenderManager - Rampart defender spawning and positioning
 *
 * Features:
 * - Spawn defenders when threats detected
 * - Position defenders at optimal ramparts
 * - Scale defender bodies based on threat level
 * - Create DEFEND_RAMPART tasks for static defense
 */

import { BodyType, generateBody, getBodyCost, countParts } from "../config/bodyTypes";
import {
    generateTaskId,
    getEffectivePriority,
    Task,
    TaskCategory,
    TaskStatus,
    TaskType
} from "../types/TaskTypes";
import { log } from "../utils/logger";

/** Defender configuration */
const DEFENDER_CONFIG = {
    /** Minimum threat level to spawn defenders */
    SPAWN_THREAT_THRESHOLD: 500,
    /** Maximum defenders per room */
    MAX_DEFENDERS: 4,
    /** Rampart search range from spawn */
    RAMPART_SEARCH_RANGE: 10,
    /** Minimum hits for rampart to be considered for defense */
    MIN_RAMPART_HITS: 5000
};

/** Defender body configurations by threat level */
const DEFENDER_BODIES: { threshold: number; parts: BodyPartConstant[] }[] = [
    // Low threat: basic melee
    {
        threshold: 500,
        parts: [TOUGH, ATTACK, ATTACK, MOVE, MOVE, MOVE]
    },
    // Medium threat: stronger melee
    {
        threshold: 2000,
        parts: [TOUGH, TOUGH, ATTACK, ATTACK, ATTACK, ATTACK, MOVE, MOVE, MOVE, MOVE]
    },
    // High threat: heavy melee
    {
        threshold: 5000,
        parts: [
            TOUGH, TOUGH, TOUGH, TOUGH,
            ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK,
            MOVE, MOVE, MOVE, MOVE, MOVE, MOVE
        ]
    },
    // Critical threat: max combat
    {
        threshold: 10000,
        parts: [
            TOUGH, TOUGH, TOUGH, TOUGH, TOUGH,
            ATTACK, ATTACK, ATTACK, ATTACK, ATTACK,
            ATTACK, ATTACK, ATTACK, ATTACK, ATTACK,
            MOVE, MOVE, MOVE, MOVE, MOVE,
            MOVE, MOVE, MOVE, MOVE, MOVE
        ]
    }
];

class DefenderManager {
    /**
     * Main defender management function
     */
    manage(): void {
        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];
            if (!room.controller?.my) continue;

            const defenseMode = room.memory.defenseMode ?? false;
            const threatLevel = room.memory.threatLevel ?? 0;

            if (defenseMode && threatLevel > 0) {
                this.manageDefense(room, threatLevel);
            }
        }
    }

    /**
     * Manage defense for a room under attack
     */
    private manageDefense(room: Room, threatLevel: number): void {
        // Find existing defenders
        const defenders = room.find(FIND_MY_CREEPS, {
            filter: c => c.memory.bodyType === BodyType.COMBAT
        });

        // Generate defense tasks
        this.generateDefenseTasks(room, defenders);

        // Check if we need more defenders
        if (defenders.length < DEFENDER_CONFIG.MAX_DEFENDERS) {
            this.requestDefender(room, threatLevel);
        }
    }

    /**
     * Generate DEFEND_RAMPART tasks for available ramparts
     */
    private generateDefenseTasks(room: Room, defenders: Creep[]): void {
        const hostiles = room.find(FIND_HOSTILE_CREEPS);
        if (hostiles.length === 0) return;

        // Find ramparts that need defending
        const ramparts = this.findDefensiveRamparts(room, hostiles);

        // Create tasks for undefended ramparts
        for (const rampart of ramparts) {
            // Check if rampart already has a task
            const existingTask = (room.memory.taskQueue ?? []).find(
                t => t.type === TaskType.DEFEND_RAMPART &&
                     t.targetId === rampart.id &&
                     t.status !== TaskStatus.COMPLETED &&
                     t.status !== TaskStatus.FAILED
            );

            if (existingTask) continue;

            // Check if a defender is already at this rampart
            const defenderAtRampart = defenders.find(d =>
                d.pos.isEqualTo(rampart.pos)
            );

            if (defenderAtRampart) continue;

            // Create defense task
            const task: Task = {
                id: generateTaskId(TaskType.DEFEND_RAMPART, rampart.id),
                type: TaskType.DEFEND_RAMPART,
                category: TaskCategory.ATTACK,
                targetId: rampart.id,
                roomName: room.name,
                priority: getEffectivePriority(TaskType.DEFEND_RAMPART, true),
                status: TaskStatus.PENDING,
                createdAt: Game.time,
                expiresAt: Game.time + 100,
                data: {
                    targetPos: { x: rampart.pos.x, y: rampart.pos.y }
                }
            };

            if (!room.memory.taskQueue) {
                room.memory.taskQueue = [];
            }
            room.memory.taskQueue.push(task);

            log.debug("DefenderManager", `Created DEFEND_RAMPART task at ${rampart.pos.x},${rampart.pos.y}`);
        }
    }

    /**
     * Find ramparts that are good defensive positions
     */
    private findDefensiveRamparts(room: Room, hostiles: Creep[]): StructureRampart[] {
        const spawn = room.find(FIND_MY_SPAWNS)[0];
        if (!spawn) return [];

        // Find all ramparts
        const ramparts = room.find(FIND_MY_STRUCTURES, {
            filter: (s): s is StructureRampart =>
                s.structureType === STRUCTURE_RAMPART &&
                s.hits >= DEFENDER_CONFIG.MIN_RAMPART_HITS
        });

        if (ramparts.length === 0) return [];

        // Score ramparts by defensive value
        const scoredRamparts = ramparts.map(rampart => {
            let score = 0;

            // Prefer ramparts closer to hostiles (can engage)
            const closestHostile = rampart.pos.findClosestByRange(hostiles);
            if (closestHostile) {
                const range = rampart.pos.getRangeTo(closestHostile);
                if (range <= 1) {
                    score += 100; // Can attack
                } else if (range <= 3) {
                    score += 50; // Close
                }
            }

            // Prefer ramparts protecting the spawn
            const distToSpawn = rampart.pos.getRangeTo(spawn);
            if (distToSpawn <= 5) {
                score += 30;
            }

            // Prefer ramparts with more hits
            score += rampart.hits / 10000;

            return { rampart, score };
        });

        // Sort by score (highest first) and return top positions
        return scoredRamparts
            .sort((a, b) => b.score - a.score)
            .slice(0, DEFENDER_CONFIG.MAX_DEFENDERS)
            .map(s => s.rampart);
    }

    /**
     * Request a defender spawn based on threat level
     */
    private requestDefender(room: Room, threatLevel: number): void {
        // This integrates with SpawnManager through demand calculation
        // The actual spawning happens via the part deficit system

        // Calculate required ATTACK parts based on threat
        const attackNeeded = Math.ceil(threatLevel / 100);
        const currentAttack = this.countRoomAttackParts(room);

        if (currentAttack < attackNeeded) {
            // Store defender demand in room memory for SpawnManager
            if (!room.memory.partDemand) {
                room.memory.partDemand = {};
            }

            room.memory.partDemand[ATTACK] = {
                total: attackNeeded,
                supplied: currentAttack,
                deficit: Math.max(0, attackNeeded - currentAttack)
            };
        }
    }

    /**
     * Count total ATTACK parts in a room
     */
    private countRoomAttackParts(room: Room): number {
        const creeps = room.find(FIND_MY_CREEPS);
        let total = 0;

        for (const creep of creeps) {
            total += countParts(creep, ATTACK);
        }

        return total;
    }

    /**
     * Get the appropriate defender body for a threat level
     */
    getDefenderBody(threatLevel: number, energyCapacity: number): BodyPartConstant[] {
        // Find the highest threat tier we can handle
        let selectedBody = DEFENDER_BODIES[0].parts;

        for (const config of DEFENDER_BODIES) {
            if (threatLevel >= config.threshold) {
                const cost = getBodyCost(config.parts);
                if (cost <= energyCapacity) {
                    selectedBody = config.parts;
                }
            }
        }

        // Verify we can afford it
        const cost = getBodyCost(selectedBody);
        if (cost > energyCapacity) {
            // Fall back to basic combat body
            return generateBody(BodyType.COMBAT, energyCapacity);
        }

        return selectedBody;
    }

    /**
     * Find the best rampart position for a defender
     */
    findBestDefensePosition(room: Room, defender: Creep): RoomPosition | null {
        const hostiles = room.find(FIND_HOSTILE_CREEPS);
        if (hostiles.length === 0) return null;

        const ramparts = room.find(FIND_MY_STRUCTURES, {
            filter: (s): s is StructureRampart =>
                s.structureType === STRUCTURE_RAMPART &&
                s.hits >= DEFENDER_CONFIG.MIN_RAMPART_HITS
        });

        if (ramparts.length === 0) return null;

        // Find rampart with hostile in melee range
        for (const rampart of ramparts) {
            const hostileInRange = rampart.pos.findInRange(hostiles, 1)[0];
            if (hostileInRange) {
                // Check if position is not already occupied
                const creepAtPos = rampart.pos.lookFor(LOOK_CREEPS)
                    .filter(c => c.id !== defender.id)[0];

                if (!creepAtPos) {
                    return rampart.pos;
                }
            }
        }

        // No hostile in melee range - find closest rampart to nearest hostile
        const closestHostile = defender.pos.findClosestByRange(hostiles);
        if (!closestHostile) return null;

        let bestRampart: StructureRampart | null = null;
        let bestDistance = Infinity;

        for (const rampart of ramparts) {
            const dist = rampart.pos.getRangeTo(closestHostile);

            // Check if position is not occupied
            const creepAtPos = rampart.pos.lookFor(LOOK_CREEPS)
                .filter(c => c.id !== defender.id)[0];

            if (!creepAtPos && dist < bestDistance) {
                bestDistance = dist;
                bestRampart = rampart;
            }
        }

        return bestRampart?.pos ?? null;
    }
}

// Singleton instance
const defenderManagerInstance = new DefenderManager();

export const defenderManagerModule = () => {
    defenderManagerInstance.manage();
};

export const defenderManager = defenderManagerInstance;
