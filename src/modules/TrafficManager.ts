/**
 * TrafficManager - Centralized movement and path management
 *
 * Features:
 * - Queued movement requests with priority
 * - CostMatrix caching per room
 * - Path caching for frequently used routes
 * - Collision avoidance and swap logic
 * - Idle position finding
 */

import { log } from "../utils/logger";
import { TaskType } from "../types/TaskTypes";

/** Movement cost constants */
const COSTS = {
    ROAD: 1,
    PLAIN: 2,
    SWAMP: 10,
    STRUCTURE: 255,
    CREEP: 255,
    CONSTRUCTION_SITE: 3
};

/** Path cache settings */
const PATH_CACHE = {
    /** Maximum entries in global path cache */
    MAX_ENTRIES: 500,
    /** Ticks before path is considered stale */
    STALE_AGE: 5000,
    /** Cleanup interval */
    CLEANUP_INTERVAL: 100,
    /** Minimum uses before caching to Memory */
    MIN_USES_FOR_MEMORY: 5,
    /** Maximum path length to cache */
    MAX_PATH_LENGTH: 100
};

/** Move request options */
interface MoveOptions {
    /** Range to target (default 1) */
    range?: number;
    /** Whether this is a combat move (prefer shorter paths) */
    combat?: boolean;
    /** Custom priority (lower = higher priority) */
    priority?: number;
    /** Visualize path */
    visualize?: boolean;
    /** Reuse cached creep path for N ticks */
    reusePath?: number;
}

/** Internal move request */
interface MoveRequest {
    creep: Creep;
    target: RoomPosition;
    range: number;
    priority: number;
    options: MoveOptions;
}

/** Cached path entry */
interface CachedPath {
    /** Path steps */
    path: PathStep[];
    /** Cost of path */
    cost: number;
    /** When cached */
    tick: number;
    /** Times used */
    uses: number;
}

class TrafficManager {
    /** Move requests for current tick */
    private moveRequests: Map<string, MoveRequest> = new Map();

    /** CostMatrix cache (per room, regenerated each tick) */
    private costMatrices: Map<string, CostMatrix> = new Map();

    /** Session path cache (heap-only, cleared on global reset) */
    private pathCache: Map<string, CachedPath> = new Map();

    /** Intended positions for collision detection */
    private intendedPositions: Map<string, string> = new Map(); // posKey -> creepName

    /**
     * Request movement for a creep
     * Call this instead of creep.moveTo()
     */
    requestMove(creep: Creep, target: RoomPosition, options: MoveOptions = {}): void {
        const range = options.range ?? 1;

        // Already at target
        if (creep.pos.inRangeTo(target, range)) {
            return;
        }

        const priority = options.priority ?? this.getCreepPriority(creep);

        this.moveRequests.set(creep.name, {
            creep,
            target,
            range,
            priority,
            options
        });
    }

    /**
     * Process all queued movement requests
     * Should be called once per tick, after all requestMove calls
     */
    processMovement(): void {
        // Clear per-tick caches
        this.costMatrices.clear();
        this.intendedPositions.clear();

        if (this.moveRequests.size === 0) return;

        // Sort requests by priority (lower = higher priority)
        const sortedRequests = [...this.moveRequests.values()].sort(
            (a, b) => a.priority - b.priority
        );

        // Process each request
        for (const request of sortedRequests) {
            this.executeMove(request);
        }

        // Clear requests for next tick
        this.moveRequests.clear();

        // Periodic cleanup
        if (Game.time % PATH_CACHE.CLEANUP_INTERVAL === 0) {
            this.cleanupPathCache();
        }
    }

    /**
     * Execute a single move request
     */
    private executeMove(request: MoveRequest): void {
        const { creep, target, range, options } = request;

        // Check if creep can reuse existing path
        const reusePath = options.reusePath ?? 5;
        if (reusePath > 0 && this.canReusePath(creep, target, reusePath)) {
            const path = this.deserializePath(creep.memory._path!);
            if (path && path.length > 0) {
                const nextStep = path[0];
                this.moveCreepToPosition(creep, nextStep.x, nextStep.y, options);
                this.updateCreepPath(creep, path.slice(1));
                return;
            }
        }

        // Find path
        const path = this.findPath(creep.pos, target, creep.room.name, range, options);
        if (!path || path.length === 0) {
            log.debug("TrafficManager", `No path for ${creep.name} to ${target}`);
            return;
        }

        // Move to first step
        const nextStep = path[0];
        this.moveCreepToPosition(creep, nextStep.x, nextStep.y, options);

        // Cache remaining path for reuse
        if (path.length > 1 && reusePath > 0) {
            this.updateCreepPath(creep, path.slice(1), target);
        }
    }

    /**
     * Move creep to a specific position with collision handling
     */
    private moveCreepToPosition(creep: Creep, x: number, y: number, options: MoveOptions): void {
        const posKey = `${creep.room.name}:${x},${y}`;

        // Check for collision
        const existingCreep = this.intendedPositions.get(posKey);
        if (existingCreep) {
            const other = Game.creeps[existingCreep];
            if (other && this.canSwap(creep, other)) {
                // Swap positions
                this.intendedPositions.set(posKey, creep.name);
                const otherPosKey = `${creep.room.name}:${creep.pos.x},${creep.pos.y}`;
                this.intendedPositions.set(otherPosKey, other.name);
                // Both creeps move
                const dirToTarget = creep.pos.getDirectionTo(x, y);
                const dirToCreep = other.pos.getDirectionTo(creep.pos);
                creep.move(dirToTarget);
                other.move(dirToCreep);
                return;
            }
            // Can't swap - skip this creep's movement
            return;
        }

        // Reserve position
        this.intendedPositions.set(posKey, creep.name);

        // Execute move
        const direction = creep.pos.getDirectionTo(x, y);

        // Visualize if requested
        if (options.visualize) {
            const color = options.combat ? "#ff0000" : "#ffffff";
            new RoomVisual(creep.room.name).line(creep.pos, new RoomPosition(x, y, creep.room.name), {
                color,
                lineStyle: "dashed"
            });
        }

        creep.move(direction);
    }

    /**
     * Check if two creeps can swap positions
     */
    private canSwap(creep1: Creep, creep2: Creep): boolean {
        // Can only swap if adjacent
        if (!creep1.pos.isNearTo(creep2)) return false;

        // Don't swap if one is fatigued
        if (creep1.fatigue > 0 || creep2.fatigue > 0) return false;

        // Don't swap with creeps working at containers/sources
        const task1 = creep1.memory.currentTask;
        const task2 = creep2.memory.currentTask;

        if (task1?.type === TaskType.HARVEST_SOURCE && task1.state === "executing") return false;
        if (task2?.type === TaskType.HARVEST_SOURCE && task2.state === "executing") return false;

        return true;
    }

    /**
     * Find a path using PathFinder with caching
     */
    findPath(
        origin: RoomPosition,
        target: RoomPosition,
        roomName: string,
        range: number,
        _options: MoveOptions = {}
    ): PathStep[] | null {
        // Check session cache first
        const cacheKey = this.getPathCacheKey(origin, target, range);
        const cached = this.pathCache.get(cacheKey);
        if (cached && Game.time - cached.tick < PATH_CACHE.STALE_AGE) {
            cached.uses++;
            return cached.path;
        }

        // Use PathFinder
        const result = PathFinder.search(origin, { pos: target, range }, {
            plainCost: COSTS.PLAIN,
            swampCost: COSTS.SWAMP,
            roomCallback: (room) => this.getCostMatrix(room)
        });

        if (result.incomplete) {
            log.debug("TrafficManager", `Incomplete path from ${origin} to ${target}`);
        }

        // Convert to PathStep array
        const path: PathStep[] = result.path.map((pos, i) => {
            const prev = i === 0 ? origin : result.path[i - 1];
            return {
                x: pos.x,
                y: pos.y,
                dx: pos.x - prev.x,
                dy: pos.y - prev.y,
                direction: prev.getDirectionTo(pos)
            };
        });

        // Cache if path is reasonable length
        if (path.length > 0 && path.length <= PATH_CACHE.MAX_PATH_LENGTH) {
            this.pathCache.set(cacheKey, {
                path,
                cost: result.cost,
                tick: Game.time,
                uses: 1
            });
        }

        return path;
    }

    /**
     * Get or generate CostMatrix for a room
     */
    getCostMatrix(roomName: string): CostMatrix | false {
        // Check tick cache
        const cached = this.costMatrices.get(roomName);
        if (cached) return cached;

        const room = Game.rooms[roomName];
        if (!room) return false;

        const matrix = new PathFinder.CostMatrix();

        // Mark structures
        const structures = room.find(FIND_STRUCTURES);
        for (const structure of structures) {
            if (structure.structureType === STRUCTURE_ROAD) {
                matrix.set(structure.pos.x, structure.pos.y, COSTS.ROAD);
            } else if (
                (structure.structureType !== STRUCTURE_CONTAINER &&
                 structure.structureType !== STRUCTURE_RAMPART) ||
                (structure.structureType === STRUCTURE_RAMPART && !(structure as StructureRampart).my)
            ) {
                matrix.set(structure.pos.x, structure.pos.y, COSTS.STRUCTURE);
            }
        }

        // Mark construction sites (slightly higher cost to avoid but still walkable)
        const sites = room.find(FIND_MY_CONSTRUCTION_SITES);
        for (const site of sites) {
            const current = matrix.get(site.pos.x, site.pos.y);
            if (current < COSTS.STRUCTURE) {
                matrix.set(site.pos.x, site.pos.y, COSTS.CONSTRUCTION_SITE);
            }
        }

        // Mark creeps (avoid but don't block completely for collision handling)
        const creeps = room.find(FIND_CREEPS);
        for (const creep of creeps) {
            // Don't mark our own creeps that might swap
            if (creep.my) {
                matrix.set(creep.pos.x, creep.pos.y, 10);
            } else {
                matrix.set(creep.pos.x, creep.pos.y, COSTS.CREEP);
            }
        }

        this.costMatrices.set(roomName, matrix);
        return matrix;
    }

    /**
     * Get priority for a creep based on its current task
     */
    getCreepPriority(creep: Creep): number {
        const task = creep.memory.currentTask;
        if (!task) return 100;

        // Combat creeps get highest priority
        if (task.type === TaskType.ATTACK_HOSTILE || task.type === TaskType.DEFEND_RAMPART) {
            return 0;
        }

        // Haulers with full cargo get high priority
        if (task.type === TaskType.FILL_SPAWN || task.type === TaskType.FILL_EXTENSION) {
            const fillRatio = creep.store.getUsedCapacity() / creep.store.getCapacity();
            if (fillRatio > 0.5) return 10;
        }

        // Harvesters at sources get high priority (don't interrupt mining)
        if (task.type === TaskType.HARVEST_SOURCE && task.state === "executing") {
            return 5;
        }

        // Default priority
        return 50;
    }

    /**
     * Find an idle position for a creep (parking spot)
     */
    findIdlePosition(creep: Creep): RoomPosition | null {
        const room = creep.room;

        // Check cached idle positions
        if (room.memory.idlePositions && room.memory.idlePositions.length > 0) {
            for (const pos of room.memory.idlePositions) {
                const roomPos = new RoomPosition(pos.x, pos.y, room.name);
                const look = roomPos.look();
                const hasCreep = look.some(l => l.type === LOOK_CREEPS);
                if (!hasCreep) {
                    return roomPos;
                }
            }
        }

        // Find spawn and stay nearby but not blocking
        const spawn = room.find(FIND_MY_SPAWNS)[0];
        if (!spawn) return null;

        const terrain = room.getTerrain();

        // Search in expanding rings around spawn
        for (let radius = 3; radius <= 6; radius++) {
            for (let dx = -radius; dx <= radius; dx++) {
                for (let dy = -radius; dy <= radius; dy++) {
                    if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;

                    const x = spawn.pos.x + dx;
                    const y = spawn.pos.y + dy;

                    if (x < 1 || x > 48 || y < 1 || y > 48) continue;
                    if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;

                    const pos = new RoomPosition(x, y, room.name);
                    const look = pos.look();

                    // Skip if has structure (except roads)
                    if (look.some(l =>
                        l.type === LOOK_STRUCTURES &&
                        l.structure!.structureType !== STRUCTURE_ROAD
                    )) continue;

                    // Skip if has creep
                    if (look.some(l => l.type === LOOK_CREEPS)) continue;

                    return pos;
                }
            }
        }

        return null;
    }

    /**
     * Generate cache key for a path
     */
    private getPathCacheKey(origin: RoomPosition, target: RoomPosition, range: number): string {
        return `${origin.roomName}:${origin.x},${origin.y}-${target.roomName}:${target.x},${target.y}:${range}`;
    }

    /**
     * Check if creep can reuse its cached path
     */
    private canReusePath(creep: Creep, target: RoomPosition, maxAge: number): boolean {
        if (!creep.memory._path || !creep.memory._pathTick || !creep.memory._pathTarget) {
            return false;
        }

        // Check age
        if (Game.time - creep.memory._pathTick >= maxAge) {
            return false;
        }

        // Check if target changed
        const targetKey = `${target.roomName}:${target.x},${target.y}`;
        if (creep.memory._pathTarget !== targetKey) {
            return false;
        }

        return true;
    }

    /**
     * Update creep's cached path
     */
    private updateCreepPath(creep: Creep, path: PathStep[], target?: RoomPosition): void {
        if (path.length === 0) {
            delete creep.memory._path;
            delete creep.memory._pathTick;
            delete creep.memory._pathTarget;
            return;
        }

        creep.memory._path = this.serializePath(path);
        creep.memory._pathTick = Game.time;
        if (target) {
            creep.memory._pathTarget = `${target.roomName}:${target.x},${target.y}`;
        }
    }

    /**
     * Serialize path for memory storage
     * Format: "x,y,dir|x,y,dir|..."
     */
    serializePath(path: PathStep[]): string {
        return path.map(s => `${s.x},${s.y},${s.direction}`).join("|");
    }

    /**
     * Deserialize path from memory
     */
    deserializePath(serialized: string): PathStep[] | null {
        if (!serialized) return null;

        try {
            return serialized.split("|").map(s => {
                const [x, y, dir] = s.split(",").map(Number);
                return {
                    x,
                    y,
                    dx: 0,
                    dy: 0,
                    direction: dir as DirectionConstant
                };
            });
        } catch {
            return null;
        }
    }

    /**
     * Clean up stale paths from session cache
     */
    private cleanupPathCache(): void {
        const now = Game.time;
        let cleaned = 0;

        for (const [key, cached] of this.pathCache.entries()) {
            // Remove stale or rarely used paths
            if (now - cached.tick > PATH_CACHE.STALE_AGE || cached.uses < 2) {
                this.pathCache.delete(key);
                cleaned++;
            }
        }

        // Trim if too large
        if (this.pathCache.size > PATH_CACHE.MAX_ENTRIES) {
            const entries = [...this.pathCache.entries()]
                .sort((a, b) => a[1].uses - b[1].uses);

            const toRemove = entries.slice(0, this.pathCache.size - PATH_CACHE.MAX_ENTRIES);
            for (const [key] of toRemove) {
                this.pathCache.delete(key);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            log.debug("TrafficManager", `Cleaned ${cleaned} cached paths`);
        }
    }

    /**
     * Invalidate paths for a room (call when construction changes)
     */
    invalidateRoom(roomName: string): void {
        // Clear session cache for this room
        for (const key of this.pathCache.keys()) {
            if (key.includes(roomName)) {
                this.pathCache.delete(key);
            }
        }

        // Mark room as invalidated for Memory cache cleanup
        if (!Memory.traffic) {
            Memory.traffic = { lastCleanup: Game.time, invalidatedRooms: [] };
        }
        if (!Memory.traffic.invalidatedRooms.includes(roomName)) {
            Memory.traffic.invalidatedRooms.push(roomName);
        }

        log.debug("TrafficManager", `Invalidated paths for room ${roomName}`);
    }

    /**
     * Get stats for dashboard
     */
    getStats(): { pathCacheSize: number; requestsThisTick: number } {
        return {
            pathCacheSize: this.pathCache.size,
            requestsThisTick: this.moveRequests.size
        };
    }
}

// Singleton instance
const trafficManagerInstance = new TrafficManager();

export const trafficManagerModule = () => {
    trafficManagerInstance.processMovement();
};

export const trafficManager = trafficManagerInstance;
