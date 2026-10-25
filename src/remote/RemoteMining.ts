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
import { claimingSquadsOf } from "../expansion/Expansion";
import { intelManager } from "../modules/IntelManager";
import { hasInvaderCore, isRoomUnderAttack } from "../modules/RoomIntel";
import { roomPlanner } from "../planner/RoomPlanner";
import { log } from "../utils/logger";
import { spawnManager } from "../modules/SpawnManager";
import { decisionBucket } from "../utils/throttle";
import { decodePath, encodePath } from "../utils/pathCodec";
import { parseRoomName, roomsInRange } from "../utils/rooms";
import { segmentStore } from "../utils/segments";
import { countStat } from "../utils/stats";
import { jitter, jitterFor } from "../utils/jitter";
import {
    BUDGET_FULL_BUCKET,
    budgetRooms,
    INTENT_CPU,
    cpuAverage,
    reserverCost,
    roomEnergyPerCreep,
    SourceCrew,
    sourceCreeps,
    sourceNet,
    sourceParts
} from "./remoteIncome";
import { blockerCost } from "./blockers";
import { isRemoteExcluded } from "./remoteBalance";

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

/** Packed path format (1: "W7N3,12,34;..." strings, migrated on load) */
const PATHS_VERSION = 2;

declare global {
    interface Memory {
        remoteMining?: {
            /** Selected sources, by key */
            sources: { [key: string]: RemoteSource };
            /** Legacy: the paths live in segment 5 now (`paths` store below), migrated then deleted */
            paths?: { [key: string]: PathCache };
            pathsVersion?: number;
            lastSelect: number;
            /** CPU budget: slow average of the tick CPU, remote rooms allowed empire-wide (none = no cap yet) */
            cpuAvg?: number;
            maxRooms?: number;
            budgetChanged?: number;
            /** Last tick the cap went down (no room added for BUDGET_RAISE_HOLD ticks after it) */
            budgetDropped?: number;
            /** Slow average of the CPU per tick of one mined remote room (its remote roles' CPU and moves) */
            roomCpu?: number;
            /** Sum of the remote roles' CPU counters at the last budget update, and its tick */
            roleCpu?: { total: number; tick: number; moves?: boolean };
            /** First tick of the current run of ticks with a full (decision) bucket */
            bucketFullSince?: number;
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
const MAX_ROOM_DISTANCE = 3;
const MAX_PATH_LENGTH = 200;
const PATH_TTL = 5000;
/** A failed path (no plan yet, blocked) is retried sooner than a found one */
const FAILED_PATH_TTL = 500;

/**
 * Paths of the candidate sources, by source key (the only copy of a selected source's path), in
 * RawMemory segment 5 (utils/segments.ts, heap copy). A global reset loses at most 20 ticks of new
 * paths (recomputed).
 */
const pathStore = segmentStore<{ [key: string]: PathCache }>("remotePaths", [5], 20, {
    read: () => {
        const mem = Memory.remoteMining;
        if (!mem?.paths) return undefined;
        if (mem.pathsVersion !== PATHS_VERSION) migratePaths(mem);
        return mem.paths;
    },
    clear: () => {
        if (Memory.remoteMining) delete Memory.remoteMining.paths;
    }
});

function paths(): { [key: string]: PathCache } {
    return pathStore.get();
}

function memory(): NonNullable<Memory["remoteMining"]> {
    Memory.remoteMining ??= { sources: {}, lastSelect: 0, pathsVersion: PATHS_VERSION };
    const mem = Memory.remoteMining;
    if (mem.pathsVersion !== PATHS_VERSION) migratePaths(mem);
    return mem;
}

/** Version 1 ("W7N3,12,34;..." in paths and again in sources[k].path): repack, drop the duplicates */
function migratePaths(mem: NonNullable<Memory["remoteMining"]>): void {
    const legacy = mem.paths ?? {};
    for (const key in legacy) {
        const old = legacy[key].path;
        if (!old) continue;
        const positions = old.split(";").map(part => {
            const [roomName, x, y] = part.split(",");
            return { x: Number(x), y: Number(y), roomName };
        });
        legacy[key].path = encodePath(positions);
    }
    for (const key in mem.sources) {
        const source = mem.sources[key] as RemoteSource & { path?: string };
        delete source.path;
        // A selected source always has its path
        if (!legacy[key]?.path) delete mem.sources[key];
    }
    mem.pathsVersion = PATHS_VERSION;
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
 * Another player's room or remote (reserved by them): never crossed on the way to a remote, as
 * The International's remotesManager (remoteTypeWeights: enemy and enemyRemote are Infinity).
 * Invader reservations (invader cores) don't count: RoomIntel tracks their danger.
 */
function isForeignRoom(roomName: string): boolean {
    const intel = intelManager.getIntel(roomName);
    if (!intel) return false;
    if (intel.owner && intel.owner !== Memory.username) return true;
    return !!intel.reserver && intel.reserver !== Memory.username && intel.reserver !== "Invader";
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
        const crossesForeign =
            !!cache.path && roomsOf(cache.path).some(r => r !== sourcePos.roomName && isForeignRoom(r));
        if (Game.time - cache.generated < jitterFor(key, ttl) && !crossesForeign) return cache.path ? unpackPath(cache.path) : null;
    }
    const storagePos = roomPlanner.getPlan(home.name)?.getLocations("storage")[0];
    // No plan yet: don't cache the failure (Hivemind cached null for 5000 ticks)
    if (!storagePos) return null;
    const shared = sharedTiles(home.name, key);
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
            roomName !== sourcePos.roomName && isForeignRoom(roomName) ? false : sharedCostMatrix(roomName, shared)
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

/** Remote room candidates of a home room: known, not owned, not source keeper, within 3 rooms */
function candidateRooms(home: Room): string[] {
    return roomsInRange(home.name, MAX_ROOM_DISTANCE).filter(roomName => {
        const intel = intelManager.getIntel(roomName);
        if (!intel?.sources?.length) return false;
        if (intel.owner || intel.hasSourceKeepers) return false;
        const route = Game.map.findRoute(home.name, roomName);
        return route !== ERR_NO_PATH && route.length <= MAX_ROOM_DISTANCE;
    });
}

/** Net energy per tick under which a remote source is not worth its creeps */
const MIN_SOURCE_NET = 1;
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
/** Last measured busy share of a home's spawns (~400-tick average, 0 before the first selection) */
export function spawnBusyShare(home: string): number {
    return Memory.remoteMining?.spawnBusy?.[home] ?? 0;
}

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
    // An expansion squad spawned here takes a remote's place until its target is claimed (Hivemind
    // roomNeeds counts every squad, pioneers-only ones after the claim included)
    const squads = claimingSquadsOf(home.name).length;
    const needs = (home.controller!.level >= 4 ? 1 : 0) + (home.controller!.level >= 6 ? 1 : 0) + squads;
    return Math.floor(spawns * 5 - needs);
}

/**
 * Not in Hivemind: an empire-wide cap on remote rooms from the CPU actually used. Remotes are the
 * bulk of the creeps (a room at RCL 2 with 5 remotes ran ~55 small creeps, 18 of 20 CPU on
 * shard0); the official CPU includes the 0.2 per intent, so the tick CPU is the right signal.
 * Above 95% of the limit while the bucket is below 9000 (above the limit, or bucket < 5000, whatever
 * the bucket) the worst remote room goes, below 75% (bucket > 9000)
 * one more is allowed, and also above it once the bucket has stayed full for BUDGET_FULL_TICKS
 * (shard0 W27N5: 15/20 CPU with a full bucket stayed capped); at most one change per 1000 ticks so
 * the creeps of a dropped remote can die out. A room is only added when the average plus one
 * room's measured CPU (remote roles' CPU and moves over the mined rooms, at least 0.8) stays under
 * 90% (98% once the bucket stayed above 9000 for 1000 ticks; above 95% a room is then only dropped
 * when the bucket falls below 9000, see remoteIncome.ts budgetRooms), and
 * not within BUDGET_RAISE_HOLD ticks of a drop (shard0 at ~90% of 20 CPU: 7 -> 8 -> 7 in 5 of 6
 * windows of 1000 ticks, the bucket falling, the spawn energy spent on creeps of a dropped room).
 * (85% / 70% cut W7N3 by 27% in the mockup: it oscillated while the bucket stayed full.)
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
    const mem = memory();
    if (decisionBucket() < BUDGET_FULL_BUCKET) delete mem.bucketFullSince;
    else mem.bucketFullSince ??= Game.time;
}

/**
 * Roles whose CPU counts as remote room CPU: CreepRunner counters `cpu:<role>` (code and actions) plus
 * INTENT_CPU per move (`intents:move:<role>`: the TrafficManager issues the moves, so `cpu:<role>`
 * leaves them out; they were ~45% of a room on shard0)
 */
const REMOTE_CPU_ROLES = ["remoteHarvester", "remoteHauler", "reserver", "remoteBuilder"];

/** Updates the average CPU per tick of one remote room from the remote roles' CPU and move counters */
function sampleRoomCpu(currentRooms: number): void {
    const mem = memory();
    const counters = Memory.stats?.counters;
    if (!counters) return;
    const total = _.sum(REMOTE_CPU_ROLES, role => (counters[`cpu:${role}`] ?? 0) + INTENT_CPU * (counters[`intents:move:${role}`] ?? 0));
    const last = mem.roleCpu;
    mem.roleCpu = { total, tick: Game.time, moves: true };
    // Counters reset (mockup state load), or a total written before the moves were counted: start again from here
    if (!last?.moves || total < last.total || Game.time <= last.tick || currentRooms === 0) return;
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
        fullBucketTicks: mem.bucketFullSince === undefined ? 0 : Game.time - mem.bucketFullSince,
        maxRooms: mem.maxRooms,
        currentRooms,
        possibleRooms,
        roomCpu: mem.roomCpu,
        ticksSinceDrop: mem.budgetDropped === undefined ? undefined : Game.time - mem.budgetDropped
    });
    if (next === mem.maxRooms) return;
    if (next !== undefined && (mem.maxRooms === undefined || next < mem.maxRooms)) mem.budgetDropped = Game.time;
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
    rooms: { [room: string]: { candidates: Candidate[]; reserverCost: number } };
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

function selectRemotes(): void {
    const selected: { [key: string]: RemoteSource } = {};
    const picked: { score: number; perCreep: number; travel: number; sources: RemoteSource[] }[] = [];
    const homes: HomeSelection[] = [];
    for (const name in Game.rooms) {
        const home = Game.rooms[name];
        if (!home.controller?.my || !roomPlanner.getPlan(home.name)) continue;
        // A room without spawn (new expansion) mines nothing yet
        if (home.find(FIND_MY_SPAWNS).length === 0) continue;
        const cap = updateSourceCap(home);
        const rooms: HomeSelection["rooms"] = {};
        const reserved = (roomName: string) => canReserveFrom(home, roomName);
        const roads = home.controller!.level > 3 && !!(home.storage || home.terminal);
        const candidateNames = candidateRooms(home);
        // Paths due are searched closest source first, so the farther ones merge into their trunk
        // the same way on every pass
        const storagePos = roomPlanner.getPlan(home.name)?.getLocations("storage")[0];
        if (storagePos) {
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
        for (const roomName of candidateNames) {
            const intel = intelManager.getIntel(roomName)!;
            const candidates: Candidate[] = [];
            const capacity = reserved(roomName) ? SOURCE_ENERGY_CAPACITY : SOURCE_ENERGY_NEUTRAL_CAPACITY;
            const generation = capacity / ENERGY_REGEN_TIME;
            let net = 0;
            for (const source of intel.sources!) {
                // Measured to lose energy for this home (remoteBalance.ts)
                if (isRemoteExcluded(sourceKey(roomName, source.x, source.y), home.name)) continue;
                const path = pathFor(home, new RoomPosition(source.x, source.y, roomName));
                if (!path || path.length === 0) continue;
                const economy = {
                    generation,
                    distance: path.length,
                    roads,
                    // maintenanceWork() for a path not selected yet
                    maintenanceWork: roads ? Math.ceil(0.7 + 0.03 * path.filter(p => !isOwnedRoom(p.roomName)).length) : 0
                };
                const sourceIncome = sourceNet(economy);
                // A source that barely pays for its creeps is left out
                if (sourceIncome < MIN_SOURCE_NET) continue;
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
            if (candidates.length === 0) continue;
            const reserver = reserved(roomName) ? reserverCost(_.min(candidates.map(c => c.source.travelTime))) : 0;
            if (net - reserver <= 0) continue;
            rooms[roomName] = { candidates, reserverCost: reserver };
        }
        // Best net energy per spawn part first: the room-level net income kept two far sources over
        // a close one, and the spawn never got to the far ones' harvesters
        const current = memory().sources;
        const ranked = _.sortBy(
            _.flatten(Object.values(rooms).map(r => r.candidates)),
            c => (-c.net / c.parts) * (current[c.source.key]?.homeRoom === home.name ? KEEP_BONUS : 1)
        );
        homes.push({ home, cap, rooms, ranked, chosen: {}, count: 0 });
    }
    // Each remote room goes to one home (Hivemind: the room's origin, its closest owned room). Every
    // home used to pick on its own: neighbours picked the same rooms, the later entry overwrote the
    // other's sources and the duplicates took CPU budget slots (shard0: 5 rooms mined for a cap of 8,
    // W29N5 dropped by W29N7 while its harvesters and reserver were still there)
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
    for (const entry of homes) {
        for (const roomName in entry.chosen) {
            const sources = entry.chosen[roomName];
            const room = entry.rooms[roomName];
            const chosen = sources.map(s => room.candidates.find(c => c.source === s)!);
            const score = _.sum(chosen, c => c.net) - room.reserverCost;
            const perCreep = roomEnergyPerCreep(chosen, room.reserverCost, room.reserverCost > 0 ? 1 : 0);
            picked.push({ score, perCreep, travel: _.min(sources.map(s => s.travelTime)), sources });
        }
    }
    // CPU budget: the rooms that pay the most energy per creep (CPU goes with creeps and their
    // intents), closest first on ties. Hivemind keeps the closest rooms; the net income order kept
    // farther two-source rooms, more creeps per CPU (W9N5 at 13 CPU lost 15%), and the closest order
    // kept the remotes of a home at 450 capacity (shard0 W28N7: ~2x the creeps per energy of W29N7)
    updateBudget(new Set(Object.values(memory().sources).map(s => s.room)).size, picked.length);
    picked.sort((a, b) => b.perCreep - a.perCreep || a.travel - b.travel);
    const cap = memory().maxRooms ?? picked.length;
    for (const entry of picked.slice(0, cap)) {
        for (const source of entry.sources) selected[source.key] = source;
    }
    // A source that changed home gets its new home's path in the store (remotePath reads it)
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
    const pos = containerPos(source);
    // Path unknown (paths segment not loaded yet on the first tick after a reset)
    if (!room || !pos) return null;
    const container = pos
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

/** Path tiles outside our rooms: the remote builders keep a road on them */
export function remoteRoadPath(source: RemoteSource): RoomPosition[] {
    return remotePath(source).filter(p => !isOwnedRoom(p.roomName));
}

/** WORK parts to keep a source's container and roads up: ceil(0.7 + 0.03 per tile outside our rooms) */
export function maintenanceWork(source: RemoteSource): number {
    return inHeap(`maintWork:${source.key}`, 500, () => Math.ceil(0.7 + 0.03 * remoteRoadPath(source).length));
}

/** Hits missing on a tile (out of sight: nothing); missing structure: its build cost x 100 */
function neededWorkAt(pos: RoomPosition | undefined, type: BuildableStructureConstant): number {
    if (!pos || !Game.rooms[pos.roomName]) return 0;
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
            for (const pos of remotePath(source)) {
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
    sampleSpawns();
    sampleCpu();
    // Paths not loaded yet (first tick after requesting the segment): don't recompute them all
    if (!pathStore.ready) return;
    const mem = memory();
    if (Game.time - mem.lastSelect < SELECT_INTERVAL) return;
    mem.lastSelect = Game.time;
    selectRemotes();
    // Forget paths of sources no longer around (selected ones are refreshed within PATH_TTL)
    const all = paths();
    for (const key in all) {
        if (mem.sources[key] || Game.time - all[key].generated <= 2 * PATH_TTL) continue;
        delete all[key];
        pathStore.touch();
    }
};
