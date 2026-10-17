/**
 * Remote mining: which neighbour sources an owned room mines, and their per-source state.
 * Ported from Hivemind (MIT): src/process/strategy/mining.ts, empire/remote-mine-prioritizer.ts,
 * empire/remote-path-manager.ts, operation/remote-mining.ts. See docs/hivemind/hivemind-remote.md.
 *
 * Every 20 ticks each owned room with a plan keeps its 5 best remote rooms (4 from RCL 4) within
 * 3 rooms, scored 3000 / shortest path from a source to the planned storage. No RCL or storage gate.
 */

import { intelManager } from "../modules/IntelManager";
import { isRoomUnderAttack } from "../modules/RoomIntel";
import { roomPlanner } from "../planner/RoomPlanner";
import { log } from "../utils/logger";

export interface RemoteSource {
    /** `${room}:${x}:${y}` */
    key: string;
    room: string;
    x: number;
    y: number;
    homeRoom: string;
    /** Path from the source (index 0 = container tile, next to the source) to the planned storage */
    path: string;
    travelTime: number;
    free: number;
    containerId?: Id<StructureContainer>;
}

interface PathCache {
    generated: number;
    /** Packed path, null when no path */
    path: string | null;
}

declare global {
    interface Memory {
        remoteMining?: {
            /** Selected sources, by key */
            sources: { [key: string]: RemoteSource };
            paths: { [key: string]: PathCache };
            lastSelect: number;
        };
    }
    interface RoomMemory {
        /** Reservation seen by our last reserver: { time, value } (Hivemind lastClaim) */
        lastClaim?: { time: number; value: number };
    }
}

const SELECT_INTERVAL = 20;
const MAX_ROOM_DISTANCE = 3;
const MAX_PATH_LENGTH = 200;
const PATH_TTL = 5000;
/** A failed path (no plan yet, blocked) is retried sooner than a found one */
const FAILED_PATH_TTL = 500;

function memory(): NonNullable<Memory["remoteMining"]> {
    if (!Memory.remoteMining) Memory.remoteMining = { sources: {}, paths: {}, lastSelect: 0 };
    return Memory.remoteMining;
}

export function sourceKey(room: string, x: number, y: number): string {
    return `${room}:${x}:${y}`;
}

function packPath(path: RoomPosition[]): string {
    return path.map(p => `${p.roomName},${p.x},${p.y}`).join(";");
}

export function unpackPath(packed: string): RoomPosition[] {
    if (!packed) return [];
    return packed.split(";").map(part => {
        const [room, x, y] = part.split(",");
        return new RoomPosition(Number(x), Number(y), room);
    });
}

/** Rooms owned by someone else (or an active invader core) are never crossed */
const matrixCache: Map<string, { tick: number; matrix: CostMatrix | false }> = new Map();
function remoteCostMatrix(roomName: string): CostMatrix | false {
    const cached = matrixCache.get(roomName);
    if (cached && Game.time - cached.tick < 1000) return cached.matrix;
    const intel = intelManager.getIntel(roomName);
    let matrix: CostMatrix | false = new PathFinder.CostMatrix();
    if (intel?.owner && intel.owner !== Memory.username) matrix = false;
    const room = Game.rooms[roomName];
    if (matrix && room) {
        const plan = roomPlanner.getPlan(roomName);
        for (const structure of room.find(FIND_STRUCTURES)) {
            if (structure.structureType === STRUCTURE_ROAD) matrix.set(structure.pos.x, structure.pos.y, 1);
            else if ((OBSTACLE_OBJECT_TYPES as string[]).includes(structure.structureType)) {
                matrix.set(structure.pos.x, structure.pos.y, 255);
            }
        }
        if (plan) {
            for (const pos of plan.getLocations("road")) if (matrix.get(pos.x, pos.y) === 0) matrix.set(pos.x, pos.y, 1);
            for (const type of ["harvester", "bay_center", "spawn", "extension", "tower", "storage", "terminal"]) {
                for (const pos of plan.getLocations(type)) matrix.set(pos.x, pos.y, 255);
            }
        }
    }
    matrixCache.set(roomName, { tick: Game.time, matrix });
    return matrix;
}

/** Path from a remote source to its home's planned storage, cached (Hivemind getPathFor) */
function pathFor(home: Room, sourcePos: RoomPosition): RoomPosition[] | null {
    const key = sourceKey(sourcePos.roomName, sourcePos.x, sourcePos.y);
    const cache = memory().paths[key];
    if (cache) {
        const ttl = cache.path ? PATH_TTL : FAILED_PATH_TTL;
        if (Game.time - cache.generated < ttl) return cache.path ? unpackPath(cache.path) : null;
    }
    const storagePos = roomPlanner.getPlan(home.name)?.getLocations("storage")[0];
    // No plan yet: don't cache the failure (Hivemind cached null for 5000 ticks)
    if (!storagePos) return null;
    const result = PathFinder.search(sourcePos, { pos: storagePos, range: 1 }, {
        plainCost: 2,
        swampCost: home.storage ? 3 : 10,
        maxOps: 10000,
        heuristicWeight: 1,
        roomCallback: remoteCostMatrix
    });
    const path = result.incomplete || result.path.length >= MAX_PATH_LENGTH ? null : result.path;
    memory().paths[key] = { generated: Game.time, path: path ? packPath(path) : null };
    return path;
}

/** Remote room candidates of a home room: known, not owned, not source keeper, within 3 rooms */
function candidateRooms(home: Room): string[] {
    return intelManager.getRoomsInRange(home.name, MAX_ROOM_DISTANCE).filter(roomName => {
        const intel = intelManager.getIntel(roomName);
        if (!intel?.sources?.length) return false;
        if (intel.owner || intel.hasSourceKeepers) return false;
        const route = Game.map.findRoute(home.name, roomName);
        return route !== ERR_NO_PATH && route.length <= MAX_ROOM_DISTANCE;
    });
}

function maxRemotes(home: Room): number {
    const spawns = Math.max(1, home.find(FIND_MY_SPAWNS).length);
    const needs = (home.controller!.level >= 4 ? 1 : 0) + (home.controller!.level >= 6 ? 1 : 0);
    return Math.floor(spawns * 5 - needs);
}

function selectRemotes(): void {
    const selected: { [key: string]: RemoteSource } = {};
    for (const name in Game.rooms) {
        const home = Game.rooms[name];
        if (!home.controller?.my || !roomPlanner.getPlan(home.name)) continue;
        const scored: { room: string; score: number; sources: RemoteSource[] }[] = [];
        for (const roomName of candidateRooms(home)) {
            const intel = intelManager.getIntel(roomName)!;
            const sources: RemoteSource[] = [];
            for (const source of intel.sources!) {
                const path = pathFor(home, new RoomPosition(source.x, source.y, roomName));
                if (!path || path.length === 0) continue;
                const key = sourceKey(roomName, source.x, source.y);
                sources.push({
                    key,
                    room: roomName,
                    x: source.x,
                    y: source.y,
                    homeRoom: home.name,
                    path: packPath(path),
                    travelTime: path.length,
                    free: source.free || 1,
                    containerId: memory().sources[key]?.containerId
                });
            }
            // Hivemind scored a room without any path 3000/500: such a room is skipped here
            if (sources.length === 0) continue;
            scored.push({ room: roomName, score: 3000 / _.min(sources.map(s => s.travelTime)), sources });
        }
        scored.sort((a, b) => b.score - a.score);
        for (const entry of scored.slice(0, maxRemotes(home))) {
            for (const source of entry.sources) selected[source.key] = source;
        }
    }
    const before = Object.keys(memory().sources).sort().join();
    memory().sources = selected;
    const after = Object.keys(selected).sort().join();
    if (before !== after) log.info("RemoteMining", `Remote sources: ${Object.keys(selected).join(" ") || "none"}`);
}

// ------------------------------------------------------------------ queries

/** Selected remote sources of a home room, closest first */
export function remoteSources(homeRoom: string): RemoteSource[] {
    return _.sortBy(
        _.filter(memory().sources, s => s.homeRoom === homeRoom),
        s => s.travelTime
    );
}

export function getRemoteSource(key: string | undefined): RemoteSource | undefined {
    return key ? memory().sources[key] : undefined;
}

export function sourcePos(source: RemoteSource): RoomPosition {
    return new RoomPosition(source.x, source.y, source.room);
}

/** Container tile: first tile of the path, next to the source */
export function containerPos(source: RemoteSource): RoomPosition {
    return unpackPath(source.path)[0];
}

/** The container of a remote source (remembered out of sight) */
export function remoteContainer(source: RemoteSource): StructureContainer | null {
    if (source.containerId) {
        const container = Game.getObjectById(source.containerId);
        if (container) return container;
        if (Game.rooms[source.room]) delete source.containerId;
        else return null;
    }
    const room = Game.rooms[source.room];
    if (!room) return null;
    const container = containerPos(source)
        .lookFor(LOOK_STRUCTURES)
        .find(s => s.structureType === STRUCTURE_CONTAINER) as StructureContainer | undefined;
    if (container) source.containerId = container.id;
    return container ?? null;
}

export function hasRemoteContainer(source: RemoteSource): boolean {
    if (source.containerId && !Game.rooms[source.room]) return true;
    return !!remoteContainer(source);
}

export function isRemoteUnderAttack(source: RemoteSource): boolean {
    if (isRoomUnderAttack(source.room)) return true;
    // Rooms crossed on the way
    const rooms = new Set(unpackPath(source.path).map(p => p.roomName));
    for (const room of rooms) if (room !== source.homeRoom && isRoomUnderAttack(room)) return true;
    return false;
}

export function remoteHasInvaderCore(source: RemoteSource): boolean {
    return !!Memory.rooms?.[source.room]?.enemies?.hasInvaderCore;
}

export interface EnemyData {
    damage: number;
    heal: number;
    ranged: boolean;
    hasInvaderCore: boolean;
}

/** Hostile strength in the remote and the rooms crossed on the way (Hivemind getTotalEnemyData) */
export function remoteEnemyData(source: RemoteSource): EnemyData {
    const total: EnemyData = { damage: 0, heal: 0, ranged: false, hasInvaderCore: false };
    const rooms = new Set(unpackPath(source.path).map(p => p.roomName));
    rooms.add(source.room);
    for (const room of rooms) {
        if (room === source.homeRoom) continue;
        const enemies = Memory.rooms?.[room]?.enemies;
        if (!enemies) continue;
        if (enemies.hasInvaderCore) total.hasInvaderCore = true;
        if (enemies.safe) continue;
        total.damage += enemies.damage ?? 0;
        total.heal += enemies.heal ?? 0;
        total.ranged = total.ranged || !!enemies.ranged;
    }
    return total;
}

// ------------------------------------------------------------------ maintenance (builders)

const heapCache: Map<string, { tick: number; value: unknown }> = new Map();
function inHeap<T>(key: string, ttl: number, compute: () => T): T {
    const cached = heapCache.get(key);
    if (cached && Game.time - cached.tick < ttl) return cached.value as T;
    const value = compute();
    heapCache.set(key, { tick: Game.time, value });
    return value;
}

function isOwnedRoom(roomName: string): boolean {
    return !!Game.rooms[roomName]?.controller?.my;
}

/** Path tiles outside our rooms: the remote builders keep a road on them */
export function remoteRoadPath(source: RemoteSource): RoomPosition[] {
    return unpackPath(source.path).filter(p => !isOwnedRoom(p.roomName));
}

/** WORK parts to keep a source's container and roads up: ceil(0.7 + 0.03 per tile outside our rooms) */
export function maintenanceWork(source: RemoteSource): number {
    return inHeap(`maintWork:${source.key}`, 500, () => Math.ceil(0.7 + 0.03 * remoteRoadPath(source).length));
}

/** Hits missing on a tile (out of sight: nothing); missing structure: its build cost x 100 */
function neededWorkAt(pos: RoomPosition, type: BuildableStructureConstant): number {
    if (!Game.rooms[pos.roomName]) return 0;
    const structure = pos.lookFor(LOOK_STRUCTURES).find(s => s.structureType === type);
    if (structure) return structure.hitsMax - structure.hits;
    return CONSTRUCTION_COST[type] * 100;
}

/** Container below half its hits, or a road of the path missing or below 2/3 of its hits */
export function needsRepairs(source: RemoteSource): boolean {
    return inHeap(`needsRepairs:${source.key}`, 50, () => {
        if (neededWorkAt(containerPos(source), STRUCTURE_CONTAINER) > CONTAINER_HITS / 2) return true;
        return remoteRoadPath(source).some(pos => neededWorkAt(pos, STRUCTURE_ROAD) > ROAD_HITS / 3);
    });
}

/** Hits missing on the container and the roads of the path */
export function neededWork(source: RemoteSource): number {
    return inHeap(`neededWork:${source.key}`, 50, () =>
        neededWorkAt(containerPos(source), STRUCTURE_CONTAINER) +
        _.sum(remoteRoadPath(source), pos => neededWorkAt(pos, STRUCTURE_ROAD))
    );
}

/** Path tiles of the remotes mined from a home room, in that room (Hivemind getOperationRoadPositions) */
export function operationRoadPositions(homeRoom: string): RoomPosition[] {
    return inHeap(`opRoads:${homeRoom}`, 100, () => {
        const positions: { [xy: number]: RoomPosition } = {};
        for (const source of remoteSources(homeRoom)) {
            for (const pos of unpackPath(source.path)) {
                if (pos.roomName === homeRoom) positions[pos.y * 50 + pos.x] = pos;
            }
        }
        return Object.values(positions);
    });
}

/** Hivemind canReserveFrom: a reserver can be spawned, so the source is assumed reserved (3000) */
export function canReserveFrom(home: Room, remoteRoom: string): boolean {
    const positions = intelManager.getIntel(remoteRoom)?.reservePositions ?? 0;
    return home.energyCapacityAvailable >= (positions > 1 ? 650 : 1300);
}

export function sourceEnergyCapacity(home: Room, source: RemoteSource): number {
    return canReserveFrom(home, source.room) ? SOURCE_ENERGY_CAPACITY : SOURCE_ENERGY_NEUTRAL_CAPACITY;
}

export const remoteMiningModule = () => {
    const mem = memory();
    if (Game.time - mem.lastSelect < SELECT_INTERVAL) return;
    mem.lastSelect = Game.time;
    selectRemotes();
    // Forget paths of sources no longer around
    for (const key in mem.paths) {
        if (Game.time - mem.paths[key].generated > 2 * PATH_TTL) delete mem.paths[key];
    }
};
