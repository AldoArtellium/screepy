/**
 * ExpansionManager - Room claiming and expansion
 *
 * Features:
 * - Room scoring for expansion targets
 * - GCL tracking and claim eligibility
 * - Claimer spawning and dispatch
 * - New room bootstrap coordination
 * - Multi-room resource management
 */

import { BodyType, generateBody } from "../config/bodyTypes";
import { intelManager, RoomIntel } from "./IntelManager";
import {
    generateTaskId,
    getEffectivePriority,
    Task,
    TaskCategory,
    TaskStatus,
    TaskType
} from "../types/TaskTypes";
import { log } from "../utils/logger";

/** Expansion configuration */
const EXPANSION_CONFIG = {
    /** Minimum phase to consider expansion */
    MIN_PHASE: 4,
    /** Minimum GCL to claim (GCL 2 = 2 rooms) */
    MIN_GCL_FOR_EXPANSION: 2,
    /** Maximum distance for expansion targets */
    MAX_CLAIM_DISTANCE: 5,
    /** Minimum score for a room to be considered */
    MIN_EXPANSION_SCORE: 1000,
    /** Ticks between expansion evaluations */
    EVAL_INTERVAL: 500,
    /** Maximum claimers active at once */
    MAX_CLAIMERS: 1,
    /** Ticks for claimer to reach target (must be < 600 for claim lifetime) */
    MAX_CLAIM_PATH_TICKS: 500
};

/** Expansion target */
interface ExpansionTarget {
    /** Target room name */
    roomName: string;
    /** Expansion score */
    score: number;
    /** Distance from nearest owned room */
    distance: number;
    /** Parent room that will handle expansion */
    parentRoom: string;
    /** Status of expansion */
    status: "pending" | "claiming" | "bootstrapping" | "complete";
    /** Tick when expansion started */
    startedAt: number;
    /** Claimer creep name if assigned */
    claimerId?: string;
}

class ExpansionManager {
    /**
     * Main expansion management
     */
    manage(): void {
        // Initialize expansion memory
        if (!Memory.expansion) {
            Memory.expansion = {
                targets: [],
                lastEval: 0
            };
        }

        // Check GCL eligibility
        if (!this.canExpand()) return;

        // Evaluate expansion targets periodically
        if (Game.time - Memory.expansion.lastEval > EXPANSION_CONFIG.EVAL_INTERVAL) {
            this.evaluateExpansionTargets();
            Memory.expansion.lastEval = Game.time;
        }

        // Process active expansion targets
        this.processExpansionTargets();

        // Run claimers
        this.runClaimers();
    }

    /**
     * Check if we can expand (GCL allows more rooms)
     */
    private canExpand(): boolean {
        const ownedRooms = Object.values(Game.rooms).filter(r => r.controller?.my).length;
        const maxRooms = Game.gcl.level;

        return ownedRooms < maxRooms;
    }

    /**
     * Get current expansion capacity
     */
    getExpansionCapacity(): { current: number; max: number; canExpand: boolean } {
        const current = Object.values(Game.rooms).filter(r => r.controller?.my).length;
        const max = Game.gcl.level;
        return { current, max, canExpand: current < max };
    }

    /**
     * Evaluate and score potential expansion targets
     */
    private evaluateExpansionTargets(): void {
        const candidates: ExpansionTarget[] = [];

        // Get all owned rooms that can support expansion
        const parentRooms = Object.values(Game.rooms).filter(room => {
            if (!room.controller?.my) return false;
            const phase = room.memory.phase ?? 0;
            return phase >= EXPANSION_CONFIG.MIN_PHASE;
        });

        if (parentRooms.length === 0) return;

        // Evaluate rooms from intel
        for (const roomName in Memory.intel) {
            const intel = Memory.intel[roomName];
            if (!intel) continue;

            // Skip owned rooms
            if (intel.owner) continue;

            // Skip reserved rooms (unless by us)
            if (intel.reserver && intel.reserver !== Memory.username) continue;

            // Skip source keeper rooms
            if (intel.hasSourceKeepers) continue;

            // Must have controller (center rooms don't)
            if (intel.controllerLevel === undefined) continue;

            // Skip rooms with invader cores
            if (intel.hasInvaderCore) continue;

            // Must have at least 1 source (preferably 2)
            if (intel.sourceCount === 0) continue;

            // Find nearest parent room
            let bestParent: Room | null = null;
            let bestDistance = Infinity;

            for (const parent of parentRooms) {
                const dist = intelManager.getRoomDistance(parent.name, roomName);
                if (dist < bestDistance && dist <= EXPANSION_CONFIG.MAX_CLAIM_DISTANCE) {
                    bestDistance = dist;
                    bestParent = parent;
                }
            }

            if (!bestParent) continue;

            // Calculate expansion score
            const score = this.calculateExpansionScore(intel, bestDistance);

            if (score >= EXPANSION_CONFIG.MIN_EXPANSION_SCORE) {
                candidates.push({
                    roomName,
                    score,
                    distance: bestDistance,
                    parentRoom: bestParent.name,
                    status: "pending",
                    startedAt: 0
                });
            }
        }

        // Sort by score (highest first)
        candidates.sort((a, b) => b.score - a.score);

        // Ensure expansion memory exists
        if (!Memory.expansion) {
            Memory.expansion = { targets: [], lastEval: 0 };
        }

        // Keep top candidates (don't overwrite active targets)
        const activeTargets = Memory.expansion.targets.filter(t =>
            t.status !== "pending" && t.status !== "complete"
        );

        const pendingSlots = Math.max(0, 3 - activeTargets.length);
        const newTargets = candidates.slice(0, pendingSlots);

        Memory.expansion.targets = [
            ...activeTargets,
            ...newTargets
        ];

        if (newTargets.length > 0) {
            log.info("ExpansionManager", `Found ${newTargets.length} expansion candidates. Top: ${newTargets[0]?.roomName} (score: ${newTargets[0]?.score})`);
        }
    }

    /**
     * Calculate expansion score for a room
     */
    private calculateExpansionScore(intel: RoomIntel, distance: number): number {
        let score = 0;

        // Base score from sources (2 sources is much better)
        score += intel.sourceCount * 1000;
        if (intel.sourceCount >= 2) {
            score += 500; // Bonus for 2 sources
        }

        // Mineral bonus
        if (intel.mineralType) {
            score += 200;
        }

        // Distance penalty (closer is better)
        score -= distance * 300;

        // Terrain penalty
        score -= intel.terrainDifficulty * 500;

        // Recent hostile activity penalty
        if (intel.lastHostileSeen && Game.time - intel.lastHostileSeen < 1000) {
            score -= 500;
        }

        // Controller level penalty (avoid rooms with controllers being upgraded)
        if (intel.controllerLevel > 0) {
            score -= intel.controllerLevel * 100;
        }

        return Math.max(0, Math.floor(score));
    }

    /**
     * Process active expansion targets
     */
    private processExpansionTargets(): void {
        if (!Memory.expansion) return;

        for (const target of Memory.expansion.targets) {
            switch (target.status) {
                case "pending":
                    this.startExpansion(target);
                    break;

                case "claiming":
                    this.processClaiming(target);
                    break;

                case "bootstrapping":
                    this.processBootstrapping(target);
                    break;
            }
        }

        // Clean up complete targets
        Memory.expansion.targets = Memory.expansion.targets.filter(t =>
            t.status !== "complete"
        );
    }

    /**
     * Start expansion to a target room
     */
    private startExpansion(target: ExpansionTarget): void {
        // Check if we still can expand
        if (!this.canExpand()) return;

        // Check if we already have a claimer
        const existingClaimers = _.filter(Game.creeps, c =>
            c.memory.bodyType === BodyType.CLAIM
        );

        if (existingClaimers.length >= EXPANSION_CONFIG.MAX_CLAIMERS) return;

        // Verify the room is still valid
        const intel = intelManager.getIntel(target.roomName);
        if (intel?.owner) {
            target.status = "complete"; // Room was claimed by someone else
            return;
        }

        // Request claimer spawn
        const parentRoom = Game.rooms[target.parentRoom];
        if (!parentRoom) return;

        // Create claim task
        this.createClaimTask(parentRoom, target);

        target.status = "claiming";
        target.startedAt = Game.time;

        log.info("ExpansionManager", `Starting expansion to ${target.roomName} from ${target.parentRoom}`);
    }

    /**
     * Create a CLAIM_ROOM task
     */
    private createClaimTask(parentRoom: Room, target: ExpansionTarget): void {
        if (!parentRoom.memory.taskQueue) {
            parentRoom.memory.taskQueue = [];
        }

        // Create a virtual target ID using room name
        const targetId = `controller-${target.roomName}` as Id<StructureController>;

        const task: Task = {
            id: generateTaskId(TaskType.CLAIM_ROOM, targetId),
            type: TaskType.CLAIM_ROOM,
            category: TaskCategory.CLAIM,
            targetId,
            roomName: target.roomName,
            priority: getEffectivePriority(TaskType.CLAIM_ROOM, false),
            status: TaskStatus.PENDING,
            createdAt: Game.time,
            expiresAt: Game.time + 1500, // Claim parts last 600 ticks
            data: {
                targetPos: { x: 25, y: 25 } // Center of room as placeholder
            }
        };

        parentRoom.memory.taskQueue.push(task);
    }

    /**
     * Process a room being claimed
     */
    private processClaiming(target: ExpansionTarget): void {
        // Check if room is now claimed
        const room = Game.rooms[target.roomName];
        if (room?.controller?.my) {
            target.status = "bootstrapping";
            log.info("ExpansionManager", `Successfully claimed ${target.roomName}!`);
            return;
        }

        // Check for timeout (claimer died or couldn't reach)
        if (Game.time - target.startedAt > 1500) {
            log.warn("ExpansionManager", `Claim attempt for ${target.roomName} timed out`);
            target.status = "pending";
            target.startedAt = 0;
        }
    }

    /**
     * Process a newly claimed room being bootstrapped
     */
    private processBootstrapping(target: ExpansionTarget): void {
        const room = Game.rooms[target.roomName];
        if (!room?.controller?.my) {
            // Lost the room somehow
            target.status = "complete";
            return;
        }

        // Check if room has a spawn (bootstrap complete)
        const spawns = room.find(FIND_MY_SPAWNS);
        if (spawns.length > 0) {
            target.status = "complete";
            log.info("ExpansionManager", `Bootstrap complete for ${target.roomName}`);

            // Clean up bootstrap targets in parent room
            const parentRoom = Game.rooms[target.parentRoom];
            if (parentRoom?.memory.bootstrapTargets) {
                parentRoom.memory.bootstrapTargets = parentRoom.memory.bootstrapTargets.filter(
                    r => r !== target.roomName
                );
            }
            return;
        }

        // Ensure room is in emergency/bootstrap phase
        if (room.memory.phase === undefined || room.memory.phase > 1) {
            room.memory.phase = 0;
        }

        // Place spawn construction site if needed
        this.ensureSpawnSite(room);

        // Request builders from parent room
        this.requestBootstrapSupport(target);
    }

    /**
     * Ensure a spawn construction site exists in the bootstrapping room
     */
    private ensureSpawnSite(room: Room): void {
        // Check for existing spawn construction site
        const existingSite = room.find(FIND_MY_CONSTRUCTION_SITES, {
            filter: s => s.structureType === STRUCTURE_SPAWN
        })[0];

        if (existingSite) return;

        // Find a good spawn location near controller
        const controller = room.controller;
        if (!controller) return;

        // Find position near controller with space around it
        const spawnPos = this.findSpawnPosition(room, controller.pos);
        if (!spawnPos) {
            log.warn("ExpansionManager", `Could not find spawn position in ${room.name}`);
            return;
        }

        const result = room.createConstructionSite(spawnPos.x, spawnPos.y, STRUCTURE_SPAWN);
        if (result === OK) {
            log.info("ExpansionManager", `Placed spawn construction site at ${spawnPos.x},${spawnPos.y} in ${room.name}`);
        }
    }

    /**
     * Find a suitable position for the first spawn
     */
    private findSpawnPosition(room: Room, near: RoomPosition): RoomPosition | null {
        const terrain = room.getTerrain();

        // Search in expanding circles from the controller
        for (let radius = 2; radius <= 10; radius++) {
            for (let dx = -radius; dx <= radius; dx++) {
                for (let dy = -radius; dy <= radius; dy++) {
                    // Only check perimeter of each radius
                    if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;

                    const x = near.x + dx;
                    const y = near.y + dy;

                    // Stay away from room edges
                    if (x < 3 || x > 46 || y < 3 || y > 46) continue;

                    // Must be buildable terrain
                    if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;

                    // Check that surrounding positions are clear (for extensions later)
                    let clearCount = 0;
                    for (let sx = -1; sx <= 1; sx++) {
                        for (let sy = -1; sy <= 1; sy++) {
                            if (terrain.get(x + sx, y + sy) !== TERRAIN_MASK_WALL) {
                                clearCount++;
                            }
                        }
                    }

                    // Need at least 7 clear tiles around (for extensions)
                    if (clearCount >= 7) {
                        return new RoomPosition(x, y, room.name);
                    }
                }
            }
        }

        return null;
    }

    /**
     * Request support creeps for bootstrapping new room
     */
    private requestBootstrapSupport(target: ExpansionTarget): void {
        const parentRoom = Game.rooms[target.parentRoom];
        if (!parentRoom) return;

        // Count existing support creeps
        const supporters = _.filter(Game.creeps, c =>
            c.memory.room === target.parentRoom &&
            c.memory.targetRoom === target.roomName
        );

        // Request workers if needed
        if (supporters.length < 3) {
            // This will be handled by demand calculations
            // Store bootstrap request in room memory
            if (!parentRoom.memory.bootstrapTargets) {
                parentRoom.memory.bootstrapTargets = [];
            }

            if (!parentRoom.memory.bootstrapTargets.includes(target.roomName)) {
                parentRoom.memory.bootstrapTargets.push(target.roomName);
            }
        }
    }

    /**
     * Run claimer creeps
     */
    private runClaimers(): void {
        for (const name in Game.creeps) {
            const creep = Game.creeps[name];
            if (creep.memory.bodyType !== BodyType.CLAIM) continue;
            if (creep.spawning) continue;

            this.runClaimer(creep);
        }
    }

    /**
     * Run individual claimer behavior
     */
    private runClaimer(creep: Creep): void {
        // Find target room from expansion targets
        const target = Memory.expansion?.targets.find(t =>
            t.status === "claiming" && !t.claimerId
        );

        if (!target) {
            // No target - assigned claimer behavior
            if (creep.memory.targetRoom) {
                this.moveToClaimRoom(creep, creep.memory.targetRoom);
            }
            return;
        }

        // Assign to target
        target.claimerId = creep.name;
        creep.memory.targetRoom = target.roomName;

        this.moveToClaimRoom(creep, target.roomName);
    }

    /**
     * Move claimer to target room and claim
     */
    private moveToClaimRoom(creep: Creep, targetRoom: string): void {
        if (creep.room.name !== targetRoom) {
            // Move to target room
            const exitDir = creep.room.findExitTo(targetRoom);
            if (exitDir !== ERR_NO_PATH && exitDir !== ERR_INVALID_ARGS) {
                const exit = creep.pos.findClosestByRange(exitDir as FindConstant);
                if (exit) {
                    creep.moveTo(exit, {
                        reusePath: 20,
                        visualizePathStyle: { stroke: "#ffff00" }
                    });
                }
            }
            return;
        }

        // In target room - claim controller
        const controller = creep.room.controller;
        if (!controller) return;

        if (creep.pos.isNearTo(controller)) {
            const result = creep.claimController(controller);
            if (result === OK) {
                log.info("ExpansionManager", `Claimer ${creep.name} claimed ${targetRoom}`);
            } else if (result === ERR_GCL_NOT_ENOUGH) {
                log.warn("ExpansionManager", `GCL not enough to claim ${targetRoom}`);
            }
        } else {
            creep.moveTo(controller, {
                reusePath: 10,
                visualizePathStyle: { stroke: "#ffff00" }
            });
        }
    }

    /**
     * Check if a room needs claimer spawned
     */
    needsClaimer(roomName: string): boolean {
        // Check if there's an active claiming target from this room
        const target = Memory.expansion?.targets?.find(t =>
            t.parentRoom === roomName &&
            t.status === "claiming"
        );

        if (!target) return false;

        // Check if claimer already exists
        const claimers = _.filter(Game.creeps, c =>
            c.memory.bodyType === BodyType.CLAIM &&
            c.memory.room === roomName
        );

        return claimers.length === 0;
    }

    /**
     * Get expansion targets for a room
     */
    getExpansionTargets(): ExpansionTarget[] {
        return Memory.expansion?.targets ?? [];
    }

    /**
     * Get rooms being bootstrapped
     */
    getBootstrappingRooms(): string[] {
        return (Memory.expansion?.targets ?? [])
            .filter(t => t.status === "bootstrapping")
            .map(t => t.roomName);
    }
}

// Extend Memory for expansion data
declare global {
    interface Memory {
        expansion?: {
            targets: ExpansionTarget[];
            lastEval: number;
        };
    }

    interface RoomMemory {
        bootstrapTargets?: string[];
    }
}

// Singleton instance
const expansionManagerInstance = new ExpansionManager();

export const expansionManagerModule = () => {
    expansionManagerInstance.manage();
};

export const expansionManager = expansionManagerInstance;
