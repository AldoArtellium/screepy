/**
 * TrafficManager - Centralized movement, backed by screeps-cartographer
 *
 * Features:
 * - Path caching, repath when stuck (cartographer)
 * - Priority-based traffic reconciliation: swapping and shoving idle creeps (cartographer)
 * - Stuck tracking for task failure detection
 * - Idle position finding
 *
 * Every creep that should hold its position (miners, upgraders...) must call
 * requestMove() every tick, even when already in range: this registers a
 * "stay in range" intent so the reconciler doesn't shove it away.
 */

import { moveTo, preTick, reconcileTraffic } from "screeps-cartographer";
import { countStat, recordSample } from "../utils/stats";
import { jitter } from "../utils/jitter";

/** Move request options */
interface MoveOptions {
    /** Range to target (default 1) */
    range?: number;
    /** Combat move: repath around creeps immediately */
    combat?: boolean;
    /** Custom priority (lower = higher priority, 0-100) */
    priority?: number;
    /** Visualize path */
    visualize?: boolean;
    /** Ticks before forcing a repath (default: reuse until stuck/target change) */
    reusePath?: number;
}

/** Last known position of a creep that wanted to move */
interface StuckState {
    tick: number;
    pos: string;
    stuckTicks: number;
}

/** Ticks before the idle-position candidate list is rebuilt */
const IDLE_CACHE_TTL = 500;

class TrafficManager {
    /** Move requests issued this tick (for stats) */
    private requestsThisTick = 0;
    private requestsTick = 0;

    /** Stuck tracking per creep (heap only) */
    private stuck: Map<string, StuckState> = new Map();

    /** Idle position candidates per room */
    private idleCandidates: Map<string, { until: number; positions: { x: number; y: number }[] }> = new Map();

    /** Idle positions handed out this tick, per room */
    private idleClaimed: Map<string, Set<number>> = new Map();
    private idleClaimedTick = 0;

    /**
     * Call once at the start of each tick
     */
    preTick(): void {
        preTick();
    }

    /**
     * Request movement for a creep. Call this instead of creep.moveTo().
     * When already in range, registers an intent to stay in range.
     */
    requestMove(
        creep: Creep | PowerCreep,
        target: RoomPosition | _HasRoomPosition,
        options: MoveOptions = {}
    ): ScreepsReturnCode {
        if (!creep.pos) return ERR_INVALID_TARGET; // unspawned power creep
        const targetPos = target instanceof RoomPosition ? target : target.pos;
        if (this.requestsTick !== Game.time) {
            this.requestsTick = Game.time;
            this.requestsThisTick = 0;
        }
        this.requestsThisTick++;

        const range = options.range ?? 1;
        const inRange = creep.pos.roomName === targetPos.roomName && creep.pos.inRangeTo(targetPos, range);
        this.trackStuck(creep, inRange);

        const priority = options.priority ?? this.getCreepPriority(creep);
        const moveOpts = {
            // cartographer: higher value = more important
            priority: 101 - Math.min(100, Math.max(0, priority)),
            reusePath: options.reusePath,
            avoidCreeps: options.combat ?? false,
            visualizePathStyle: options.visualize ? { stroke: options.combat ? "#ff0000" : "#ffffff", lineStyle: "dashed" as const } : undefined
        };
        // Stuck creeps: cartographer repaths with avoidCreeps, which marks every creep tile impassable,
        // the goal included. A goal held by creeps (a bay or drop spot taken, every tile next to a
        // controller taken) or a gap closed by creeps then has no path: ERR_NO_PATH every other tick and
        // the creep never moves. Keep the path through creeps then, the reconciler shoves or swaps them.
        const stuck = this.getStuckTicks(creep) >= 2;
        const avoidCreepsWhenStuck = !(stuck && goalHeldByCreeps(creep, targetPos, range));
        const goal = { pos: targetPos, range };
        let result = moveTo(creep, goal, moveOpts, { avoidCreeps: avoidCreepsWhenStuck });
        if (result === ERR_NO_PATH && stuck && avoidCreepsWhenStuck && !moveOpts.avoidCreeps) {
            // Creeps closed every way to the goal: the failed fallback reset the cached path, repath through them
            countStat("moveRetry");
            result = moveTo(creep, goal, moveOpts, { avoidCreeps: false });
        }
        if (result !== OK && result !== ERR_TIRED) {
            const what = "body" in creep ? creep.memory.role ?? "idle" : "powerCreep";
            countStat(`moveError:${result}:${what}`);
            recordSample("moveErrors", `${result} ${what} ${creep.pos} -> ${targetPos} r${range}`);
        }
        return result;
    }

    /**
     * Number of consecutive ticks the creep wanted to move but didn't
     */
    /**
     * Move a creep towards another room (cartographer paths across rooms; arrives when inside the room)
     */
    moveToRoom(creep: Creep | PowerCreep, roomName: string, options: Omit<MoveOptions, "range"> = {}): ScreepsReturnCode {
        return this.requestMove(creep, new RoomPosition(25, 25, roomName), { ...options, range: 20 });
    }

    getStuckTicks(creep: Creep | PowerCreep): number {
        const state = this.stuck.get(creep.name);
        if (!state || state.tick < Game.time - 1) return 0;
        return state.stuckTicks;
    }

    private trackStuck(creep: Creep | PowerCreep, inRange: boolean): void {
        const posKey = `${creep.pos.roomName}:${creep.pos.x},${creep.pos.y}`;
        const prev = this.stuck.get(creep.name);
        if (prev?.tick === Game.time) return;

        let stuckTicks = 0;
        const fatigue = "fatigue" in creep ? creep.fatigue : 0;
        if (!inRange && fatigue === 0 && prev && prev.tick === Game.time - 1 && prev.pos === posKey) {
            stuckTicks = prev.stuckTicks + 1;
        }
        this.stuck.set(creep.name, { tick: Game.time, pos: posKey, stuckTicks });
    }

    /**
     * Resolve all registered moves. Call once per tick, after all creep logic.
     */
    processMovement(): void {
        reconcileTraffic();

        // Drop stuck tracking for dead/inactive creeps
        if (Game.time % 100 === 0) {
            for (const [name, state] of this.stuck) {
                if (!Game.creeps[name] || state.tick < Game.time - 10) this.stuck.delete(name);
            }
        }
    }

    /**
     * Movement priority from the creep's role and order (lower = higher priority)
     */
    getCreepPriority(creep: Creep | PowerCreep): number {
        if (!("body" in creep)) return 20; // power creeps
        const role = creep.memory.role;
        if (role === "brawler" || role === "guardian" || role === "remoteDefender") return 0;
        if (role === "harvester") return 5;
        const order = creep.memory.order;
        if (order?.type === "spawn" || order?.type === "bay") return 10;
        if (role === "transporter" || role === "upgrader" || role === "builder") return 50;
        return order ? 50 : 100;
    }

    /**
     * Find an idle position for a creep (parking spot around the spawn)
     */
    findIdlePosition(creep: Creep): RoomPosition | null {
        const room = creep.room;
        const candidates = this.getIdleCandidates(room);
        if (candidates.length === 0) return null;

        if (this.idleClaimedTick !== Game.time) {
            this.idleClaimedTick = Game.time;
            this.idleClaimed.clear();
        }
        let claimed = this.idleClaimed.get(room.name);
        if (!claimed) {
            claimed = new Set();
            this.idleClaimed.set(room.name, claimed);
        }

        // Keep the current spot if it is a candidate
        const ownKey = creep.pos.y * 50 + creep.pos.x;
        if (!claimed.has(ownKey) && candidates.some(c => c.y * 50 + c.x === ownKey)) {
            claimed.add(ownKey);
            return creep.pos;
        }

        // Closest unclaimed candidate (other idle creeps get shoved by the reconciler if needed)
        let best: { x: number; y: number } | null = null;
        let bestRange = Infinity;
        for (const c of candidates) {
            const key = c.y * 50 + c.x;
            if (claimed.has(key)) continue;
            const range = Math.max(Math.abs(c.x - creep.pos.x), Math.abs(c.y - creep.pos.y));
            if (range < bestRange) {
                bestRange = range;
                best = c;
            }
        }
        if (!best) return null;

        claimed.add(best.y * 50 + best.x);
        return new RoomPosition(best.x, best.y, room.name);
    }

    private getIdleCandidates(room: Room): { x: number; y: number }[] {
        const cached = this.idleCandidates.get(room.name);
        if (cached && cached.until > Game.time) return cached.positions;

        const positions: { x: number; y: number }[] = [];
        const spawn = room.find(FIND_MY_SPAWNS)[0];
        if (spawn) {
            const terrain = room.getTerrain();
            const blocked = new Set<number>();
            // Any structure blocks parking, roads included (keep them free for traffic)
            for (const s of room.find(FIND_STRUCTURES)) {
                blocked.add(s.pos.y * 50 + s.pos.x);
            }
            for (const site of room.find(FIND_MY_CONSTRUCTION_SITES)) {
                blocked.add(site.pos.y * 50 + site.pos.x);
            }

            for (let radius = 3; radius <= 6; radius++) {
                for (let dx = -radius; dx <= radius; dx++) {
                    for (let dy = -radius; dy <= radius; dy++) {
                        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
                        const x = spawn.pos.x + dx;
                        const y = spawn.pos.y + dy;
                        if (x < 2 || x > 47 || y < 2 || y > 47) continue;
                        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
                        if (blocked.has(y * 50 + x)) continue;
                        positions.push({ x, y });
                    }
                }
            }
        }

        this.idleCandidates.set(room.name, { until: Game.time + jitter(IDLE_CACHE_TTL), positions });
        return positions;
    }

    /**
     * Invalidate cached data for a room (call when construction changes)
     */
    invalidateRoom(roomName: string): void {
        this.idleCandidates.delete(roomName);
    }

    /**
     * Get stats for dashboard
     */
    getStats(): { pathCacheSize: number; requestsThisTick: number } {
        return {
            pathCacheSize: 0,
            requestsThisTick: this.requestsTick === Game.time ? this.requestsThisTick : 0
        };
    }
}

/**
 * Every walkable tile within range of the goal holds another creep (only checked up to range 3, in a
 * visible room): a path avoiding creeps can't reach it.
 */
function goalHeldByCreeps(creep: Creep | PowerCreep, goal: RoomPosition, range: number): boolean {
    const room = Game.rooms[goal.roomName];
    if (!room || range > 3) return false;
    const terrain = room.getTerrain();
    const top = Math.max(0, goal.y - range);
    const left = Math.max(0, goal.x - range);
    const bottom = Math.min(49, goal.y + range);
    const right = Math.min(49, goal.x + range);
    const taken = new Set<number>();
    for (const { x, y, creep: other } of room.lookForAtArea(LOOK_CREEPS, top, left, bottom, right, true)) {
        if (other.id !== creep.id) taken.add(y * 50 + x);
    }
    for (const { x, y, powerCreep } of room.lookForAtArea(LOOK_POWER_CREEPS, top, left, bottom, right, true)) {
        if (powerCreep.id !== creep.id) taken.add(y * 50 + x);
    }
    if (taken.size === 0) return false;
    for (const { x, y, structure } of room.lookForAtArea(LOOK_STRUCTURES, top, left, bottom, right, true)) {
        if ((OBSTACLE_OBJECT_TYPES as string[]).includes(structure.structureType)) taken.add(y * 50 + x);
    }
    for (let y = top; y <= bottom; y++) {
        for (let x = left; x <= right; x++) {
            if (!taken.has(y * 50 + x) && terrain.get(x, y) !== TERRAIN_MASK_WALL) return false;
        }
    }
    return true;
}

// Singleton instance
const trafficManagerInstance = new TrafficManager();

export const trafficManagerModule = () => {
    trafficManagerInstance.processMovement();
};

export const trafficManager = trafficManagerInstance;
