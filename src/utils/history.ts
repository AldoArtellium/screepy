/**
 * Counter history and economy traces, kept in RawMemory segments (utils/segments.ts) for the
 * live inspection CLI (scripts/live-inspect.mjs) and the reports:
 *
 * - `history` (segment 6): every SNAPSHOT_INTERVAL elapsed ticks (not `Game.time %`: the module may
 *   be throttled), a snapshot with the delta of every Memory.stats counter since the previous one,
 *   the average tick CPU, the bucket and, per owned room, RCL, progress, storage + terminal energy,
 *   creeps and the room counters below. Ring of HISTORY_SIZE snapshots.
 * - `historyDetail` (segment 7): the last SPAWN_LOG_SIZE spawns (tick, room, role, priority, weight,
 *   cost, parts, reason) and the remote source balance of each snapshot (energy harvested, delivered
 *   home, spawn cost of the creeps serving it, whether the window is a steady measure of it, its
 *   home; read by remote/remoteBalance.ts). Separate from `history` so each segment stays under
 *   MAX_STORE_CHARS and the spawn log (changed every few ticks) never rewrites the snapshots.
 *
 * Room counters (energy harvested, built, repaired, upgraded, spawn energy by role, idle ticks by
 * role) and the remote balance live in the heap between two snapshots, not in Memory.stats (which
 * is serialized every tick): a global reset loses the part of the current period before it, and the
 * snapshot then records the ticks its heap counters cover (`rd`).
 *
 * Encoding: counter names go to a key table (`k` for the Memory.stats counters, `rk` for the room
 * counters); a set of counters is a string of base-36 integers in key table order, empty for 0,
 * trailing empties trimmed ("1a,,3k"). The tables are rebuilt at each snapshot from the keys in use.
 */

import { segmentStore } from "./segments";
import { countStat } from "./stats";

const SNAPSHOT_INTERVAL = 1000;
const HISTORY_SIZE = 30;
const SPAWN_LOG_SIZE = 50;
const REASON_MAX = 60;
/** Each store is trimmed (oldest snapshots first) above this many characters */
const MAX_STORE_CHARS = 20000;

/** [tick, room, role, priority, weight, cost, parts, reason] */
export type SpawnLogEntry = [number, string, string, number, number, number, number, string];

interface HistoryEntry {
    /** Snapshot tick */
    t: number;
    /** Ticks since the previous snapshot */
    d: number;
    /** Ticks covered by the room counters and remote balance when fewer than `d` (global reset) */
    rd?: number;
    /** Average tick CPU over the period (one decimal), bucket at the snapshot and lowest seen */
    cpu: number;
    bk: number;
    bm: number;
    /** Counter deltas (encoded) */
    c: string;
    /** Per owned room: "rcl,progress,energy,creeps|counters", numbers in base 36 */
    r: { [room: string]: string };
}

interface HistoryData {
    /** Key tables: Memory.stats counters, room counters */
    k: string[];
    rk: string[];
    /** Last snapshot tick and the counter values then (encoded): the baseline of the next delta */
    t?: number;
    b?: string;
    e: HistoryEntry[];
}

interface HistoryDetail {
    /** Last spawns, oldest first */
    s: SpawnLogEntry[];
    /**
     * Remote balance per snapshot: [tick, ticks covered, "room:x:y=harvested,delivered,cost,steady,home;..."],
     * numbers in base 36, `steady` 1 when the window is a clean measure (steadyWindow), `home` the
     * source's home room (the last one it had when no longer selected). Entries written before
     * 2026-10-21 have no steady / home field.
     */
    r: [number, number, string][];
}

/** One remote source in one balance window (remoteBalanceWindows) */
export interface SourceBalance {
    harvested: number;
    delivered: number;
    cost: number;
    /** Mined the whole window in steady conditions (see steadyWindow) */
    steady: boolean;
    /** Home room ("" unknown) */
    home: string;
}

export interface BalanceWindow {
    tick: number;
    /** Ticks the window covers */
    ticks: number;
    sources: { [key: string]: SourceBalance };
}

const historyStore = segmentStore<HistoryData>("history", [6], SNAPSHOT_INTERVAL);
const detailStore = segmentStore<HistoryDetail>("historyDetail", [7], 100);

// Heap accumulators since the last snapshot (or the global reset)
let accSince: number | undefined;
let roomAcc: { [room: string]: { [key: string]: number } } = {};
/** Remote source key -> [harvested, delivered home, spawn cost] */
let sourceAcc: { [key: string]: [number, number, number] } = {};
/** State of each selected remote source, sampled every SOURCE_SAMPLE_INTERVAL ticks (steadyWindow) */
export interface SourceSamples {
    home: string;
    homeChanged: boolean;
    samples: number;
    harvester: number;
    container: number;
    threat: number;
    /** Samples with the remote controller in sight, reserved by us or not */
    reserved: number;
    unreserved: number;
}
let sourceSamples: { [key: string]: SourceSamples } = {};
let lastSourceSample: number | undefined;
/** Last home of every source seen selected: a source dropped from the selection keeps it in the balance */
const lastHome = new Map<string, string>();
let spawnQueue: SpawnLogEntry[] = [];
let cpuSum = 0;
let cpuTicks = 0;
let bucketMin = Infinity;

// --- Counting -------------------------------------------------------------------------------------

/** Adds to a room counter (heap, flushed into the history at the next snapshot) */
export function countRoom(roomName: string, key: string, amount = 1): void {
    if (!amount) return;
    const counters = (roomAcc[roomName] ??= {});
    counters[key] = (counters[key] ?? 0) + amount;
}

/** Room counter of each `work:<kind>` counter (kinds not listed have no room counter) */
const ROOM_WORK: { [kind: string]: string } = {
    harvest: "harvest",
    pioneerHarvest: "harvest",
    remoteHarvest: "remoteHarvest",
    build: "build",
    pioneerBuild: "build",
    remoteBuild: "build",
    repair: "repair",
    remoteRepair: "repair",
    upgrade: "upgrade",
    builderUpgrade: "upgrade",
    pioneerUpgrade: "upgrade"
};

/** Energy of a work action: counter `work:<kind>` and the room counter of the creep's home room */
export function countWork(creep: Creep, kind: string, energy: number): void {
    if (energy <= 0) return;
    countStat(`work:${kind}`, energy);
    const key = ROOM_WORK[kind];
    if (key) countRoom(creep.memory.room ?? creep.room.name, key, energy);
}

/** Counter `key` and the room counter of the creep's home room (ticks: `idle:<role>`, `builder:fetch`) */
export function countCreep(creep: Creep, key: string, amount = 1): void {
    countStat(key, amount);
    countRoom(creep.memory.room ?? creep.room.name, key, amount);
}

/** Energy a harvest call takes: WORK x HARVEST_POWER, at most what the source holds */
export function harvestEnergy(creep: Creep, source: Source): number {
    return Math.min(source.energy, creep.getActiveBodyparts(WORK) * HARVEST_POWER);
}

/** Energy an upgrade call spends: WORK x UPGRADE_CONTROLLER_POWER, at most the energy carried */
export function upgradeEnergy(creep: Creep): number {
    return Math.min(creep.store.energy, creep.getActiveBodyparts(WORK) * UPGRADE_CONTROLLER_POWER);
}

/** Energy a build call spends: WORK x BUILD_POWER, at most the energy carried and the progress left */
export function buildEnergy(creep: Creep, site: ConstructionSite): number {
    return Math.min(creep.store.energy, creep.getActiveBodyparts(WORK) * BUILD_POWER, site.progressTotal - site.progress);
}

/** Energy a repair call spends (engine: hits repaired x REPAIR_COST, rounded up, at most the energy carried) */
export function repairEnergy(creep: Creep, target: Structure): number {
    const hits = Math.min(creep.getActiveBodyparts(WORK) * REPAIR_POWER, target.hitsMax - target.hits);
    return Math.min(creep.store.energy, Math.ceil(hits * REPAIR_COST));
}

function addSource(key: string, index: 0 | 1 | 2, amount: number): void {
    if (!(amount > 0)) return;
    const balance = (sourceAcc[key] ??= [0, 0, 0]);
    balance[index] += amount;
}

/** Energy harvested at a remote source (remote harvesters) */
export function countRemoteHarvest(creep: Creep, sourceKey: string, energy: number): void {
    countWork(creep, "remoteHarvest", energy);
    addSource(sourceKey, 0, energy);
}

/** Energy a remote hauler brings into its home room from a remote source */
export function countRemoteDelivery(sourceKey: string, energy: number): void {
    addSource(sourceKey, 1, energy);
}

const SPLIT_BY_TRAVEL = ["remoteHauler", "remoteBuilder"];

/**
 * Spawn cost of a remote creep on the sources it serves: a remote harvester's on its source, a
 * reserver's split over its room's sources, haulers' and remote builders' (one pool per home) over
 * the home's sources in proportion to their travel time (an estimate: hauling scales with distance).
 */
function addSpawnCost(home: string, memory: Partial<CreepMemory>, cost: number): void {
    const sources = Memory.remoteMining?.sources;
    if (!sources) return;
    if (memory.source && sources[memory.source]) {
        addSource(memory.source, 2, cost);
        return;
    }
    let served: { key: string; travelTime: number }[] = [];
    if (memory.reserveRoom) {
        served = _.filter(sources, s => s.homeRoom === home && s.room === memory.reserveRoom).map(s => ({ key: s.key, travelTime: 1 }));
    } else if (SPLIT_BY_TRAVEL.includes(memory.role ?? "")) {
        served = _.filter(sources, s => s.homeRoom === home).map(s => ({ key: s.key, travelTime: Math.max(1, s.travelTime) }));
    }
    const total = _.sum(served, s => s.travelTime);
    for (const s of served) addSource(s.key, 2, (cost * s.travelTime) / total);
}

/** A creep was spawned: spawn log, room counter `spawn:<role>` (energy), remote balance */
export function recordSpawn(
    room: string,
    role: string,
    priority: number,
    weight: number,
    cost: number,
    parts: number,
    memory: Partial<CreepMemory>,
    reason: string
): void {
    countRoom(room, `spawn:${role}`, cost);
    addSpawnCost(room, memory, cost);
    spawnQueue.push([Game.time, room, role, round(priority, 2), round(weight, 2), cost, parts, reason.slice(0, REASON_MAX)]);
}

// --- Encoding -------------------------------------------------------------------------------------

function round(value: number, decimals: number): number {
    const f = Math.pow(10, decimals);
    return Math.round(value * f) / f;
}

function encode(values: { [key: string]: number }, index: Map<string, number>): string {
    const out: string[] = [];
    for (const key in values) {
        const value = Math.round(values[key]);
        if (value <= 0) continue;
        const i = index.get(key);
        if (i !== undefined) out[i] = value.toString(36);
    }
    let text = "";
    for (let i = 0; i < out.length; i++) text += (i > 0 ? "," : "") + (out[i] ?? "");
    return text;
}

function decode(text: string | undefined, keys: string[]): { [key: string]: number } {
    const values: { [key: string]: number } = {};
    if (!text) return values;
    const parts = text.split(",");
    for (let i = 0; i < parts.length; i++) {
        if (parts[i] && keys[i] !== undefined) values[keys[i]] = parseInt(parts[i], 36);
    }
    return values;
}

interface DecodedRoom {
    rcl: number;
    progress: number;
    energy: number;
    creeps: number;
    counters: { [key: string]: number };
}

function decodeRoom(text: string, keys: string[]): DecodedRoom {
    const [head, counters] = text.split("|");
    const [rcl, progress, energy, creeps] = head.split(",").map(v => parseInt(v, 36) || 0);
    return { rcl, progress, energy, creeps, counters: decode(counters, keys) };
}

function encodeRoom(room: DecodedRoom, index: Map<string, number>): string {
    const head = [room.rcl, room.progress, room.energy, room.creeps].map(v => Math.max(0, Math.round(v)).toString(36)).join(",");
    return `${head}|${encode(room.counters, index)}`;
}

// --- Snapshots ------------------------------------------------------------------------------------

function normalized(): HistoryData {
    const data = historyStore.get();
    data.k ??= [];
    data.rk ??= [];
    data.e ??= [];
    return data;
}

function normalizedDetail(): HistoryDetail {
    const data = detailStore.get();
    data.s ??= [];
    data.r ??= [];
    return data;
}

function roomEnergy(room: Room): number {
    return (room.storage?.store.energy ?? 0) + (room.terminal?.store.energy ?? 0);
}

const SOURCE_SAMPLE_INTERVAL = 10;
/** Share of the samples a steady window needs (selected, harvester, container, one reservation state) */
const STEADY_SHARE = 0.9;

/** Living hostiles (not just a safe-mode sighting) or an invader core in the room */
function threatened(roomName: string): boolean {
    const enemies = Memory.rooms?.[roomName]?.enemies;
    if (!enemies) return false;
    return !!enemies.hasInvaderCore || (!enemies.safe && (enemies.expires ?? 0) > Game.time);
}

/** Samples the state of every selected remote source (every SOURCE_SAMPLE_INTERVAL ticks) */
function sampleSources(): void {
    const sources = Memory.remoteMining?.sources;
    if (!sources) return;
    const harvested = new Set<string>();
    for (const name in Game.creeps) {
        const creep = Game.creeps[name];
        if (creep.memory.role === "remoteHarvester" && creep.memory.source && !creep.spawning) harvested.add(creep.memory.source);
    }
    for (const key in sources) {
        const source = sources[key];
        lastHome.set(key, source.homeRoom);
        const s = (sourceSamples[key] ??= {
            home: source.homeRoom,
            homeChanged: false,
            samples: 0,
            harvester: 0,
            container: 0,
            threat: 0,
            reserved: 0,
            unreserved: 0
        });
        if (s.home !== source.homeRoom) {
            s.homeChanged = true;
            s.home = source.homeRoom;
        }
        s.samples++;
        if (harvested.has(key)) s.harvester++;
        const room = Game.rooms[source.room];
        // Out of sight a known container is assumed standing (RemoteMining.hasRemoteContainer)
        if (source.containerId && (!room || Game.getObjectById(source.containerId))) s.container++;
        if (threatened(source.room) || threatened(source.homeRoom)) s.threat++;
        const controller = room?.controller;
        if (controller) {
            if (controller.reservation?.username === Memory.username) s.reserved++;
            else s.unreserved++;
        }
    }
}

/**
 * Whether a source's balance over a window is a clean measure of its steady state: selected by the
 * same home the whole window (a source picked or dropped midway, or moved to another home, is not),
 * a remote harvester and a built container on 90% of the samples (the first windows pay the
 * harvester and the container build with little energy delivered), no hostile or invader core in
 * the source room or the home (a raid stops the harvest while haulers and reservers are still
 * paid), and one reservation state on 90% of the samples (a first reservation pays the reserver
 * while the source still regenerates 1500). A window shortened by a global reset is not steady.
 */
export function steadyWindow(s: SourceSamples | undefined, ticks: number): boolean {
    if (!s || ticks < SNAPSHOT_INTERVAL * STEADY_SHARE) return false;
    if (s.samples < Math.floor(ticks / SOURCE_SAMPLE_INTERVAL) * STEADY_SHARE) return false;
    if (s.homeChanged || s.threat > 0) return false;
    if (s.harvester < s.samples * STEADY_SHARE || s.container < s.samples * STEADY_SHARE) return false;
    const seen = s.reserved + s.unreserved;
    return Math.min(s.reserved, s.unreserved) <= seen * (1 - STEADY_SHARE);
}

function encodeSources(ticks: number): string {
    const selected = Memory.remoteMining?.sources ?? {};
    const parts: string[] = [];
    for (const key in sourceAcc) {
        const values = sourceAcc[key].map(v => Math.round(v).toString(36));
        const steady = steadyWindow(sourceSamples[key], ticks) ? 1 : 0;
        const home = selected[key]?.homeRoom ?? lastHome.get(key) ?? "";
        parts.push(`${key}=${values.join(",")},${steady},${home}`);
    }
    return parts.join(";");
}

/** Decodes one remote balance string of the history (see HistoryDetail.r) */
export function decodeBalance(text: string): { [key: string]: SourceBalance } {
    const sources: { [key: string]: SourceBalance } = {};
    if (!text) return sources;
    for (const part of text.split(";")) {
        const [key, values] = part.split("=");
        if (!values) continue;
        const [harvested, delivered, cost, steady, home] = values.split(",");
        sources[key] = {
            harvested: parseInt(harvested, 36) || 0,
            delivered: parseInt(delivered, 36) || 0,
            cost: parseInt(cost, 36) || 0,
            steady: steady === "1",
            home: home ?? ""
        };
    }
    return sources;
}

/** Remote balance windows of the history, oldest first (none while the segment is not loaded) */
export function remoteBalanceWindows(): BalanceWindow[] {
    if (!detailStore.ready) return [];
    return normalizedDetail().r.map(([tick, ticks, text]) => ({ tick, ticks, sources: decodeBalance(text) }));
}

function trim(data: { length: number; shift(): unknown }, size: () => number): void {
    let trimmed = false;
    while (data.length > 1 && size() > MAX_STORE_CHARS) {
        data.shift();
        trimmed = true;
    }
    if (trimmed) countStat("history:trimmed");
}

/** Keys of the counter sets, most used first (shorter strings), then the `extra` keys not in any set */
function keyTable(sets: { [key: string]: number }[], extra: { [key: string]: number } = {}): string[] {
    const uses: { [key: string]: number } = {};
    for (const values of sets) for (const key in values) uses[key] = (uses[key] ?? 0) + 1;
    for (const key in extra) uses[key] ??= 0;
    return Object.keys(uses).sort((a, b) => uses[b] - uses[a] || (a < b ? -1 : 1));
}

function snapshot(data: HistoryData, detail: HistoryDetail, counters: { [name: string]: number }): void {
    const previousTick = data.t!;
    const baseline = decode(data.b, data.k);
    const deltas: { [key: string]: number } = {};
    for (const key in counters) {
        const now = Math.round(counters[key]);
        const before = baseline[key] ?? 0;
        // A counter that went down was reset: its value is the increase
        const delta = now >= before ? now - before : now;
        if (delta > 0) deltas[key] = delta;
    }

    // Owned rooms (and homes with heap counters)
    const creeps = _.countBy(Game.creeps, c => c.memory.room ?? c.room.name);
    const rooms: { [room: string]: DecodedRoom } = {};
    for (const name in Game.rooms) {
        const room = Game.rooms[name];
        if (!room.controller?.my) continue;
        rooms[name] = {
            rcl: room.controller.level,
            progress: room.controller.progress,
            energy: roomEnergy(room),
            creeps: creeps[name] ?? 0,
            counters: roomAcc[name] ?? {}
        };
    }
    for (const name in roomAcc) {
        rooms[name] ??= { rcl: 0, progress: 0, energy: 0, creeps: creeps[name] ?? 0, counters: roomAcc[name] };
    }

    // Decode the kept entries, then rebuild the key table from the keys still in use (most used first)
    const kept = data.e.slice(-(HISTORY_SIZE - 1)).map(e => ({
        entry: e,
        counters: decode(e.c, data.k),
        rooms: _.mapValues(e.r, text => decodeRoom(text, data.rk)) as { [room: string]: DecodedRoom }
    }));
    const entry: HistoryEntry = {
        t: Game.time,
        d: Game.time - previousTick,
        cpu: round(cpuTicks > 0 ? cpuSum / cpuTicks : Memory.stats?.cpuAvg ?? 0, 1),
        bk: Game.cpu.bucket,
        bm: Math.min(bucketMin, Game.cpu.bucket),
        c: "",
        r: {}
    };
    if (accSince !== undefined && accSince > previousTick) entry.rd = Game.time - accSince;
    kept.push({ entry, counters: deltas, rooms });

    const counterKeys = keyTable(kept.map(k => k.counters), counters);
    const roomKeys = keyTable(_.flatten(kept.map(k => Object.keys(k.rooms).map(room => k.rooms[room].counters))));
    const index = new Map(counterKeys.map((key, i) => [key, i]));
    const roomIndex = new Map(roomKeys.map((key, i) => [key, i]));

    data.k = counterKeys;
    data.rk = roomKeys;
    data.t = Game.time;
    data.b = encode(counters, index);
    data.e = kept.map(k => {
        k.entry.c = encode(k.counters, index);
        k.entry.r = _.mapValues(k.rooms, room => encodeRoom(room, roomIndex)) as { [room: string]: string };
        return k.entry;
    });
    trim(data.e, () => JSON.stringify(data).length);
    historyStore.touchNow();

    const covered = entry.rd ?? entry.d;
    detail.r.push([Game.time, covered, encodeSources(covered)]);
    if (detail.r.length > HISTORY_SIZE) detail.r.splice(0, detail.r.length - HISTORY_SIZE);
    trim(detail.r, () => JSON.stringify(detail).length);
    detailStore.touchNow();

    countStat("history:snapshot");
    resetAccumulators();
}

function resetAccumulators(): void {
    accSince = Game.time;
    roomAcc = {};
    sourceAcc = {};
    sourceSamples = {};
    cpuSum = 0;
    cpuTicks = 0;
    bucketMin = Infinity;
}

export const historyModule = (): void => {
    accSince ??= Game.time;
    // CPU of the previous tick (recorded at the end of the loop) and the bucket
    const stats = Memory.stats;
    if (stats && stats.tick === Game.time - 1) {
        cpuSum += stats.cpu;
        cpuTicks++;
    }
    bucketMin = Math.min(bucketMin, Game.cpu.bucket);
    if (lastSourceSample === undefined || Game.time - lastSourceSample >= SOURCE_SAMPLE_INTERVAL) {
        lastSourceSample = Game.time;
        sampleSources();
    }

    if (!historyStore.ready || !detailStore.ready) return;
    const detail = normalizedDetail();
    if (spawnQueue.length > 0) {
        detail.s.push(...spawnQueue);
        if (detail.s.length > SPAWN_LOG_SIZE) detail.s.splice(0, detail.s.length - SPAWN_LOG_SIZE);
        spawnQueue = [];
        detailStore.touch();
    }

    const data = normalized();
    const counters = stats?.counters ?? {};
    if (data.t === undefined) {
        // First run: baseline only
        const index = new Map(Object.keys(counters).map((key, i) => [key, i]));
        data.k = Object.keys(counters);
        data.t = Game.time;
        data.b = encode(counters, index);
        historyStore.touchNow();
        resetAccumulators();
        return;
    }
    if (Game.time - data.t < SNAPSHOT_INTERVAL) return;
    snapshot(data, detail, counters);
};

// --- Readers (reports) ----------------------------------------------------------------------------

/**
 * Room counters per room since `since` (snapshots taken after it, plus the heap counters of the
 * current period), with the ticks they cover.
 */
export function roomCountersSince(since: number): { [room: string]: { ticks: number; counters: { [key: string]: number } } } {
    const result: { [room: string]: { ticks: number; counters: { [key: string]: number } } } = {};
    const add = (room: string, ticks: number, counters: { [key: string]: number }) => {
        const total = (result[room] ??= { ticks: 0, counters: {} });
        total.ticks += ticks;
        for (const key in counters) total.counters[key] = (total.counters[key] ?? 0) + counters[key];
    };
    if (historyStore.ready) {
        const data = normalized();
        for (const entry of data.e) {
            if (entry.t <= since) continue;
            for (const room in entry.r) add(room, entry.rd ?? entry.d, decodeRoom(entry.r[room], data.rk).counters);
        }
    }
    const start = Math.max(accSince ?? Game.time, historyStore.ready ? normalized().t ?? 0 : 0);
    const ticks = Game.time - start;
    const rooms = new Set([...Object.keys(roomAcc), ...Object.keys(result)]);
    for (const room of rooms) add(room, ticks, roomAcc[room] ?? {});
    return result;
}
