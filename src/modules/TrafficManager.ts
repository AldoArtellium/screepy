/**
 * TrafficManager - Centralized movement, backed by screeps-cartographer
 *
 * Features:
 * - Path caching, repath when stuck (cartographer)
 * - Priority-based traffic reconciliation: each room's intents are resolved first by `resolveTraffic`
 *   (push chains, swaps; cartographer's greedy pass froze two flows through a one-tile choke), then
 *   handed back to cartographer with one target per creep
 * - Stuck tracking for task failure detection
 * - Idle position finding
 *
 * Every creep that should hold its position (miners, upgraders...) must call
 * requestMove() every tick, even when already in range: this registers a
 * "stay in range" intent so the reconciler doesn't shove it away.
 */

import {
    adjacentWalkablePositions,
    clearCachedPath,
    getMoveIntents,
    move,
    moveTo,
    preTick,
    reconcileTraffic
} from "screeps-cartographer";
import { resolveTraffic, TrafficCreep } from "../core/traffic";
import { log } from "../utils/logger";
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
    x: number;
    y: number;
    roomName: string;
    stuckTicks: number;
    /** Consecutive ticks the creep landed on the mirror of its previous tile across a room edge */
    edgeBounces: number;
}

/** Edge crossings in a row onto the mirrored tile (A, B, A) that make a creep "bouncing" */
export const EDGE_BOUNCES = 2;

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

    /** Tiles a creep holding its range can't step on, per room (this tick only) */
    private obstacleTiles: Map<string, Set<number>> = new Map();
    private obstacleTilesTick = 0;

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
        if (inRange && !options.combat && this.canHoldCheaply(creep, targetPos)) {
            this.holdRange(creep, targetPos, range, 101 - Math.min(100, Math.max(0, priority)));
            return OK;
        }
        if (!inRange && range === 0) {
            const hop = this.sameEdgeHop(creep, targetPos);
            if (hop) {
                countStat("move:edgeHop");
                return move(creep, [hop], 101 - Math.min(100, Math.max(0, priority)));
            }
        }
        // Bounced between two rooms by an exit tile (the step off it failed, usually a creep on the tile
        // inside): the tile changes every tick, so neither our stuck count nor cartographer's sees it.
        // Repath around creeps, through them if that leaves no path.
        const bouncing = this.getEdgeBounces(creep) >= EDGE_BOUNCES;
        if (bouncing) clearCachedPath(creep);
        const moveOpts = {
            // cartographer: higher value = more important
            priority: 101 - Math.min(100, Math.max(0, priority)),
            reusePath: options.reusePath,
            avoidCreeps: (options.combat ?? false) || bouncing,
            visualizePathStyle: options.visualize ? { stroke: options.combat ? "#ff0000" : "#ffffff", lineStyle: "dashed" as const } : undefined
        };
        // Stuck creeps: cartographer repaths with avoidCreeps, which marks every creep tile impassable,
        // the goal included. A goal held by creeps (a bay or drop spot taken, every tile next to a
        // controller taken) or a gap closed by creeps then has no path: ERR_NO_PATH every other tick and
        // the creep never moves. Keep the path through creeps then, the reconciler shoves or swaps them.
        const stuck = this.getStuckTicks(creep) >= 2;
        const avoidCreepsWhenStuck = !(stuck && goalHeldByCreeps(creep, targetPos, range));
        const goal = { pos: targetPos, range };
        const attempt = (maxRooms?: number): ScreepsReturnCode => {
            const opts = maxRooms ? { ...moveOpts, maxRooms } : moveOpts;
            let result = moveTo(creep, goal, opts, { avoidCreeps: avoidCreepsWhenStuck });
            if (result === ERR_NO_PATH && bouncing && !options.combat) {
                countStat("moveRetry");
                result = moveTo(creep, goal, { ...opts, avoidCreeps: false }, { avoidCreeps: false });
            }
            if (result === ERR_NO_PATH && stuck && avoidCreepsWhenStuck && !moveOpts.avoidCreeps) {
                // Creeps closed every way to the goal: the failed fallback reset the cached path, repath through them
                countStat("moveRetry");
                result = moveTo(creep, goal, opts, { avoidCreeps: false });
            }
            return result;
        };
        // A goal in the creep's room is searched inside that room first: cartographer opens every
        // neighbour room for it, and a cheaper path along the border of the next room (W27N5's walled
        // southern pocket, swamps inside, plains on W27N4's top rows) took the creep out of the room,
        // where room-based role logic (pioneers, harvesters) sent it back: a bounce every tick.
        // Neighbour rooms only when the room has no path (a pocket only reachable from outside).
        const sameRoom = creep.pos.roomName === targetPos.roomName;
        let result = attempt(sameRoom ? 1 : undefined);
        if (result === ERR_NO_PATH && sameRoom) {
            countStat("moveOutOfRoom");
            result = attempt();
        }
        if (result !== OK && result !== ERR_TIRED) {
            const what = "body" in creep ? creep.memory.role ?? "idle" : "powerCreep";
            countStat(`moveError:${result}:${what}`);
            recordSample("moveErrors", `${result} ${what} ${creep.pos} -> ${targetPos} r${range}`);
        }
        return result;
    }

    /**
     * Step onto an adjacent tile (a tile of a stored path): registered with the reconciler like any
     * other move, so shoves and swaps still work, but without a path search.
     */
    requestStep(creep: Creep, pos: RoomPosition, priority?: number): ScreepsReturnCode {
        if (this.requestsTick !== Game.time) {
            this.requestsTick = Game.time;
            this.requestsThisTick = 0;
        }
        this.requestsThisTick++;
        this.trackStuck(creep, false);
        const p = priority ?? this.getCreepPriority(creep);
        return move(creep, [pos], 101 - Math.min(100, Math.max(0, p)));
    }

    /**
     * Engine PathFinder bug (native JPS, @screeps/driver pf.cc): from an exit tile, an exit tile of the
     * same edge 1 or 2 tiles away is never reached at range 0 (incomplete path, ERR_NO_PATH), even on
     * plain terrain and whatever maxRooms: the border rules only let the search leave the edge, and the
     * jump rules never turn back onto it that close (3+ tiles away works). Step onto the inner tile next
     * to both instead; from there the target is one step away. Null when the case doesn't apply or the
     * inner tiles are blocked.
     */
    private sameEdgeHop(creep: Creep | PowerCreep, targetPos: RoomPosition): RoomPosition | null {
        const { x, y, roomName } = creep.pos;
        if (targetPos.roomName !== roomName || creep.pos.getRangeTo(targetPos) > 2) return null;
        const onX = (x === 0 || x === 49) && targetPos.x === x;
        const onY = (y === 0 || y === 49) && targetPos.y === y;
        if (!onX && !onY) return null;
        const room = Game.rooms[roomName];
        if (!room) return null;
        const terrain = room.getTerrain();
        const obstacles = this.roomObstacles(room);
        // Inner tiles adjacent to both ends, the middle one first
        const from = onY ? x : y;
        const to = onY ? targetPos.x : targetPos.y;
        const inner = onY ? (y === 0 ? 1 : 48) : x === 0 ? 1 : 48;
        const candidates = [Math.round((from + to) / 2), from, to].filter(
            (c, i, all) => all.indexOf(c) === i && Math.abs(c - from) <= 1 && Math.abs(c - to) <= 1
        );
        for (const c of candidates) {
            const hx = onY ? c : inner;
            const hy = onY ? inner : c;
            if (terrain.get(hx, hy) === TERRAIN_MASK_WALL || obstacles.has(hy * 50 + hx)) continue;
            return new RoomPosition(hx, hy, roomName);
        }
        return null;
    }

    /**
     * Already in range in a room with a controller (no source keepers, no portals) and a target off the
     * room edge: cartographer's in-range branch can be reproduced without its cost matrix.
     */
    private canHoldCheaply(creep: Creep | PowerCreep, targetPos: RoomPosition): boolean {
        if (targetPos.x <= 0 || targetPos.x >= 49 || targetPos.y <= 0 || targetPos.y >= 49) return false;
        return !!Game.rooms[creep.pos.roomName]?.controller;
    }

    /**
     * Stay-in-range intent, same as cartographer moveTo once in range (the current tile first, then the
     * walkable adjacent tiles still in range, so the reconciler may shove the creep there) without
     * building a full cost matrix and looking at 8 tiles every tick: range 0 (harvesters, bay fillers,
     * upgrader spot) registers the current tile only.
     */
    private holdRange(creep: Creep | PowerCreep, targetPos: RoomPosition, range: number, priority: number): void {
        clearCachedPath(creep);
        const targets = [creep.pos];
        if (range > 0) {
            const room = Game.rooms[creep.pos.roomName];
            const terrain = room.getTerrain();
            const obstacles = this.roomObstacles(room);
            const { x: cx, y: cy, roomName } = creep.pos;
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    if (!dx && !dy) continue;
                    const x = cx + dx;
                    const y = cy + dy;
                    if (x < 0 || x > 49 || y < 0 || y > 49) continue;
                    if (Math.max(Math.abs(x - targetPos.x), Math.abs(y - targetPos.y)) > range) continue;
                    if (terrain.get(x, y) === TERRAIN_MASK_WALL || obstacles.has(y * 50 + x)) continue;
                    targets.push(new RoomPosition(x, y, roomName));
                }
            }
        }
        move(creep, targets, priority);
    }

    /** Obstacle structures, ramparts not ours and our obstacle construction sites (cartographer's rules) */
    private roomObstacles(room: Room): Set<number> {
        if (this.obstacleTilesTick !== Game.time) {
            this.obstacleTilesTick = Game.time;
            this.obstacleTiles.clear();
        }
        let tiles = this.obstacleTiles.get(room.name);
        if (tiles) return tiles;
        tiles = new Set();
        const obstacleTypes = OBSTACLE_OBJECT_TYPES as string[];
        for (const s of room.find(FIND_STRUCTURES)) {
            if (obstacleTypes.includes(s.structureType) || (s.structureType === STRUCTURE_RAMPART && !(s as StructureRampart).my)) {
                tiles.add(s.pos.y * 50 + s.pos.x);
            }
        }
        for (const site of room.find(FIND_MY_CONSTRUCTION_SITES)) {
            if (obstacleTypes.includes(site.structureType)) tiles.add(site.pos.y * 50 + site.pos.x);
        }
        this.obstacleTiles.set(room.name, tiles);
        return tiles;
    }

    /**
     * Move a creep towards another room (cartographer paths across rooms; arrives when inside the room)
     */
    moveToRoom(creep: Creep | PowerCreep, roomName: string, options: Omit<MoveOptions, "range"> = {}): ScreepsReturnCode {
        return this.requestMove(creep, new RoomPosition(25, 25, roomName), { ...options, range: 20 });
    }

    /** Number of consecutive ticks the creep wanted to move but didn't */
    getStuckTicks(creep: Creep | PowerCreep): number {
        const state = this.stuck.get(creep.name);
        if (!state || state.tick < Game.time - 1) return 0;
        return state.stuckTicks;
    }

    /**
     * Consecutive ticks the creep landed on the mirror of its previous tile across a room edge, this
     * tick included: 1 for a normal crossing, 2+ for a creep bounced between two rooms by an exit tile
     * it never leaves (its tile changes every tick, so the stuck count stays at 0).
     */
    getEdgeBounces(creep: Creep | PowerCreep): number {
        const state = this.stuck.get(creep.name);
        if (!state) return 0;
        if (state.tick === Game.time) return state.edgeBounces;
        if (state.tick < Game.time - 1) return 0;
        return isEdgeMirror(state, creep.pos) ? state.edgeBounces + 1 : 0;
    }

    private trackStuck(creep: Creep | PowerCreep, inRange: boolean): void {
        const { x, y, roomName } = creep.pos;
        const posKey = `${roomName}:${x},${y}`;
        const prev = this.stuck.get(creep.name);
        if (prev?.tick === Game.time) return;

        let stuckTicks = 0;
        let edgeBounces = 0;
        const fatigue = "fatigue" in creep ? creep.fatigue : 0;
        if (prev && prev.tick === Game.time - 1) {
            if (!inRange && fatigue === 0 && prev.pos === posKey) stuckTicks = prev.stuckTicks + 1;
            if (isEdgeMirror(prev, creep.pos)) edgeBounces = prev.edgeBounces + 1;
        }
        this.stuck.set(creep.name, { tick: Game.time, pos: posKey, x, y, roomName, stuckTicks, edgeBounces });
    }

    /**
     * Resolve all registered moves. Call once per tick, after all creep logic.
     */
    processMovement(): void {
        try {
            const rooms = new Set<string>();
            for (const name in Game.creeps) rooms.add(Game.creeps[name].pos.roomName);
            for (const roomName of rooms) {
                const room = Game.rooms[roomName];
                if (!room) continue;
                try {
                    this.resolveRoom(room);
                } catch (error) {
                    // the room keeps cartographer's own resolution this tick
                    log.error("TrafficManager", `resolveTraffic failed in ${roomName}:`, (error as Error).stack);
                    countStat("traffic:error");
                }
            }
        } finally {
            // creeps must move even if the resolution failed
            reconcileTraffic();
        }

        // Drop stuck tracking for dead/inactive creeps
        if (Game.time % 100 === 0) {
            for (const [name, state] of this.stuck) {
                if (!Game.creeps[name] || state.tick < Game.time - 10) this.stuck.delete(name);
            }
        }
    }

    /**
     * Resolves the room's move intents with `resolveTraffic` and registers each creep again with the
     * one tile it gets, so cartographer's reconcile only applies them. Creeps without an intent can be
     * shoved to any adjacent walkable tile, as in cartographer. Rooms with pulls or blocked squares
     * (none of our code uses them) are left to cartographer.
     */
    private resolveRoom(room: Room): void {
        const intents = getMoveIntents(room.name);
        if (intents.creep.size === 0) return;
        if (intents.pullers.size || intents.pullees.size || intents.blockedSquares.size) return;
        const creeps: (Creep | PowerCreep)[] = [...room.find(FIND_MY_CREEPS), ...room.find(FIND_MY_POWER_CREEPS)];
        if (!hasConflict(room.name, creeps, intents.creep)) return;
        // targets across the room edge get keys from 2500 up, one per tile
        const outside: RoomPosition[] = [];
        const outsideKeys = new Map<string, number>();
        const pack = (pos: RoomPosition): number => {
            if (pos.roomName === room.name) return pos.y * 50 + pos.x;
            const name = `${pos.roomName}:${pos.x},${pos.y}`;
            let packed = outsideKeys.get(name);
            if (packed === undefined) {
                packed = 2500 + outside.push(pos) - 1;
                outsideKeys.set(name, packed);
            }
            return packed;
        };
        const entries: { creep: Creep | PowerCreep; traffic: TrafficCreep }[] = [];
        for (const creep of creeps) {
            if ("spawning" in creep && creep.spawning) continue;
            const intent = intents.creep.get(creep.id);
            // a tired creep can't be shoved (cartographer's registerMove keeps it in place)
            const tired = "fatigue" in creep && creep.fatigue > 0;
            const targets =
                intent?.targets ?? (tired ? [creep.pos] : [creep.pos, ...adjacentWalkablePositions(creep.pos, true)]);
            entries.push({
                creep,
                traffic: {
                    id: creep.id,
                    pos: pack(creep.pos),
                    priority: intent?.priority ?? 0,
                    targets: targets.map(pack)
                }
            });
        }
        const { moves, pushed, blocked } = resolveTraffic(entries.map(e => e.traffic));
        for (const { creep, traffic } of entries) {
            const tile = moves.get(traffic.id) ?? traffic.pos;
            // cartographer reaches the same tile when it is the first target (no one else claims it)
            if (tile === traffic.targets[0]) continue;
            const pos =
                tile < 2500 ? new RoomPosition(tile % 50, Math.floor(tile / 50), room.name) : outside[tile - 2500];
            move(creep, [pos], traffic.priority);
        }
        if (pushed) countStat("traffic:pushed", pushed);
        if (blocked) countStat("traffic:blocked", blocked);
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
 * Some creep wants a tile held by another creep, or two creeps want the same first tile: without
 * that, cartographer's greedy pass gives every creep its first target and the room needs no resolution.
 */
function hasConflict(
    roomName: string,
    creeps: (Creep | PowerCreep)[],
    intents: Map<Id<Creep | PowerCreep>, { creep: Creep | PowerCreep; targets: RoomPosition[] }>
): boolean {
    const occupied = new Set<number>();
    for (const creep of creeps) occupied.add(creep.pos.y * 50 + creep.pos.x);
    const wanted = new Set<number>();
    for (const { creep, targets } of intents.values()) {
        const target = targets[0];
        if (!target || target.roomName !== roomName || target.isEqualTo(creep.pos)) continue;
        const tile = target.y * 50 + target.x;
        if (occupied.has(tile) || wanted.has(tile)) return true;
        wanted.add(tile);
    }
    return false;
}

/** `b` is the tile across a room edge from `a` (where the engine carries a creep standing on exit tile `a`) */
function isEdgeMirror(a: { x: number; y: number; roomName: string }, b: RoomPosition): boolean {
    if (a.roomName === b.roomName) return false;
    if (a.x === b.x) return (a.y === 0 && b.y === 49) || (a.y === 49 && b.y === 0);
    if (a.y === b.y) return (a.x === 0 && b.x === 49) || (a.x === 49 && b.x === 0);
    return false;
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
