/**
 * Reports (Hivemind process/report.ts): every `interval` ticks (default 3000) a compact plain-text
 * report of the empire, sent with Game.notify (split in messages under 1000 characters) and logged:
 * GCL and RCL progress rates with ETAs, storage, energy income, CPU and bucket, global resets, module
 * and role errors, throttled creeps, remotes, defense, expansion and attack. Also immediate alerts
 * (rate-limited): a room lost its last spawn (or the room itself), a controller close to downgrading,
 * a module failing repeatedly.
 *
 * Settings: `Memory.reports = false` (or `{ enabled: false }`) turns everything off;
 * `Memory.reports = { interval: 500, alerts: false }` changes the interval, turns the alerts off.
 * Built from counter deltas (Memory.stats.counters) and owned rooms only; the state between two
 * reports lives in `Memory.reportState` (a few hundred characters).
 */
import { STARVED_TICKS } from "../remote/RemoteMining";
import { log } from "../utils/logger";

interface ReportSettings {
    enabled?: boolean;
    /** Ticks between two reports (default DEFAULT_INTERVAL) */
    interval?: number;
    /** false: no immediate alerts */
    alerts?: boolean;
}

interface ReportState {
    /** Tick of the last report (the baseline of the next one) */
    time: number;
    gcl: { level: number; progress: number };
    /** Owned rooms at the last report: RCL, progress, storage + terminal energy */
    rooms: { [room: string]: { level: number; progress: number; energy: number } };
    /** Counter values at the last report (tracked keys only, see trackedCounters) */
    counters: { [name: string]: number };
    /** Sum of the tick CPU and number of ticks sampled since the last report, highest tick CPU */
    cpuSum: number;
    ticks: number;
    cpuMax: number;
    bucketMin: number;
    /** Last alert check, rooms that had a spawn then, last tick of each alert (rate limit) */
    alertCheck: number;
    hadSpawn: string[];
    alerts: { [key: string]: number };
}

declare global {
    interface Memory {
        reports?: boolean | ReportSettings;
        reportState?: ReportState;
    }
}

const DEFAULT_INTERVAL = 3000;
const ALERT_CHECK_INTERVAL = 100;
/** Same alert (room and kind, or module) at most once per ALERT_REPEAT ticks */
const ALERT_REPEAT = 5000;
const DOWNGRADE_ALERT = 5000;
/** Errors of one module within an alert check interval that make it "failing repeatedly" */
const MODULE_ERROR_ALERT = 3;
/** Game.notify drops what is beyond 1000 characters (room left for the "(i/n) " prefix) */
const NOTIFY_MAX = 990;

function settings(): ReportSettings | null {
    const value = Memory.reports;
    if (value === false) return null;
    if (value === undefined || value === true) return {};
    return value.enabled === false ? null : value;
}

/** Counters compared between two reports: plain keys and the prefixes kept by name */
const TRACKED = [
    "work:harvest",
    "work:remoteHarvest",
    "globalReset",
    "safeMode",
    "memory:deadCreep",
    "military:lost",
    "pixels:generated",
    "pixels:sold",
    "cpuUnlock:bought",
    "cpuUnlock:used"
];
const TRACKED_PREFIXES = ["roleError:", "throttled:"];

function trackedCounters(): { [name: string]: number } {
    const counters = Memory.stats?.counters ?? {};
    const result: { [name: string]: number } = {};
    let spawned = 0;
    for (const name in counters) {
        if (name.startsWith("spawned:")) spawned += counters[name];
        else if (TRACKED.includes(name) || TRACKED_PREFIXES.some(p => name.startsWith(p))) {
            result[name] = Math.round(counters[name]);
        }
    }
    result.spawned = spawned;
    return result;
}

/** Counter increase since the last report (a counter that went down was reset: its value is the increase) */
function delta(current: { [name: string]: number }, previous: { [name: string]: number }, name: string): number {
    const now = current[name] ?? 0;
    const before = previous[name] ?? 0;
    return now >= before ? now - before : now;
}

function myRooms(): Room[] {
    return _.filter(Game.rooms, r => !!r.controller?.my);
}

function roomEnergy(room: Room): number {
    return (room.storage?.store.energy ?? 0) + (room.terminal?.store.energy ?? 0);
}

function snapshotRooms(state: ReportState): void {
    state.rooms = {};
    for (const room of myRooms()) {
        const controller = room.controller!;
        state.rooms[room.name] = { level: controller.level, progress: controller.progress, energy: roomEnergy(room) };
    }
}

function newState(): ReportState {
    const state: ReportState = {
        time: Game.time,
        gcl: { level: Game.gcl.level, progress: Math.round(Game.gcl.progress) },
        rooms: {},
        counters: trackedCounters(),
        cpuSum: 0,
        ticks: 0,
        cpuMax: 0,
        bucketMin: Game.cpu.bucket,
        alertCheck: Game.time,
        hadSpawn: [],
        alerts: {}
    };
    snapshotRooms(state);
    return state;
}

/** 1234 -> "1234", 12345 -> "12.3k", 1234567 -> "1.23M" */
function short(value: number): string {
    const abs = Math.abs(value);
    if (abs >= 1e6) return `${(value / 1e6).toPrecision(3)}M`;
    if (abs >= 1e4) return `${(value / 1e3).toPrecision(3)}k`;
    return `${Math.round(value)}`;
}

function rate(value: number): string {
    return Math.abs(value) >= 100 ? `${Math.round(value)}` : value.toFixed(1);
}

/** Total and "a 3, b 2" of the counter deltas with a prefix, biggest first */
function byPrefix(current: { [name: string]: number }, previous: { [name: string]: number }, prefix: string): [number, string] {
    const entries: [string, number][] = [];
    for (const name in current) {
        if (!name.startsWith(prefix)) continue;
        const value = delta(current, previous, name);
        if (value > 0) entries.push([name.slice(prefix.length), value]);
    }
    entries.sort((a, b) => b[1] - a[1]);
    return [_.sum(entries, e => e[1]), entries.map(([name, value]) => `${name} ${value}`).join(", ")];
}

/**
 * Progress gained since a level / progress snapshot; across one level up the previous level's
 * remainder (`previousTotal`) counts too; undefined when unknown (several levels, level lost).
 */
function progressGain(level: number, progress: number, previous: { level: number; progress: number }, previousTotal?: number): number | undefined {
    if (level === previous.level) return progress - previous.progress;
    if (level === previous.level + 1 && previousTotal !== undefined) return previousTotal - previous.progress + progress;
    return undefined;
}

export function buildReport(state: ReportState): string {
    const ticks = Math.max(1, Game.time - state.time);
    const counters = trackedCounters();
    const lines: string[] = [`Report tick ${Game.time} (last ${ticks} ticks)`];

    // GCL (total of a level: GCL_MULTIPLY * level ^ GCL_POW)
    const gcl = Game.gcl;
    const gclGain = progressGain(gcl.level, gcl.progress, state.gcl, Math.pow(state.gcl.level, GCL_POW) * GCL_MULTIPLY);
    let gclLine = `GCL ${gcl.level} ${((100 * gcl.progress) / gcl.progressTotal).toFixed(1)}%`;
    if (gclGain !== undefined && gclGain > 0) {
        const gclRate = gclGain / ticks;
        gclLine += ` +${rate(gclRate)}/t, next in ${short((gcl.progressTotal - gcl.progress) / gclRate)}t`;
    }
    lines.push(gclLine);

    // Owned rooms: RCL progress rate and ETA, storage + terminal energy
    for (const room of myRooms()) {
        const controller = room.controller!;
        const previous = state.rooms[room.name];
        let line = `${room.name} RCL ${controller.level}`;
        if (controller.level < 8) {
            line += ` ${((100 * controller.progress) / controller.progressTotal).toFixed(0)}%`;
            const gain = previous ? progressGain(controller.level, controller.progress, previous, CONTROLLER_LEVELS[previous.level]) : undefined;
            if (gain !== undefined && gain > 0) {
                const roomRate = gain / ticks;
                line += ` +${rate(roomRate)}/t, RCL ${controller.level + 1} in ${short((controller.progressTotal - controller.progress) / roomRate)}t`;
            }
        }
        if (room.storage || room.terminal) {
            const energy = roomEnergy(room);
            line += ` | energy ${short(energy)}`;
            if (previous) line += ` (${energy >= previous.energy ? "+" : ""}${short(energy - previous.energy)})`;
        }
        if (room.find(FIND_MY_SPAWNS).length === 0) line += " | no spawn";
        lines.push(line);
    }

    // Energy harvested (WORK parts x HARVEST_POWER)
    const local = (delta(counters, state.counters, "work:harvest") * HARVEST_POWER) / ticks;
    const remote = (delta(counters, state.counters, "work:remoteHarvest") * HARVEST_POWER) / ticks;
    lines.push(`Income ${rate(local + remote)}/t (local ${rate(local)}, remote ${rate(remote)})`);

    // CPU (tick CPU of the sampled ticks, from Memory.stats.cpu)
    const cpuAvg = state.ticks > 0 ? state.cpuSum / state.ticks : (Memory.stats?.cpuAvg ?? 0);
    const resets = delta(counters, state.counters, "globalReset");
    lines.push(
        `CPU ${cpuAvg.toFixed(1)} avg, ${state.cpuMax.toFixed(0)} max / ${Game.cpu.limit} | bucket min ${state.bucketMin}, now ${Game.cpu.bucket}` +
            (resets > 0 ? ` | ${resets} global reset${resets > 1 ? "s" : ""}` : "")
    );

    // Pixels and CPU unlocks (modules/Pixels.ts, Memory.pixels)
    const pixelCounts = ["pixels:generated", "pixels:sold", "cpuUnlock:bought", "cpuUnlock:used"].map(n => delta(counters, state.counters, n));
    if (Memory.pixels || _.some(pixelCounts, n => n > 0)) {
        const [generated, sold, bought, used] = pixelCounts;
        lines.push(
            `Pixels ${generated} generated, ${sold} sold (stock ${Game.resources[PIXEL] ?? 0}) | CPU unlocks ${bought} bought, ${used} used (stock ${Game.resources[CPU_UNLOCK] ?? 0})` +
                (Game.cpu.unlockedTime ? ` | full CPU ${((Game.cpu.unlockedTime - Date.now()) / 3600000).toFixed(1)} h` : "") +
                ` | credits ${Math.round(Game.market.credits)}`
        );
    }

    // Errors since the last report (Memory.moduleErrors keeps the last 20)
    const moduleErrors = _.countBy(
        (Memory.moduleErrors ?? []).filter(e => e.tick > state.time),
        e => e.module
    );
    const moduleErrorCount = _.sum(Object.keys(moduleErrors), m => moduleErrors[m]);
    const [roleErrorCount, roleErrors] = byPrefix(counters, state.counters, "roleError:");
    if (moduleErrorCount > 0 || roleErrorCount > 0) {
        const modules = Object.keys(moduleErrors)
            .map(m => `${m} ${moduleErrors[m]}`)
            .join(", ");
        lines.push(
            "Errors" +
                (moduleErrorCount > 0 ? ` | modules ${moduleErrorCount}${moduleErrorCount >= 20 ? "+" : ""}: ${modules}` : "") +
                (roleErrorCount > 0 ? ` | roles ${roleErrorCount}: ${roleErrors}` : "")
        );
    }

    // Creep-ticks whose logic the CPU throttle skipped
    const [throttledCount, throttled] = byPrefix(counters, state.counters, "throttled:");
    if (throttledCount > 0) lines.push(`Throttled ${throttledCount}: ${throttled}`);

    const spawned = delta(counters, state.counters, "spawned");
    const died = delta(counters, state.counters, "memory:deadCreep");
    lines.push(`Creeps ${Object.keys(Game.creeps).length} | spawned ${spawned}, died ${died}`);

    // Remotes: rooms and sources per home, sources without remote harvester for STARVED_TICKS
    const remoteMining = Memory.remoteMining;
    if (remoteMining && Object.keys(remoteMining.sources).length > 0) {
        const homes = _.groupBy(Object.values(remoteMining.sources), s => s.homeRoom);
        const parts = Object.keys(homes).map(home => {
            const sources = homes[home];
            const rooms = _.uniq(sources.map(s => s.room)).length;
            const starved = sources.filter(s => s.servedAt !== undefined && Game.time - s.servedAt > STARVED_TICKS).length;
            const cap = remoteMining.sourceCaps?.[home]?.max;
            return (
                `${home} ${rooms} rooms ${sources.length} sources` +
                (cap !== undefined ? ` (cap ${cap})` : "") +
                (starved > 0 ? `, ${starved} starved` : "")
            );
        });
        lines.push(`Remotes ${parts.join("; ")}` + (remoteMining.maxRooms !== undefined ? ` | CPU cap ${remoteMining.maxRooms} rooms` : ""));
    }

    // Defense: safe modes, rooms where dangerous hostiles were seen since the last report, squad losses
    const safeModes = delta(counters, state.counters, "safeMode");
    const hostileRooms = Object.keys(Memory.rooms ?? {}).filter(r => (Memory.rooms[r].enemies?.lastSeen ?? 0) > state.time);
    const lost = delta(counters, state.counters, "military:lost");
    const underSafeMode = myRooms()
        .filter(r => !!r.controller!.safeMode)
        .map(r => `${r.name} ${short(r.controller!.safeMode!)}t`);
    if (safeModes > 0 || hostileRooms.length > 0 || lost > 0 || underSafeMode.length > 0) {
        const parts: string[] = [];
        if (hostileRooms.length > 0) parts.push(`hostiles in ${hostileRooms.slice(0, 8).join(", ")}${hostileRooms.length > 8 ? "..." : ""}`);
        if (safeModes > 0) parts.push(`${safeModes} safe mode${safeModes > 1 ? "s" : ""} activated`);
        if (underSafeMode.length > 0) parts.push(`safe mode ${underSafeMode.join(", ")}`);
        if (lost > 0) parts.push(`${lost} squad creeps lost`);
        lines.push(`Defense ${parts.join(" | ")}`);
    }

    // Expansion
    const expand = Memory.expand;
    if (expand) {
        const parts: string[] = [];
        const current = expand.current;
        if (current) {
            parts.push(
                `${current.roomName} from ${current.spawnRoom}, ` +
                    (current.claimed ? `claimed ${short(Game.time - current.claimed)}t ago` : `started ${short(Game.time - current.started)}t ago`)
            );
        }
        const failed = expand.failed.filter(f => f.time > state.time).map(f => f.roomName);
        if (failed.length > 0) parts.push(`failed ${failed.join(", ")}`);
        if (parts.length > 0) lines.push(`Expansion ${parts.join(" | ")}`);
    }

    // Attack
    const military = Memory.military;
    if (military) {
        const parts: string[] = [];
        const target = military.attack ?? military.target?.room;
        if (target) parts.push(`${target} (${military.attack ? "manual" : military.target?.reason})`);
        for (const entry of (military.log ?? []).filter(e => e.time > state.time)) {
            parts.push(`${entry.room} ${entry.result}, ${entry.losses} lost`);
        }
        if (parts.length > 0) lines.push(`Attack ${parts.join(" | ")}`);
    }

    return lines.join("\n");
}

/** Game.notify in chunks of whole lines under NOTIFY_MAX characters, numbered when more than one */
function notify(text: string): void {
    const chunks: string[] = [];
    let current = "";
    for (const line of text.split("\n")) {
        const piece = line.length > NOTIFY_MAX ? `${line.slice(0, NOTIFY_MAX - 3)}...` : line;
        if (current && current.length + 1 + piece.length > NOTIFY_MAX) {
            chunks.push(current);
            current = piece;
        } else {
            current = current ? `${current}\n${piece}` : piece;
        }
    }
    if (current) chunks.push(current);
    chunks.forEach((chunk, i) => Game.notify(chunks.length > 1 ? `(${i + 1}/${chunks.length}) ${chunk}` : chunk));
}

function alert(state: ReportState, key: string, text: string): void {
    if (state.alerts[key] !== undefined && Game.time - state.alerts[key] < ALERT_REPEAT) return;
    state.alerts[key] = Game.time;
    log.warn("Reports", text);
    notify(`[${Game.time}] ${text}`);
}

/** Immediate alerts: last spawn or room lost, controller about to downgrade, a module failing repeatedly */
function checkAlerts(state: ReportState): void {
    const owned = new Set(myRooms().map(r => r.name));
    const withSpawn: string[] = [];
    for (const name of owned) {
        const room = Game.rooms[name];
        if (room.find(FIND_MY_SPAWNS).length > 0) withSpawn.push(name);
        else if (state.hadSpawn.includes(name)) alert(state, `spawn:${name}`, `${name} lost its last spawn`);
        const controller = room.controller!;
        if (controller.ticksToDowngrade !== undefined && controller.ticksToDowngrade < DOWNGRADE_ALERT) {
            alert(state, `downgrade:${name}`, `${name} RCL ${controller.level} downgrades in ${controller.ticksToDowngrade} ticks`);
        }
    }
    for (const name of state.hadSpawn) {
        if (!owned.has(name)) alert(state, `lost:${name}`, `${name} is no longer owned`);
    }
    state.hadSpawn = withSpawn;

    const errors = _.countBy(
        (Memory.moduleErrors ?? []).filter(e => e.tick > state.alertCheck),
        e => e.module
    );
    for (const module in errors) {
        if (errors[module] < MODULE_ERROR_ALERT) continue;
        const last = _.findLast(Memory.moduleErrors ?? [], e => e.module === module);
        const message = last ? last.message.split("\n")[0] : "";
        alert(state, `module:${module}`, `Module ${module} failed ${errors[module]} times in ${Game.time - state.alertCheck} ticks: ${message}`);
    }

    for (const key in state.alerts) {
        if (Game.time - state.alerts[key] >= ALERT_REPEAT) delete state.alerts[key];
    }
    state.alertCheck = Game.time;
}

export const reportsModule = (): void => {
    const config = settings();
    if (!config) {
        delete Memory.reportState;
        return;
    }
    // First run (or after a Memory wipe): baseline only
    if (!Memory.reportState) {
        Memory.reportState = newState();
        return;
    }
    const state = Memory.reportState;

    // CPU of the previous tick (recorded at the end of the loop) and the bucket
    const stats = Memory.stats;
    if (stats && stats.tick === Game.time - 1) {
        state.cpuSum = Math.round((state.cpuSum + stats.cpu) * 100) / 100;
        state.ticks++;
        state.cpuMax = Math.max(state.cpuMax, Math.round(stats.cpu * 10) / 10);
    }
    state.bucketMin = Math.min(state.bucketMin, Game.cpu.bucket);

    if (config.alerts !== false && Game.time - state.alertCheck >= ALERT_CHECK_INTERVAL) checkAlerts(state);

    if (Game.time - state.time < (config.interval ?? DEFAULT_INTERVAL)) return;
    const text = buildReport(state);
    console.log(`[Reports]\n${text}`);
    notify(text);

    // Baseline of the next report
    state.time = Game.time;
    state.gcl = { level: Game.gcl.level, progress: Math.round(Game.gcl.progress) };
    snapshotRooms(state);
    state.counters = trackedCounters();
    state.cpuSum = 0;
    state.ticks = 0;
    state.cpuMax = 0;
    state.bucketMin = Game.cpu.bucket;
};
