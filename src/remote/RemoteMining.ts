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
import { squadsOf } from "../expansion/Expansion";
import { intelManager } from "../modules/IntelManager";
import { hasInvaderCore, isRoomUnderAttack } from "../modules/RoomIntel";
import { roomPlanner } from "../planner/RoomPlanner";
import { log } from "../utils/logger";
import { decodePath, encodePath } from "../utils/pathCodec";
import { roomsInRange } from "../utils/rooms";
import { segmentStore } from "../utils/segments";
import { countStat } from "../utils/stats";
import { jitter, jitterFor } from "../utils/jitter";
import { reserverCost, sourceNet, sourceParts } from "./remoteIncome";

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
            /** Sources a home's spawn can keep harvested (none = no cap yet), by home room */
            sourceCaps?: { [home: string]: { max: number; changed: number } };
            /** Share of the ticks every spawn of a home was spawning, ~400 ticks average, by home room */
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
    matrixCache.set(roomName, { until: Game.time + jitter(1000), matrix });
    return matrix;
}

/** Path from a remote source to its home's planned storage, cached (Hivemind getPathFor) */
function pathFor(home: Room, sourcePos: RoomPosition): RoomPosition[] | null {
    const key = sourceKey(sourcePos.roomName, sourcePos.x, sourcePos.y);
    const cache = paths()[key];
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
    const result = PathFinder.search(sourcePos, { pos: storagePos, range: 1 }, {
        plainCost: 2,
        swampCost: home.storage ? 3 : 10,
        maxOps: 10000,
        heuristicWeight: 1,
        roomCallback: roomName =>
            roomName !== sourcePos.roomName && isForeignRoom(roomName) ? false : remoteCostMatrix(roomName)
    });
    const path = result.incomplete || result.path.length >= MAX_PATH_LENGTH ? null : result.path;
    paths()[key] = { generated: Game.time, path: path ? encodePath(path) : null };
    pathStore.touch();
    return path;
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
 * Only while the spawns are busy (SPAWN_BUSY of the time): a spawn waiting for energy (before the
 * storage) leaves harvesters unspawned too, and fewer remotes only made it poorer (W9N5 -45%).
 * A static spawn-time budget (500 parts per spawn and 1500 ticks minus the home's creeps) kept W7N3
 * at 5-6 of its 8 sources (-10%): a spawn short of time still gains from a source it serves late.
 */
const STARVED_TICKS = 1500;
const SOURCE_CAP_STEP = 1000;
const SOURCE_CAP_PROBE = 5000;
const SPAWN_BUSY = 0.8;

/** Ticks every spawn of a home was spawning since the last selection (heap) */
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
        if (spawns.every(spawn => spawn.spawning)) sample.busy++;
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
    const harvested = new Set(creepsByRole(home.name, "remoteHarvester").map(c => c.memory.source));
    let starved = false;
    const idle = spawnBusy(home.name) < SPAWN_BUSY;
    for (const source of mine) {
        const excused = idle || isRoomUnderAttack(home.name) || isRemoteUnderAttack(source) || hasInvaderCore(source.room);
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
    // An expansion squad spawned here takes a remote's place (Hivemind roomNeeds counts squads)
    const squads = squadsOf(home.name).length;
    const needs = (home.controller!.level >= 4 ? 1 : 0) + (home.controller!.level >= 6 ? 1 : 0) + squads;
    return Math.floor(spawns * 5 - needs);
}

/**
 * Not in Hivemind: an empire-wide cap on remote rooms from the CPU actually used. Remotes are the
 * bulk of the creeps (a room at RCL 2 with 5 remotes ran ~55 small creeps, 18 of 20 CPU on
 * shard0); the official CPU includes the 0.2 per intent, so the tick CPU is the right signal.
 * Above 95% of the limit (or bucket < 5000) the worst remote room goes, below 75% (bucket > 9000)
 * one more is allowed; at most one change per 1000 ticks so the creeps of a dropped remote can die out.
 * (85% / 70% cut W7N3 by 27% in the mockup: it oscillated while the bucket stayed full.)
 */
const BUDGET_HIGH = 0.95;
const BUDGET_LOW = 0.75;
const BUDGET_STEP_TICKS = 1000;

function updateBudget(currentRooms: number, possibleRooms: number): void {
    const mem = memory();
    const cpu = Memory.stats?.cpu;
    if (cpu === undefined) return;
    // ~400 ticks average (updated every SELECT_INTERVAL ticks)
    mem.cpuAvg = mem.cpuAvg === undefined ? cpu : mem.cpuAvg * 0.95 + cpu * 0.05;
    mem.budgetChanged ??= Game.time;
    if (Game.time - mem.budgetChanged < BUDGET_STEP_TICKS) return;
    const limit = Game.cpu.limit;
    const bucket = Game.cpu.bucket;
    let next = mem.maxRooms;
    if (mem.cpuAvg > limit * BUDGET_HIGH || bucket < 5000) next = Math.max(0, currentRooms - 1);
    else if (mem.cpuAvg < limit * BUDGET_LOW && bucket > 9000 && mem.maxRooms !== undefined) {
        next = mem.maxRooms >= possibleRooms ? undefined : mem.maxRooms + 1;
    }
    if (next === mem.maxRooms) return;
    mem.maxRooms = next;
    mem.budgetChanged = Game.time;
    countStat("remote:budgetChange");
    log.info("RemoteMining", `CPU ${mem.cpuAvg.toFixed(1)}/${limit}, bucket ${bucket}: remote rooms ${next === undefined ? "uncapped" : `capped at ${next}`}`);
}

function selectRemotes(): void {
    const selected: { [key: string]: RemoteSource } = {};
    const picked: { score: number; sources: RemoteSource[] }[] = [];
    for (const name in Game.rooms) {
        const home = Game.rooms[name];
        if (!home.controller?.my || !roomPlanner.getPlan(home.name)) continue;
        // A room without spawn (new expansion) mines nothing yet
        if (home.find(FIND_MY_SPAWNS).length === 0) continue;
        const cap = updateSourceCap(home);
        type Candidate = { source: RemoteSource; net: number; parts: number };
        const rooms: { [room: string]: { candidates: Candidate[]; reserverCost: number } } = {};
        const reserved = (roomName: string) => canReserveFrom(home, roomName);
        const roads = home.controller!.level > 3 && !!(home.storage || home.terminal);
        for (const roomName of candidateRooms(home)) {
            const intel = intelManager.getIntel(roomName)!;
            const candidates: Candidate[] = [];
            const capacity = reserved(roomName) ? SOURCE_ENERGY_CAPACITY : SOURCE_ENERGY_NEUTRAL_CAPACITY;
            const generation = capacity / ENERGY_REGEN_TIME;
            let net = 0;
            for (const source of intel.sources!) {
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
                        containerId: previous?.containerId,
                        servedAt: previous?.homeRoom === home.name ? previous.servedAt : Game.time
                    },
                    net: sourceIncome,
                    parts: sourceParts(economy)
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
        const chosen: { [room: string]: RemoteSource[] } = {};
        let count = 0;
        for (const candidate of ranked) {
            if (cap !== undefined && count >= cap) break;
            const opening = !chosen[candidate.source.room];
            if (opening && Object.keys(chosen).length >= maxRemotes(home)) continue;
            (chosen[candidate.source.room] ??= []).push(candidate.source);
            count++;
        }
        for (const roomName in chosen) {
            const sources = chosen[roomName];
            const room = rooms[roomName];
            const score = _.sum(sources, s => room.candidates.find(c => c.source === s)!.net) - room.reserverCost;
            picked.push({ score, sources });
        }
    }
    // CPU budget: the closest rooms of the whole empire (Hivemind's order). The net income order
    // kept farther two-source rooms, more creeps per CPU: W9N5 at 13 CPU lost 15%
    updateBudget(new Set(Object.values(memory().sources).map(s => s.room)).size, picked.length);
    picked.sort((a, b) => _.min(a.sources.map(s => s.travelTime)) - _.min(b.sources.map(s => s.travelTime)));
    const cap = memory().maxRooms ?? picked.length;
    for (const entry of picked.slice(0, cap)) {
        for (const source of entry.sources) selected[source.key] = source;
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
        if (Game.rooms[source.room]) delete source.containerId;
        else return null;
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

export function remoteHasInvaderCore(source: RemoteSource): boolean {
    return hasInvaderCore(source.room);
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
    for (const room of pathRooms(source)) {
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
