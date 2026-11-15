/**
 * Remote mining: which neighbour sources an owned room mines, and their per-source state.
 * Ported from Hivemind (MIT): src/process/strategy/mining.ts, empire/remote-mine-prioritizer.ts,
 * empire/remote-path-manager.ts, operation/remote-mining.ts. See docs/hivemind/hivemind-remote.md.
 *
 * Every 20 ticks each owned room with a plan keeps at most 5 remote rooms (4 from RCL 4) within
 * 3 rooms. Not Hivemind (3000 / shortest path): sources are ranked by net energy per tick once their
 * creeps are paid (remoteIncome.ts, Harabi) per body part they keep the spawn busy with; a home whose
 * spawn leaves a selected source without harvester mines one source less (updateSourceCap).
 * No RCL or storage gate.
 */

import { creepsByRole } from "../core/roomState";
import { intelManager } from "../modules/IntelManager";
import { hasInvaderCore, isRoomContested, isRoomUnderAttack, releasedPlayer } from "../modules/RoomIntel";
import { roomPlanner } from "../planner/RoomPlanner";
import { log } from "../utils/logger";
import { spawnManager } from "../modules/SpawnManager";
import { trafficManager } from "../modules/TrafficManager";
import { decisionBucket } from "../utils/throttle";
import { decodePath, encodePath } from "../utils/pathCodec";
import { isKeeperRoom, parseRoomName, roomsInRange, roomStatus } from "../utils/rooms";
import { segmentStore } from "../utils/segments";
import { countStat } from "../utils/stats";
import { jitter, jitterFor } from "../utils/jitter";
import {
    budgetRooms,
    INTENT_CPU,
    cpuAverage,
    escortShare,
    remoteCapacity,
    reserverCost,
    roomEnergyPerCreep,
    SourceCrew,
    sourceCreeps,
    sourceNet,
    sourceParts,
    worthMining
} from "./remoteIncome";
import { blockerCost } from "./blockers";
import { isKeeperOrCenter, keeperRoomCandidate, killerParts, partsCost } from "./keepers";
import { isRemoteExcluded } from "./remoteBalance";
import { isRemoteBlocked, pickSourceContainer } from "./remoteRooms";
import { updateSeizes } from "./remoteSeize";
import { Hits, onRoomEdge, PathNeed, pathNeed, repairsDue, Tile, upkeepWork } from "./repairs";

export interface RemoteSource {
    /** `${room}:${x}:${y}` */
    key: string;
    room: string;
    x: number;
    y: number;
    homeRoom: string;
    travelTime: number;
    free: number;
    containerId?: Id<StructureContainer>;
    /** Last selection tick the source had a remote harvester (or a reason to have none) */
    servedAt?: number;
}

interface PathCache {
    generated: number;
    /**
     * Path from the source (index 0 = container tile, next to the source) to the planned storage,
     * packed by utils/pathCodec; null when no path
     */
    path: string | null;
    /** Home room of a failed search (a found path ends in its home) */
    home?: string;
}

declare global {
    interface Memory {
        remoteMining?: {
            /** Selected sources, by key */
            sources: { [key: string]: RemoteSource };
            lastSelect: number;
            /** CPU budget: slow average of the tick CPU, remote rooms allowed empire-wide (none = no cap yet) */
            cpuAvg?: number;
            maxRooms?: number;
            budgetChanged?: number;
            /** Last tick the cap went down (no room added for BUDGET_RAISE_HOLD ticks after it) */
            budgetDropped?: number;
            /** Last tick the cap went up or was lifted (no room added for BUDGET_RAISE_SETTLE ticks after it) */
            budgetRaised?: number;
            /** Slow average of the CPU per tick of one mined remote room (its remote roles' CPU and moves) */
            roomCpu?: number;
            /** Sum of the remote roles' CPU counters at the last budget update, and its tick */
            roleCpu?: { total: number; tick: number };
            /** Sources a home's spawn can keep harvested (none = no cap yet), by home room */
            sourceCaps?: { [home: string]: { max: number; changed: number } };
            /** Share of the ticks every spawn of a home was spawning or waiting for energy, ~400 ticks average, by home */
            spawnBusy?: { [home: string]: number };
        };
    }
    interface RoomMemory {
        /** Reservation seen by our last reserver: { time, value } (Hivemind lastClaim) */
        lastClaim?: { time: number; value: number };
    }
}

const SELECT_INTERVAL = 20;
export const MAX_ROOM_DISTANCE = 3;
const MAX_PATH_LENGTH = 200;
const PATH_TTL = 5000;
/** A failed path (no plan yet, blocked) is retried sooner than a found one */
const FAILED_PATH_TTL = 500;

/**
 * Paths of the candidate sources, by source key (the only copy of a selected source's path), in
 * RawMemory segment 5 (utils/segments.ts, heap copy). A global reset loses at most 20 ticks of new
 * paths (recomputed).
 */
const pathStore = segmentStore<{ [key: string]: PathCache }>("remotePaths", [5], 20);

function paths(): { [key: string]: PathCache } {
    return pathStore.get();
}

function memory(): NonNullable<Memory["remoteMining"]> {
    Memory.remoteMining ??= { sources: {}, lastSelect: 0 };
    return Memory.remoteMining;
}

export function sourceKey(room: string, x: number, y: number): string {
    return `${room}:${x}:${y}`;
}

/** Decoded paths, by packed string (heap): decoding a remote path each call cost ~0.5 CPU/tick */
const unpacked: Map<string, RoomPosition[]> = new Map();

const pathRoomsCache: Map<string, string[]> = new Map();

/** Rooms a packed path crosses */
function roomsOf(packed: string): string[] {
    let rooms = pathRoomsCache.get(packed);
    if (!rooms) {
        rooms = [...new Set(unpackPath(packed).map(p => p.roomName))];
        if (pathRoomsCache.size > 200) pathRoomsCache.clear();
        pathRoomsCache.set(packed, rooms);
    }
    return rooms;
}

/** Rooms a remote path crosses, the remote room included */
function pathRooms(source: RemoteSource): string[] {
    const rooms = roomsOf(packedPath(source));
    return rooms.includes(source.room) ? rooms : rooms.concat(source.room);
}

/**
 * Another player's room or remote (reserved, or mined / reserved by them within ~20000 ticks), or a
 * source keeper room: never mined nor crossed on the way to a remote (remoteRooms.ts). A keeper room
 * `home` mines (its killer clears it) is crossed by that home's paths: the way to the sector center.
 */
function isBlockedRoom(roomName: string, home?: string): boolean {
    return isRemoteBlocked(
        roomName,
        intelManager.getIntel(roomName),
        Memory.username,
        isRoomContested(roomName),
        releasedPlayer(roomName),
        home !== undefined && isRemoteRoomMined(home, roomName)
    );
}

/** A keeper room (name or intel): mined behind a keeperKiller */
export function isKeeperRemote(roomName: string): boolean {
    return isKeeperRoom(roomName) || !!intelManager.getIntel(roomName)?.hasSourceKeepers;
}

/** An invader stronghold is active in the room (military intel, until its collapse) */
function hasStronghold(roomName: string): boolean {
    const intel = Memory.military?.rooms?.[roomName];
    if ((intel?.coreLevel ?? 0) <= 0) return false;
    return intel?.collapse === undefined || intel.collapse > Game.time;
}

/** Positions of a packed path; the array is shared, don't modify it */
function unpackPath(packed: string): RoomPosition[] {
    if (!packed) return [];
    let path = unpacked.get(packed);
    if (!path) {
        path = decodePath(packed);
        if (unpacked.size > 200) unpacked.clear();
        unpacked.set(packed, path);
    }
    return path;
}

function packedPath(source: RemoteSource): string {
    return paths()[source.key]?.path ?? "";
}

/** Path of a selected source to the planned storage (index 0 = container tile); shared, don't modify it */
export function remotePath(source: RemoteSource): RoomPosition[] {
    return unpackPath(packedPath(source));
}

/** Cost of a tile within MINERAL_KEEPER_RANGE of a keeper room's mineral */
const MINERAL_KEEPER_COST = 50;
const MINERAL_KEEPER_RANGE = 4;

function avoidMineralKeeper(matrix: CostMatrix, room: Room): void {
    const terrain = room.getTerrain();
    for (const mineral of room.find(FIND_MINERALS)) {
        for (let dx = -MINERAL_KEEPER_RANGE; dx <= MINERAL_KEEPER_RANGE; dx++) {
            for (let dy = -MINERAL_KEEPER_RANGE; dy <= MINERAL_KEEPER_RANGE; dy++) {
                const x = mineral.pos.x + dx;
                const y = mineral.pos.y + dy;
                if (x < 0 || x > 49 || y < 0 || y > 49 || terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
                if (matrix.get(x, y) < MINERAL_KEEPER_COST) matrix.set(x, y, MINERAL_KEEPER_COST);
            }
        }
    }
}

/** Rooms owned by someone else (or an active invader core) are never crossed */
const matrixCache: Map<string, { until: number; matrix: CostMatrix | false }> = new Map();
function remoteCostMatrix(roomName: string): CostMatrix | false {
    const cached = matrixCache.get(roomName);
    if (cached && cached.until > Game.time) return cached.matrix;
    const intel = intelManager.getIntel(roomName);
    let matrix: CostMatrix | false = new PathFinder.CostMatrix();
    if (intel?.owner && intel.owner !== Memory.username) matrix = false;
    const room = Game.rooms[roomName];
    if (matrix && room) {
        const plan = roomPlanner.getPlan(roomName);
        for (const structure of room.find(FIND_STRUCTURES)) {
            if (structure.structureType === STRUCTURE_ROAD) matrix.set(structure.pos.x, structure.pos.y, 1);
            else setObstacleCost(matrix, room, structure);
        }
        if (plan) {
            for (const pos of plan.getLocations("road")) if (matrix.get(pos.x, pos.y) === 0) matrix.set(pos.x, pos.y, 1);
            for (const type of ["harvester", "bay_center", "spawn", "extension", "tower", "storage", "terminal"]) {
                for (const pos of plan.getLocations(type)) matrix.set(pos.x, pos.y, 255);
            }
        }
        // A keeper room's mineral keeper is never killed (keeperKiller guards the sources): paths keep
        // out of its reach
        if (isKeeperRemote(roomName)) avoidMineralKeeper(matrix, room);
    }
    matrixCache.set(roomName, { until: Game.time + jitter(1000), matrix });
    return matrix;
}

/** Other remotes' container tiles and the walkable tiles around a remote controller (TI weightCoords: 20) */
const AVOID_COST = 20;

/** Home room of a cached path: its last tile is next to the home's planned storage */
function pathHome(packed: string): string | undefined {
    const path = unpackPath(packed);
    return path.length > 0 ? path[path.length - 1].roomName : undefined;
}

function cacheHome(cache: PathCache): string | undefined {
    return cache.path ? pathHome(cache.path) : cache.home;
}

/**
 * Paths of a home to sources whose stored path belongs to another home (heap): the store keeps one
 * path per source, and two homes in range of the same source used to read each other's path (same
 * travel time, delivery to the other storage). Promoted to the store when the source changes home.
 */
const otherPaths: Map<string, PathCache> = new Map();

function otherPathKey(home: string, key: string): string {
    return `${home}|${key}`;
}

interface SharedTiles {
    /** Tiles of the home's other remote paths, by room: they cost like roads */
    roads: Map<string, RoomPosition[]>;
    /** Container tiles of the home's other remote paths, by room */
    avoid: Map<string, RoomPosition[]>;
}

/**
 * Not in Hivemind (The International customPathFinder weightRemoteStructurePlans, Overmind RoadPlanner
 * encourageRoadMerging): while a home's remote path is searched, the tiles of its other cached paths
 * (the ones computed earlier in the same pass included) cost like roads, so sources in the same
 * direction share one trunk of roads instead of parallel strands. Other remotes' container tiles
 * and the tiles around remote controllers cost AVOID_COST: harvesters and reservers stand there.
 */
function sharedTiles(home: string, except: string): SharedTiles {
    const shared: SharedTiles = { roads: new Map(), avoid: new Map() };
    const all = paths();
    for (const key in all) {
        const packed = all[key].path;
        if (key === except || !packed || pathHome(packed) !== home) continue;
        unpackPath(packed).forEach((pos, i) => {
            const map = i === 0 ? shared.avoid : shared.roads;
            let list = map.get(pos.roomName);
            if (!list) map.set(pos.roomName, (list = []));
            list.push(pos);
        });
    }
    return shared;
}

function sharedCostMatrix(roomName: string, shared: SharedTiles): CostMatrix | false {
    const base = remoteCostMatrix(roomName);
    if (!base) return false;
    const roads = shared.roads.get(roomName);
    const avoid = shared.avoid.get(roomName);
    const controller = isOwnedRoom(roomName) ? undefined : intelManager.getIntel(roomName)?.controllerPos;
    if (!roads && !avoid && !controller) return base;
    const matrix = base.clone();
    for (const pos of roads ?? []) if (matrix.get(pos.x, pos.y) === 0) matrix.set(pos.x, pos.y, 1);
    const penalize = (x: number, y: number) => {
        const cost = matrix.get(x, y);
        if (cost < 255) matrix.set(x, y, Math.max(AVOID_COST, cost));
    };
    for (const pos of avoid ?? []) penalize(pos.x, pos.y);
    if (controller) {
        const terrain = Game.map.getRoomTerrain(roomName);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const x = controller.x + dx;
                const y = controller.y + dy;
                if (x < 1 || x > 48 || y < 1 || y > 48 || terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
                penalize(x, y);
            }
        }
    }
    return matrix;
}

/**
 * The container tile of a recomputed path stays where it was (cheaper roads elsewhere must not move a
 * built container): kept while out of sight or while a container (or its site) stands there
 */
function keepsContainerTile(pos: RoomPosition): boolean {
    const room = Game.rooms[pos.roomName];
    if (!room) return true;
    return (
        pos.lookFor(LOOK_STRUCTURES).some(s => s.structureType === STRUCTURE_CONTAINER) ||
        pos.lookFor(LOOK_CONSTRUCTION_SITES).some(s => s.structureType === STRUCTURE_CONTAINER)
    );
}

/**
 * Obstacles: 255 in our rooms (RoomCleanup destroys what is in the way); elsewhere a blocker a
 * dismantler can open costs by its hits (blockers.ts), others' ramparts included
 */
function setObstacleCost(matrix: CostMatrix, room: Room, structure: Structure): void {
    let cost: number;
    if (room.controller?.my) cost = (OBSTACLE_OBJECT_TYPES as string[]).includes(structure.structureType) ? 255 : 0;
    else cost = blockerCost(structure);
    if (cost > matrix.get(structure.pos.x, structure.pos.y)) matrix.set(structure.pos.x, structure.pos.y, cost);
}

/**
 * A source's path is blocked by something no dismantler can remove (seen once the room is visible):
 * forget the path and the room's cost matrix so the next selection searches around it
 */
export function forgetRemotePath(source: RemoteSource, roomName: string): void {
    matrixCache.delete(roomName);
    delete paths()[source.key];
    pathStore.touch();
    log.info("RemoteMining", `${source.key}: path blocked in ${roomName}, searching again`);
}

/** Path from a remote source to its home's planned storage, cached (Hivemind getPathFor) */
function pathFor(home: Room, sourcePos: RoomPosition): RoomPosition[] | null {
    const key = sourceKey(sourcePos.roomName, sourcePos.x, sourcePos.y);
    const stored = paths()[key];
    const storedHome = stored && cacheHome(stored);
    const own = !storedHome || storedHome === home.name;
    const cache = own ? stored : otherPaths.get(otherPathKey(home.name, key));
    if (cache) {
        const ttl = cache.path ? PATH_TTL : FAILED_PATH_TTL;
        // A cached path that now crosses someone else's room is searched again at once
        const crossesBlocked =
            !!cache.path && roomsOf(cache.path).some(r => r !== sourcePos.roomName && isBlockedRoom(r, home.name));
        if (Game.time - cache.generated < jitterFor(key, ttl) && !crossesBlocked) return cache.path ? unpackPath(cache.path) : null;
    }
    const storagePos = roomPlanner.getPlan(home.name)?.getLocations("storage")[0];
    // No plan yet: don't cache the failure (Hivemind cached null for 5000 ticks)
    if (!storagePos) return null;
    const shared = sharedTiles(home.name, key);
    // Rooms of another zone (novice / respawn area) are walled off
    const zone = roomStatus(home.name);
    // The container tile of the other home's path too: a source changing home keeps its container
    const previousPath = cache?.path ?? stored?.path;
    const previous = previousPath ? unpackPath(previousPath)[0] : undefined;
    const start = previous && keepsContainerTile(previous) ? previous : undefined;
    const result = PathFinder.search(start ?? sourcePos, { pos: storagePos, range: 1 }, {
        plainCost: 2,
        swampCost: home.storage ? 3 : 10,
        maxOps: 10000,
        heuristicWeight: 1,
        roomCallback: roomName =>
            (roomName !== sourcePos.roomName && isBlockedRoom(roomName, home.name)) || roomStatus(roomName) !== zone
                ? false
                : sharedCostMatrix(roomName, shared)
    });
    const found = start ? [start, ...result.path] : result.path;
    const path = result.incomplete || found.length >= MAX_PATH_LENGTH ? null : found;
    const entry: PathCache = path
        ? { generated: Game.time, path: encodePath(path) }
        : { generated: Game.time, path: null, home: home.name };
    if (own) {
        paths()[key] = entry;
        pathStore.touch();
    } else {
        otherPaths.set(otherPathKey(home.name, key), entry);
    }
    return path;
}

/** Tile coordinates over the whole world map */
function worldTile(roomName: string, x: number, y: number): { x: number; y: number } {
    const world = parseRoomName(roomName) ?? { wx: 0, wy: 0 };
    return { x: world.wx * 50 + x, y: world.wy * 50 + y };
}

/**
 * Remote room candidates of a home room: known, not owned, not another player's remote (their
 * reservation, or contested: see remoteRooms.ts), within 3 rooms. A keeper room only for an RCL 7+
 * home within 2 rooms, without an active stronghold (keepers.ts keeperRoomCandidate).
 */
function candidateRooms(home: Room): string[] {
    return roomsInRange(home.name, MAX_ROOM_DISTANCE).filter(roomName => {
        const intel = intelManager.getIntel(roomName);
        if (!intel?.sources?.length || intel.owner) return false;
        const keeper = isKeeperRemote(roomName);
        if (!keeper && isBlockedRoom(roomName)) return false;
        const route = Game.map.findRoute(home.name, roomName);
        if (route === ERR_NO_PATH || route.length > MAX_ROOM_DISTANCE) return false;
        if (!keeper) return true;
        const open = keeperRoomCandidate({
            rcl: home.controller?.level ?? 0,
            capacity: home.energyCapacityAvailable,
            distance: route.length,
            stronghold: hasStronghold(roomName) || hasInvaderCore(roomName)
        });
        if (!open) return false;
        return !isRemoteBlocked(roomName, intel, Memory.username, isRoomContested(roomName), releasedPlayer(roomName), true);
    });
}

/** Sources already mined keep their place unless another one scores 10% more */
const KEEP_BONUS = 1.1;

/**
 * Not in Hivemind: a cap on the sources of a home, from what its spawn actually serves. A selected
 * source without remote harvester for STARVED_TICKS (not under attack, no invader core) means the
 * spawn can't keep up: the home mines one source less (the worst per spawn part), at most once per
 * SOURCE_CAP_STEP ticks; after SOURCE_CAP_PROBE ticks without starving source it tries one more.
 * Only while the spawns are busy (SPAWN_BUSY of the time), waiting for energy included (sampleSpawns):
 * a spawn idle for lack of energy used to excuse every unserved source (shard0 W27N5). Before the
 * busy test the cap cost W9N5 45% while its first remote harvesters were priority 1; they are 3 now
 * (remoteSpawnRole.ts), so a starved source is one the spawn really can't serve.
 * A static spawn-time budget (500 parts per spawn and 1500 ticks minus the home's creeps) kept W7N3
 * at 5-6 of its 8 sources (-10%): a spawn short of time still gains from a source it serves late.
 */
export const STARVED_TICKS = 1500;
const SOURCE_CAP_STEP = 1000;
const SOURCE_CAP_PROBE = 5000;
const SPAWN_BUSY = 0.8;

/**
 * Ticks every spawn of a home was spawning, or a free spawn waited for energy, since the last selection
 * (heap). Waiting counts as busy: shard0 W27N5 (RCL 4, no storage) waited for energy 45% of the time on
 * builders while 3 of its 5 selected sources never got a harvester, and the idle test excused them.
 */
const spawnSamples: Map<string, { busy: number; total: number }> = new Map();

function sampleSpawns(): void {
    for (const name in Game.rooms) {
        const room = Game.rooms[name];
        if (!room.controller?.my) continue;
        const spawns = room.find(FIND_MY_SPAWNS);
        if (spawns.length === 0) continue;
        let sample = spawnSamples.get(name);
        if (!sample) spawnSamples.set(name, (sample = { busy: 0, total: 0 }));
        sample.total++;
        if (spawns.every(spawn => spawn.spawning) || spawnManager.nextRole(name) !== undefined) sample.busy++;
    }
}

/** Slow average of the busy share of a home's spawns, updated from the samples since the last call */
function spawnBusy(home: string): number {
    const busy = (memory().spawnBusy ??= {});
    const sample = spawnSamples.get(home);
    if (sample && sample.total > 0) {
        const share = sample.busy / sample.total;
        // ~400 ticks with a call every SELECT_INTERVAL ticks
        busy[home] = busy[home] === undefined ? share : busy[home] * 0.95 + share * 0.05;
        spawnSamples.delete(home);
    }
    return busy[home] ?? 0;
}

function updateSourceCap(home: Room): number | undefined {
    const mem = memory();
    const caps = (mem.sourceCaps ??= {});
    const mine = Object.values(mem.sources).filter(s => s.homeRoom === home.name);
    const harvesters = creepsByRole(home.name, "remoteHarvester");
    const harvested = new Set(harvesters.map(c => c.memory.source));
    const working = new Set(harvesters.filter(c => c.memory.arrived).map(c => c.memory.source));
    let starved = false;
    const idle = spawnBusy(home.name) < SPAWN_BUSY;
    for (const source of mine) {
        const threatened = isRoomUnderAttack(home.name) || isRemoteUnderAttack(source) || hasInvaderCore(source.room);
        // Selected source ticks without remote harvester (and no threat), by home
        if (!threatened && !harvested.has(source.key)) countStat(`remote:unserved:${home.name}`, SELECT_INTERVAL);
        // Source ticks without a harvester at the source: none alive, or only one still on its way
        if (!threatened) {
            countStat("remote:sourceTicks", SELECT_INTERVAL);
            if (!harvested.has(source.key)) countStat("remote:gap:none", SELECT_INTERVAL);
            else if (!working.has(source.key)) countStat("remote:gap:enRoute", SELECT_INTERVAL);
        }
        const excused = idle || threatened;
        if (excused || harvested.has(source.key) || source.servedAt === undefined) source.servedAt = Game.time;
        else if (Game.time - source.servedAt > STARVED_TICKS) starved = true;
    }
    const cap = caps[home.name];
    if (starved && Game.time - (cap?.changed ?? 0) >= SOURCE_CAP_STEP) {
        caps[home.name] = { max: Math.max(1, mine.length - 1), changed: Game.time };
    } else if (cap && !starved && Game.time - cap.changed >= SOURCE_CAP_PROBE) {
        // Back to uncapped once the cap no longer holds anything back
        if (cap.max > mine.length) delete caps[home.name];
        else caps[home.name] = { max: cap.max + 1, changed: Game.time };
    } else {
        return cap?.max;
    }
    countStat("remote:sourceCapChange");
    const next = caps[home.name]?.max;
    log.info("RemoteMining", `${home.name}: ${starved ? "a remote source starved" : "no starved source"}, sources ${next === undefined ? "uncapped" : `capped at ${next}`}`);
    return next;
}

function maxRemotes(home: Room): number {
    const spawns = Math.max(1, home.find(FIND_MY_SPAWNS).length);
    // Deviation: Hivemind's roomNeeds also counts every expansion squad spawned here, each one taking a
    // remote room's place (up to 6 rooms, one support pioneer each, during an expansion). An expansion
    // doesn't hold back our other rooms' remotes: its squad spawns first (priority 4) and the measured
    // source cap (updateSourceCap) drops a source once the spawn really can't serve it.
    const needs = (home.controller!.level >= 4 ? 1 : 0) + (home.controller!.level >= 6 ? 1 : 0);
    return Math.floor(spawns * 5 - needs);
}

/**
 * Not in Hivemind: an empire-wide cap on remote rooms from the CPU actually used. Remotes are the
 * bulk of the creeps (a room at RCL 2 with 5 remotes ran ~55 small creeps, 18 of 20 CPU on
 * shard0); the official CPU includes the 0.2 per intent, so the tick CPU is the right signal.
 * One share, 95% of the limit (remoteIncome.ts budgetRooms): with the bucket at 9000 or more a room is
 * added while the average plus one room's measured CPU (remote roles' CPU and moves over the mined
 * rooms, at least 0.8) stays under it; above it the worst remote room goes once the bucket falls below
 * 8000 (above the limit, or bucket < 5000, whatever the bucket). At most one change per 1000 ticks so
 * the creeps of a dropped remote can die out, and no room added within BUDGET_RAISE_HOLD ticks of a drop.
 * The average covers every tick (sampleCpu): one sample per selection, 20 ticks apart, stayed in
 * phase with the other periodic modules (shard0: 19.3 for a real 16.5-17.5), and the tick of a
 * global reset (93 CPU on shard0) is left out.
 */
const BUDGET_STEP_TICKS = 1000;

/** Tick CPU since the last selection (heap) */
const cpuSamples = { sum: 0, count: 0, lastTick: -1 };
/** First tick of this global: its CPU (code load, heap rebuilt) is not a sample */
let globalStart: number | undefined;

/** Adds the last tick's CPU (Memory.stats.cpu, recorded at the end of the previous loop) */
function sampleCpu(): void {
    globalStart ??= Game.time;
    const stats = Memory.stats;
    if (!stats || stats.tick !== Game.time - 1 || stats.tick === cpuSamples.lastTick) return;
    cpuSamples.lastTick = stats.tick;
    if (stats.tick === globalStart) return;
    cpuSamples.sum += stats.cpu;
    cpuSamples.count++;
}

/**
 * Roles whose CPU counts as remote room CPU: CreepRunner counters `cpu:<role>` (code and actions) plus
 * INTENT_CPU per move (`intents:move:<role>`: the TrafficManager issues the moves, so `cpu:<role>`
 * leaves them out; they were ~45% of a room on shard0)
 */
const REMOTE_CPU_ROLES = ["remoteHarvester", "remoteHauler", "reserver", "remoteBuilder", "keeperKiller"];

/** Updates the average CPU per tick of one remote room from the remote roles' CPU and move counters */
function sampleRoomCpu(currentRooms: number): void {
    const mem = memory();
    const counters = Memory.stats?.counters;
    if (!counters) return;
    const total = _.sum(REMOTE_CPU_ROLES, role => (counters[`cpu:${role}`] ?? 0) + INTENT_CPU * (counters[`intents:move:${role}`] ?? 0));
    const last = mem.roleCpu;
    mem.roleCpu = { total, tick: Game.time };
    // Counters reset (mockup state load): start again from here
    if (!last || total < last.total || Game.time <= last.tick || currentRooms === 0) return;
    const ticks = Game.time - last.tick;
    mem.roomCpu = cpuAverage(mem.roomCpu, (total - last.total) / currentRooms, ticks);
}

function updateBudget(currentRooms: number, possibleRooms: number): void {
    const mem = memory();
    sampleRoomCpu(currentRooms);
    if (cpuSamples.count === 0) return;
    const cpuAvg = cpuAverage(mem.cpuAvg, cpuSamples.sum, cpuSamples.count)!;
    mem.cpuAvg = cpuAvg;
    cpuSamples.sum = 0;
    cpuSamples.count = 0;
    mem.budgetChanged ??= Game.time;
    if (Game.time - mem.budgetChanged < BUDGET_STEP_TICKS) return;
    const limit = Game.cpu.limit;
    const bucket = decisionBucket();
    const next = budgetRooms({
        cpuAvg,
        limit,
        bucket,
        maxRooms: mem.maxRooms,
        currentRooms,
        possibleRooms,
        roomCpu: mem.roomCpu,
        ticksSinceDrop: mem.budgetDropped === undefined ? undefined : Game.time - mem.budgetDropped,
        ticksSinceRaise: mem.budgetRaised === undefined ? undefined : Game.time - mem.budgetRaised
    });
    if (next === mem.maxRooms) return;
    if (next !== undefined && (mem.maxRooms === undefined || next < mem.maxRooms)) mem.budgetDropped = Game.time;
    else mem.budgetRaised = Game.time;
    mem.maxRooms = next;
    mem.budgetChanged = Game.time;
    countStat("remote:budgetChange");
    const room = (mem.roomCpu ?? 0).toFixed(2);
    const cap = next === undefined ? "uncapped" : `capped at ${next}`;
    log.info("RemoteMining", `CPU ${cpuAvg.toFixed(1)}/${limit} (room ${room}), bucket ${bucket}: remote rooms ${cap}`);
}

/**
 * Container of every source seen with one (heap): a source dropped from the selection loses its
 * memory entry, and once selected again out of sight its standing container was unknown until a
 * creep got there (shard0 W29N5, both containers standing: harvesters sized for building one and no
 * hauler counted for the source)
 */
const knownContainers = new Map<string, Id<StructureContainer>>();

type Candidate = { source: RemoteSource; net: number; parts: number; crew: SourceCrew };
type HomeSelection = {
    home: Room;
    cap: number | undefined;
    /** `escorted`: a keeper room, its killer counted as one more creep */
    rooms: { [room: string]: { candidates: Candidate[]; reserverCost: number; escorted: boolean } };
    ranked: Candidate[];
    chosen: { [room: string]: RemoteSource[] };
    count: number;
};

/** Shortest source path of a home to a remote room, its current home's shortened by KEEP_BONUS */
function homeDistance(entry: HomeSelection, roomName: string): number {
    const candidates = entry.rooms[roomName].candidates;
    const keeps = candidates.some(c => memory().sources[c.source.key]?.homeRoom === entry.home.name);
    return _.min(candidates.map(c => c.source.travelTime)) / (keeps ? KEEP_BONUS : 1);
}

/** Adds a home's best ranked sources in the rooms it may open, within its source cap and room slots */
function pickSources(entry: HomeSelection, owner: Record<string, string>, allowed: (room: string) => boolean): void {
    for (const candidate of entry.ranked) {
        if (entry.cap !== undefined && entry.count >= entry.cap) break;
        const roomName = candidate.source.room;
        if (entry.chosen[roomName]?.includes(candidate.source)) continue;
        const opening = !entry.chosen[roomName];
        if (opening && (owner[roomName] || !allowed(roomName))) continue;
        if (opening && Object.keys(entry.chosen).length >= maxRemotes(entry.home)) continue;
        (entry.chosen[roomName] ??= []).push(candidate.source);
        owner[roomName] = entry.home.name;
        entry.count++;
    }
}

type PickedRoom = { score: number; perCreep: number; travel: number; sources: RemoteSource[] };

/**
 * Searches the paths due closest source first, so the farther ones merge into their trunk the same
 * way on every pass
 */
function searchPathsClosestFirst(home: Room, candidateNames: string[]): void {
    const storagePos = roomPlanner.getPlan(home.name)?.getLocations("storage")[0];
    if (!storagePos) return;
    const origin = worldTile(storagePos.roomName, storagePos.x, storagePos.y);
    const sources = _.flatten(
        candidateNames.map(r =>
            intelManager.getIntel(r)!.sources!.map(s => ({ tile: worldTile(r, s.x, s.y), roomName: r, x: s.x, y: s.y }))
        )
    );
    const ordered = _.sortBy(
        sources,
        t => Math.max(Math.abs(t.tile.x - origin.x), Math.abs(t.tile.y - origin.y)) * 10000 + t.y * 50 + t.x
    );
    for (const t of ordered) pathFor(home, new RoomPosition(t.x, t.y, t.roomName));
}

/** A remote room's sources worth mining from a home, or undefined when the room does not pay */
function roomCandidates(home: Room, roomName: string, roads: boolean): HomeSelection["rooms"][string] | undefined {
    const intel = intelManager.getIntel(roomName)!;
    const candidates: Candidate[] = [];
    const generation = remoteSourceCapacity(home, roomName) / ENERGY_REGEN_TIME;
    const reachable: { source: NonNullable<typeof intel.sources>[number]; path: RoomPosition[] }[] = [];
    for (const source of intel.sources!) {
        // Measured to lose energy for this home (remoteBalance.ts)
        if (isRemoteExcluded(sourceKey(roomName, source.x, source.y), home.name)) continue;
        const path = pathFor(home, new RoomPosition(source.x, source.y, roomName));
        if (path && path.length > 0) reachable.push({ source, path });
    }
    // A keeper room's killer, shared between its reachable sources
    const escorted = isKeeperRemote(roomName);
    const escort = keeperEscort(home, roomName, reachable.length);
    let net = 0;
    for (const { source, path } of reachable) {
        const economy = {
            generation,
            distance: path.length,
            roads,
            // maintenanceWork() for a path not selected yet
            maintenanceWork: roads ? upkeepWork(path.filter(p => !isOwnedRoom(p.roomName)).length, path.length) : 0,
            ...escort
        };
        const sourceIncome = sourceNet(economy);
        // A source that barely pays for its creeps is left out
        if (!worthMining(sourceIncome)) continue;
        net += sourceIncome;
        const key = sourceKey(roomName, source.x, source.y);
        const previous = memory().sources[key];
        candidates.push({
            source: {
                key,
                room: roomName,
                x: source.x,
                y: source.y,
                homeRoom: home.name,
                travelTime: path.length,
                free: source.free || 1,
                containerId: previous?.containerId ?? knownContainers.get(key),
                servedAt: previous?.homeRoom === home.name ? previous.servedAt : Game.time
            },
            net: sourceIncome,
            parts: sourceParts(economy),
            crew: sourceCreeps(economy, home.energyCapacityAvailable, source.free || 1)
        });
    }
    // Hivemind scored a room without any path 3000/500: such a room is skipped here
    if (candidates.length === 0) return undefined;
    const reserver = canReserveFrom(home, roomName) ? reserverCost(_.min(candidates.map(c => c.source.travelTime))) : 0;
    if (net - reserver <= 0) return undefined;
    return { candidates, reserverCost: reserver, escorted };
}

/** A home's candidate remote rooms and its ranked sources, or undefined when it mines nothing */
function collectHome(home: Room): HomeSelection | undefined {
    if (!home.controller?.my || !roomPlanner.getPlan(home.name)) return undefined;
    // A room without spawn (new expansion) mines nothing yet
    if (home.find(FIND_MY_SPAWNS).length === 0) return undefined;
    const cap = updateSourceCap(home);
    const rooms: HomeSelection["rooms"] = {};
    const roads = hasRemoteRoads(home);
    const candidateNames = candidateRooms(home);
    searchPathsClosestFirst(home, candidateNames);
    for (const roomName of candidateNames) {
        const room = roomCandidates(home, roomName, roads);
        if (room) rooms[roomName] = room;
    }
    // Best net energy per spawn part first: the room-level net income kept two far sources over
    // a close one, and the spawn never got to the far ones' harvesters
    const current = memory().sources;
    const ranked = _.sortBy(
        _.flatten(Object.values(rooms).map(r => r.candidates)),
        c => (-c.net / c.parts) * (current[c.source.key]?.homeRoom === home.name ? KEEP_BONUS : 1)
    );
    return { home, cap, rooms, ranked, chosen: {}, count: 0 };
}

/**
 * Each remote room goes to one home (Hivemind: the room's origin, its closest owned room). Every
 * home used to pick on its own: neighbours picked the same rooms, the later entry overwrote the
 * other's sources and the duplicates took CPU budget slots (shard0: 5 rooms mined for a cap of 8,
 * W29N5 dropped by W29N7 while its harvesters and reserver were still there)
 */
function assignRooms(homes: HomeSelection[]): void {
    const preferred: { [room: string]: string } = {};
    const best: { [room: string]: number } = {};
    for (const entry of homes) {
        for (const roomName in entry.rooms) {
            const distance = homeDistance(entry, roomName);
            if (best[roomName] === undefined || distance < best[roomName]) {
                best[roomName] = distance;
                preferred[roomName] = entry.home.name;
            }
        }
    }
    const owner: { [room: string]: string } = {};
    for (const entry of homes) pickSources(entry, owner, roomName => preferred[roomName] === entry.home.name);
    // Deviation: a room its closest home has no slot for goes to another home in range (Hivemind leaves it)
    for (const entry of homes) pickSources(entry, owner, () => true);
}

/** Every room the homes picked, with its net income and energy per creep */
function pickedRooms(homes: HomeSelection[]): PickedRoom[] {
    const picked: PickedRoom[] = [];
    for (const entry of homes) {
        for (const roomName in entry.chosen) {
            const sources = entry.chosen[roomName];
            const room = entry.rooms[roomName];
            const chosen = sources.map(s => room.candidates.find(c => c.source === s)!);
            const score = _.sum(chosen, c => c.net) - room.reserverCost;
            const fixedCreeps = (room.reserverCost > 0 ? 1 : 0) + (room.escorted ? 1 : 0);
            const perCreep = roomEnergyPerCreep(chosen, room.reserverCost, fixedCreeps);
            picked.push({ score, perCreep, travel: _.min(sources.map(s => s.travelTime)), sources });
        }
    }
    return picked;
}

/**
 * CPU budget: the rooms that pay the most energy per creep (CPU goes with creeps and their
 * intents), closest first on ties. Hivemind keeps the closest rooms; the net income order kept
 * farther two-source rooms, more creeps per CPU (W9N5 at 13 CPU lost 15%), and the closest order
 * kept the remotes of a home at 450 capacity (shard0 W28N7: ~2x the creeps per energy of W29N7).
 * Sorts `picked` in place and returns the number of rooms kept.
 */
function budgetSelection(picked: PickedRoom[], selected: { [key: string]: RemoteSource }): number {
    updateBudget(new Set(Object.values(memory().sources).map(s => s.room)).size, picked.length);
    picked.sort((a, b) => b.perCreep - a.perCreep || a.travel - b.travel);
    const cap = memory().maxRooms ?? picked.length;
    for (const entry of picked.slice(0, cap)) {
        for (const source of entry.sources) selected[source.key] = source;
    }
    return cap;
}

/** A source that changed home gets its new home's path in the store (remotePath reads it) */
function promotePaths(selected: { [key: string]: RemoteSource }): void {
    for (const source of Object.values(selected)) {
        const stored = paths()[source.key];
        if (!stored || cacheHome(stored) === source.homeRoom) continue;
        const mine = otherPaths.get(otherPathKey(source.homeRoom, source.key));
        if (!mine) continue;
        otherPaths.delete(otherPathKey(source.homeRoom, source.key));
        const previousHome = cacheHome(stored);
        if (previousHome) otherPaths.set(otherPathKey(previousHome, source.key), stored);
        paths()[source.key] = mine;
        pathStore.touch();
    }
}

function selectRemotes(): void {
    const selected: { [key: string]: RemoteSource } = {};
    const homes: HomeSelection[] = [];
    for (const name in Game.rooms) {
        const entry = collectHome(Game.rooms[name]);
        if (entry) homes.push(entry);
    }
    assignRooms(homes);
    const picked = pickedRooms(homes);
    const cap = budgetSelection(picked, selected);
    promotePaths(selected);
    for (const source of Object.values(memory().sources)) {
        if (source.containerId) knownContainers.set(source.key, source.containerId);
    }
    const before = Object.keys(memory().sources).sort().join();
    memory().sources = selected;
    const after = Object.keys(selected).sort().join();
    if (before !== after) {
        const income = _.sum(picked.slice(0, cap), entry => entry.score).toFixed(1);
        log.info("RemoteMining", `Remote sources: ${Object.keys(selected).join(" ") || "none"} (net ${income} energy/tick)`);
    }
}

// ------------------------------------------------------------------ queries

/** Selected remote sources of a home room, closest first */
export function remoteSources(homeRoom: string): RemoteSource[] {
    return _.sortBy(
        _.filter(memory().sources, s => s.homeRoom === homeRoom),
        s => s.travelTime
    );
}

/** Remote rooms mined by every home (the CPU budget's `maxRooms` counts them) */
export function minedRemoteRooms(): number {
    return minedRemoteRoomNames().size;
}

/** Remote rooms mined by every home */
export function minedRemoteRoomNames(): Set<string> {
    return new Set(Object.values(memory().sources).map(s => s.room));
}

/** "home>room" of every selected source, and the rooms alone, rebuilt once per tick (heap) */
const minedRooms: Set<string> = new Set();
const minedRoomsAlone: Set<string> = new Set();
let minedRoomsTick = -1;

function refreshMinedRooms(): void {
    if (minedRoomsTick === Game.time) return;
    minedRoomsTick = Game.time;
    minedRooms.clear();
    minedRoomsAlone.clear();
    for (const key in memory().sources) {
        const source = memory().sources[key];
        minedRooms.add(`${source.homeRoom}>${source.room}`);
        minedRoomsAlone.add(source.room);
    }
}

/** A home mines a source in the room (cheap: reservers check it every tick) */
export function isRemoteRoomMined(homeRoom: string, roomName: string): boolean {
    refreshMinedRooms();
    return minedRooms.has(`${homeRoom}>${roomName}`);
}

export function getRemoteSource(key: string | undefined): RemoteSource | undefined {
    return key ? memory().sources[key] : undefined;
}

export function sourcePos(source: RemoteSource): RoomPosition {
    return new RoomPosition(source.x, source.y, source.room);
}

/** Container tile: first tile of the path, next to the source */
export function containerPos(source: RemoteSource): RoomPosition | undefined {
    return remotePath(source)[0];
}

/** The container of a remote source (remembered out of sight) */
export function remoteContainer(source: RemoteSource): StructureContainer | null {
    if (source.containerId) {
        const container = Game.getObjectById(source.containerId);
        if (container) return container;
        if (Game.rooms[source.room]) {
            delete source.containerId;
            knownContainers.delete(source.key);
        } else return null;
    }
    const room = Game.rooms[source.room];
    if (!room) return null;
    // The path's container tile, else a container next to the source (remoteRooms.ts pickSourceContainer)
    const pos = containerPos(source);
    const near = room
        .lookForAtArea(LOOK_STRUCTURES, source.y - 1, source.x - 1, source.y + 1, source.x + 1, true)
        .map(r => r.structure)
        .filter((s): s is StructureContainer => s.structureType === STRUCTURE_CONTAINER);
    const id = pickSourceContainer(source, pos, near.map(c => ({ id: c.id, x: c.pos.x, y: c.pos.y })));
    const container = near.find(c => c.id === id) ?? null;
    if (container) source.containerId = container.id;
    return container;
}

export function hasRemoteContainer(source: RemoteSource): boolean {
    if (source.containerId && !Game.rooms[source.room]) return true;
    return !!remoteContainer(source);
}

export function isRemoteUnderAttack(source: RemoteSource): boolean {
    if (isRoomUnderAttack(source.room)) return true;
    // Rooms crossed on the way
    for (const room of pathRooms(source)) if (room !== source.homeRoom && isRoomUnderAttack(room)) return true;
    return false;
}

/**
 * Room a defender of the source goes to: the first room on the way with hostiles, else the remote.
 * Remotes behind a shared room under attack then get a single defense (W7N4 mockup: a pair for W7N4
 * and another for W8N4, whose path crosses W7N4, against the same invader).
 */
export function remoteThreatRoom(source: RemoteSource): string {
    for (const room of pathRooms(source)) if (room !== source.homeRoom && isRoomUnderAttack(room)) return room;
    return source.room;
}

export function remoteHasInvaderCore(source: RemoteSource): boolean {
    return hasInvaderCore(source.room);
}

export interface EnemyData {
    damage: number;
    heal: number;
    ranged: boolean;
    rangedDamage: number;
    hits: number;
    fastMelee: boolean;
    hasInvaderCore: boolean;
    /** A hostile belongs to a player */
    players: boolean;
}

/** Hostile strength in the remote and the rooms crossed on the way (Hivemind getTotalEnemyData) */
export function remoteEnemyData(source: RemoteSource): EnemyData {
    const total: EnemyData = { damage: 0, heal: 0, ranged: false, rangedDamage: 0, hits: 0, fastMelee: false, hasInvaderCore: false, players: false };
    for (const room of pathRooms(source)) {
        if (room === source.homeRoom) continue;
        const enemies = Memory.rooms?.[room]?.enemies;
        if (!enemies) continue;
        if (enemies.hasInvaderCore) total.hasInvaderCore = true;
        if (enemies.safe) continue;
        total.damage += enemies.damage ?? 0;
        total.heal += enemies.heal ?? 0;
        total.ranged = total.ranged || !!enemies.ranged;
        total.rangedDamage += enemies.rangedDamage ?? 0;
        total.hits += enemies.hits ?? 0;
        total.fastMelee = total.fastMelee || !!enemies.fastMelee;
        total.players = total.players || !!enemies.players;
    }
    return total;
}

// ------------------------------------------------------------------ maintenance (builders)

const heapCache: Map<string, { until: number; value: unknown }> = new Map();
function inHeap<T>(key: string, ttl: number, compute: () => T): T {
    const cached = heapCache.get(key);
    if (cached && cached.until > Game.time) return cached.value as T;
    const value = compute();
    heapCache.set(key, { until: Game.time + jitter(ttl), value });
    return value;
}

function isOwnedRoom(roomName: string): boolean {
    return !!Game.rooms[roomName]?.controller?.my;
}

/** Path tiles outside our rooms, off the room edges (repairs.ts onRoomEdge): remote builders keep a road there */
export function remoteRoadPath(source: RemoteSource): RoomPosition[] {
    return remotePath(source).filter(p => !isOwnedRoom(p.roomName) && !onRoomEdge(p));
}

/**
 * Steady remote builder WORK a source's roads cost, for the selection's estimate (repairs.ts upkeepWork;
 * was ceil(0.7 + 0.03 per tile outside our rooms), also the spawn demand: see repairs.ts builderWork)
 */
export function maintenanceWork(source: RemoteSource): number {
    return inHeap(`maintWork:${source.key}`, 500, () => upkeepWork(remoteRoadPath(source).length, source.travelTime));
}

/** Last need seen per source and room of its path (heap), used while the room is out of sight */
const knownNeeds = new Map<string, PathNeed & { time: number }>();
/** Age past which an out-of-sight room's last need is forgotten (counts as nothing) */
const KNOWN_NEED_TTL = 5000;

/** A path tile seen: its structure, else its construction site, else missing (null; a swamp road costs 5x) */
function tileState(pos: RoomPosition, type: BuildableStructureConstant): Tile {
    const structure = pos.lookFor(LOOK_STRUCTURES).find(s => s.structureType === type);
    if (structure) return structure;
    const site = pos.lookFor(LOOK_CONSTRUCTION_SITES).find(s => s.structureType === type);
    if (site) return { buildLeft: site.progressTotal - site.progress };
    if (type === STRUCTURE_ROAD && Game.map.getRoomTerrain(pos.roomName).get(pos.x, pos.y) === TERRAIN_MASK_SWAMP) {
        return { buildLeft: CONSTRUCTION_COST[STRUCTURE_ROAD] * CONSTRUCTION_COST_ROAD_SWAMP_RATIO };
    }
    return null;
}

/**
 * Repair hits and build energy left on a source's container and remote roads (repairs.ts pathNeed). A
 * room out of sight counts what was last seen there within KNOWN_NEED_TTL, else nothing.
 */
export function repairNeed(source: RemoteSource): PathNeed {
    return inHeap(`repairNeed:${source.key}`, 50, () => {
        const byRoom = _.groupBy(remoteRoadPath(source), p => p.roomName);
        const container = containerPos(source);
        if (container && !byRoom[container.roomName]) byRoom[container.roomName] = [];
        const total: PathNeed = { repairHits: 0, buildEnergy: 0 };
        for (const roomName in byRoom) {
            const key = `${source.key}|${roomName}`;
            let need: PathNeed | undefined;
            if (Game.rooms[roomName]) {
                const containerTile = container?.roomName === roomName ? tileState(container, STRUCTURE_CONTAINER) : undefined;
                need = pathNeed(containerTile, byRoom[roomName].map(pos => tileState(pos, STRUCTURE_ROAD)));
                knownNeeds.set(key, { ...need, time: Game.time });
            } else {
                const known = knownNeeds.get(key);
                if (known && Game.time - known.time <= KNOWN_NEED_TTL) need = known;
            }
            if (!need) continue;
            total.repairHits += need.repairHits;
            total.buildEnergy += need.buildEnergy;
        }
        return total;
    });
}

/** Hits missing on a tile (out of sight: nothing); missing structure: its build cost x 100 */
function neededWorkAt(pos: RoomPosition | undefined, type: BuildableStructureConstant): number {
    if (!pos || !Game.rooms[pos.roomName]) return 0;
    const structure = pos.lookFor(LOOK_STRUCTURES).find(s => s.structureType === type);
    if (structure) return structure.hitsMax - structure.hits;
    return CONSTRUCTION_COST[type] * 100;
}

/** Structure of a type on a tile: undefined out of sight, null when missing */
function tileHits(pos: RoomPosition | undefined, type: BuildableStructureConstant): Hits | null | undefined {
    if (!pos || !Game.rooms[pos.roomName]) return undefined;
    return pos.lookFor(LOOK_STRUCTURES).find(s => s.structureType === type) ?? null;
}

/** Container or path roads worth a remote builder trip (remote/repairs.ts: roads below a third, or 50k hits missing) */
export function needsRepairs(source: RemoteSource): boolean {
    return inHeap(`needsRepairs:${source.key}`, 50, () =>
        repairsDue(
            tileHits(containerPos(source), STRUCTURE_CONTAINER),
            remoteRoadPath(source).map(pos => tileHits(pos, STRUCTURE_ROAD))
        )
    );
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
            for (const pos of remotePath(source)) {
                if (pos.roomName === homeRoom && !onRoomEdge(pos)) positions[pos.y * 50 + pos.x] = pos;
            }
        }
        return Object.values(positions);
    });
}

/**
 * Hivemind canReserveFrom: a reserver can be spawned, so the source is assumed reserved (3000). Never
 * a room without controller (keeper rooms, sector centers: their sources hold 4000 anyway)
 */
export function canReserveFrom(home: Room, remoteRoom: string): boolean {
    const intel = intelManager.getIntel(remoteRoom);
    if (!intel?.controllerPos) return false;
    const positions = intel.reservePositions ?? 0;
    return home.energyCapacityAvailable >= (positions > 1 ? 650 : 1300);
}

/** Energy per regeneration of a remote room's sources, as the selection prices them (remoteIncome.ts remoteCapacity) */
export function remoteSourceCapacity(home: Room, roomName: string): number {
    const keepers = intelManager.getIntel(roomName)?.hasSourceKeepers;
    if (isKeeperOrCenter(roomName, keepers)) return remoteCapacity(true, false);
    return remoteCapacity(false, canReserveFrom(home, roomName));
}

export function sourceEnergyCapacity(home: Room, source: RemoteSource): number {
    return remoteSourceCapacity(home, source.room);
}

/** Storage era: the home builds remote roads, its remote creeps get road bodies */
export function hasRemoteRoads(home: Room): boolean {
    return home.controller!.level > 3 && !!(home.storage || home.terminal);
}

/**
 * A keeper room source's share of the room's killer, shared between its `sources` mined sources
 * (remoteIncome SourceEconomy escort / escortParts); nothing outside keeper rooms
 */
export function keeperEscort(home: Room, roomName: string, sources: number): { escort: number; escortParts: number } {
    if (!isKeeperRemote(roomName)) return { escort: 0, escortParts: 0 };
    const killer = killerParts(home.energyCapacityAvailable);
    if (!killer) return { escort: 0, escortParts: 0 };
    const parts = killer.ranged + killer.heal + killer.move;
    return { escort: escortShare(partsCost(killer), sources), escortParts: parts / Math.max(1, sources) };
}

/**
 * Keeper tiles are walkable for our creeps in a keeper room or sector center a home mines (TrafficManager
 * keeperTiles): cartographer avoids every tile within 5 of a keeper room's sources by default, the very
 * tiles the harvesters stand on
 */
export function isMinedStrongRoom(roomName: string): boolean {
    refreshMinedRooms();
    if (!minedRoomsAlone.has(roomName)) return false;
    return isKeeperOrCenter(roomName, intelManager.getIntel(roomName)?.hasSourceKeepers);
}

/** Roles of the keeper room operation: their searches cross keeper tiles in the rooms mined */
const KEEPER_OPERATION_ROLES = new Set(["remoteHarvester", "remoteHauler", "remoteBuilder", "keeperKiller"]);

trafficManager.keeperTiles = (creep, target) =>
    "body" in creep &&
    KEEPER_OPERATION_ROLES.has(creep.memory.role ?? "") &&
    (isMinedStrongRoom(creep.pos.roomName) || isMinedStrongRoom(target.roomName));

export const remoteMiningModule = () => {
    sampleSpawns();
    sampleCpu();
    // Paths not loaded yet (first tick after requesting the segment): don't recompute them all
    if (!pathStore.ready) return;
    const mem = memory();
    if (Game.time - mem.lastSelect < SELECT_INTERVAL) return;
    mem.lastSelect = Game.time;
    // Other players' remotes taken or given up before the selection sees them (remoteSeize.ts)
    updateSeizes(minedRemoteRoomNames());
    selectRemotes();
    // Forget paths of sources no longer around (selected ones are refreshed within PATH_TTL)
    const all = paths();
    for (const key in all) {
        if (mem.sources[key] || Game.time - all[key].generated <= 2 * PATH_TTL) continue;
        delete all[key];
        pathStore.touch();
    }
};
