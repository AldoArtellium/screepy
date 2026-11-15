/**
 * Reports (Hivemind process/report.ts): every `interval` ticks (default 3000) a compact plain-text
 * report of the empire, sent with Game.notify (split in messages under 1000 characters) and logged:
 * GCL and RCL progress rates with ETAs, storage, energy income (empire, then per room with its
 * spending from the room counters of utils/history.ts), CPU and bucket, global resets, module
 * and role errors, throttled creeps, remotes, defense, expansion and attack. Also immediate alerts
 * (rate-limited): a room lost its last spawn (or the room itself), a controller close to downgrading,
 * a module failing repeatedly.
 *
 * Settings: `Memory.reports = false` (or `{ enabled: false }`) turns everything off;
 * `Memory.reports = { interval: 500, alerts: false }` changes the interval, turns the alerts off.
 * Counters, room states and the lowest bucket come from the history (utils/history.ts
 * historyWindow: from the last snapshot at or before the previous report), the CPU from
 * Memory.stats.cpuAvg; `Memory.reportState` only keeps the report tick, the GCL then and the alerts.
 */
import { STARVED_TICKS } from "../remote/RemoteMining";
import { rate, short } from "../utils/format";
import { HistoryWindow, historyWindow, roomCountersSince } from "../utils/history";
import { log } from "../utils/logger";
import { myRooms, storedEnergy } from "../utils/owned";

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
/** Fields of the report state before 2026-11-15 (own counter, room and CPU sampling), dropped */
const LEGACY_FIELDS = ["rooms", "counters", "cpuSum", "ticks", "cpuMax", "bucketMin"];

function settings(): ReportSettings | null {
    const value = Memory.reports;
    if (value === false) return null;
    if (value === undefined || value === true) return {};
    return value.enabled === false ? null : value;
}

function newState(): ReportState {
    return {
        time: Game.time,
        gcl: { level: Game.gcl.level, progress: Math.round(Game.gcl.progress) },
        alertCheck: Game.time,
        hadSpawn: [],
        alerts: {}
    };
}

/** What a report is built from: its state, the history window and the ticks of each */
interface ReportContext {
    state: ReportState;
    window: HistoryWindow;
    /** Ticks since the last report */
    ticks: number;
    /** Ticks the history window covers */
    windowTicks: number;
}

function counter(context: ReportContext, name: string): number {
    return Math.round(context.window.counters[name] ?? 0);
}

/** Total and "a 3, b 2" of the counter deltas with a prefix, biggest first */
function byPrefix(context: ReportContext, prefix: string): [number, string] {
    const entries: [string, number][] = [];
    for (const name in context.window.counters) {
        if (!name.startsWith(prefix)) continue;
        const value = counter(context, name);
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

/** GCL with its rate since the last report (total of a level: GCL_MULTIPLY * level ^ GCL_POW) */
function gclLine({ state, ticks }: ReportContext): string {
    const gcl = Game.gcl;
    const gain = progressGain(gcl.level, gcl.progress, state.gcl, Math.pow(state.gcl.level, GCL_POW) * GCL_MULTIPLY);
    let line = `GCL ${gcl.level} ${((100 * gcl.progress) / gcl.progressTotal).toFixed(1)}%`;
    if (gain !== undefined && gain > 0) {
        const gclRate = gain / ticks;
        line += ` +${rate(gclRate)}/t, next in ${short((gcl.progressTotal - gcl.progress) / gclRate)}t`;
    }
    return line;
}

/** Owned rooms: RCL progress rate and ETA, storage + terminal energy and its change over the history window */
function roomLines({ window, windowTicks }: ReportContext): string[] {
    return myRooms().map(room => {
        const controller = room.controller!;
        const previous = window.rooms[room.name];
        let line = `${room.name} RCL ${controller.level}`;
        if (controller.level < 8) {
            line += ` ${((100 * controller.progress) / controller.progressTotal).toFixed(0)}%`;
            const gain = previous
                ? progressGain(controller.level, controller.progress, { level: previous.rcl, progress: previous.progress }, CONTROLLER_LEVELS[previous.rcl])
                : undefined;
            if (gain !== undefined && gain > 0) {
                const roomRate = gain / windowTicks;
                line += ` +${rate(roomRate)}/t, RCL ${controller.level + 1} in ${short((controller.progressTotal - controller.progress) / roomRate)}t`;
            }
        }
        if (room.storage || room.terminal) {
            const energy = storedEnergy(room);
            line += ` | energy ${short(energy)}`;
            if (previous) line += ` (${energy >= previous.energy ? "+" : ""}${short(energy - previous.energy)})`;
        }
        if (room.find(FIND_MY_SPAWNS).length === 0) line += " | no spawn";
        return line;
    });
}

/**
 * Empire income, then one line per owned room from the room counters (utils/history.ts), energy per
 * tick: income local / remote, spending build / repair / upgrade / spawn, and the creeps of the room.
 */
function incomeLines(context: ReportContext): string[] {
    const local = counter(context, "work:harvest") / context.windowTicks;
    const remote = counter(context, "work:remoteHarvest") / context.windowTicks;
    const lines = [`Income ${rate(local + remote)}/t (local ${rate(local)}, remote ${rate(remote)})`];
    const totals = roomCountersSince(context.window.start);
    const creeps = _.countBy(Game.creeps, c => c.memory.room ?? c.room.name);
    for (const room of myRooms()) {
        const total = totals[room.name];
        if (!total || total.ticks <= 0) continue;
        const per = (key: string) => rate((total.counters[key] ?? 0) / total.ticks);
        let spawn = 0;
        for (const key in total.counters) if (key.startsWith("spawn:")) spawn += total.counters[key];
        lines.push(
            `  ${room.name} in local ${per("harvest")}, remote ${per("remoteHarvest")} | out build ${per("build")}, repair ${per("repair")}, ` +
                `upgrade ${per("upgrade")}, spawn ${rate(spawn / total.ticks)} | ${creeps[room.name] ?? 0} creeps (${total.ticks}t)`
        );
    }
    return lines;
}

/** CPU average (Memory.stats.cpuAvg), bucket, global resets */
function cpuLine(context: ReportContext): string {
    const resets = counter(context, "globalReset");
    return (
        `CPU ${(Memory.stats?.cpuAvg ?? 0).toFixed(1)} avg / ${Game.cpu.limit} | bucket min ${context.window.bucketMin}, now ${Game.cpu.bucket}` +
        (resets > 0 ? ` | ${resets} global reset${resets > 1 ? "s" : ""}` : "")
    );
}

/** Module errors since the last report (Memory.moduleErrors keeps the last 20), role errors, throttled creep-ticks, creeps */
function healthLines(context: ReportContext): string[] {
    const lines: string[] = [];
    const moduleErrors = _.countBy(
        (Memory.moduleErrors ?? []).filter(e => e.tick > context.state.time),
        e => e.module
    );
    const moduleErrorCount = _.sum(Object.keys(moduleErrors), m => moduleErrors[m]);
    const [roleErrorCount, roleErrors] = byPrefix(context, "roleError:");
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
    const [throttledCount, throttled] = byPrefix(context, "throttled:");
    if (throttledCount > 0) lines.push(`Throttled ${throttledCount}: ${throttled}`);
    const [spawned] = byPrefix(context, "spawned:");
    lines.push(`Creeps ${Object.keys(Game.creeps).length} | spawned ${spawned}, died ${counter(context, "memory:deadCreep")}`);
    return lines;
}

/** Remotes: rooms and sources per home, sources without remote harvester for STARVED_TICKS */
function remoteLines(): string[] {
    const remoteMining = Memory.remoteMining;
    if (!remoteMining || Object.keys(remoteMining.sources).length === 0) return [];
    const homes = _.groupBy(Object.values(remoteMining.sources), s => s.homeRoom);
    const parts = Object.keys(homes).map(home => {
        const sources = homes[home];
        const rooms = _.uniq(sources.map(s => s.room)).length;
        const starved = sources.filter(s => s.servedAt !== undefined && Game.time - s.servedAt > STARVED_TICKS).length;
        const cap = remoteMining.sourceCaps?.[home]?.max;
        return `${home} ${rooms} rooms ${sources.length} sources` + (cap !== undefined ? ` (cap ${cap})` : "") + (starved > 0 ? `, ${starved} starved` : "");
    });
    return [`Remotes ${parts.join("; ")}` + (remoteMining.maxRooms !== undefined ? ` | CPU cap ${remoteMining.maxRooms} rooms` : "")];
}

/** Defense: safe modes, rooms where dangerous hostiles were seen since the last report, squad losses */
function defenseLines(context: ReportContext): string[] {
    const safeModes = counter(context, "safeMode");
    const hostileRooms = Object.keys(Memory.rooms ?? {}).filter(r => (Memory.rooms[r].enemies?.lastSeen ?? 0) > context.state.time);
    const lost = counter(context, "military:lost");
    const underSafeMode = myRooms()
        .filter(r => !!r.controller!.safeMode)
        .map(r => `${r.name} ${short(r.controller!.safeMode!)}t`);
    const parts: string[] = [];
    if (hostileRooms.length > 0) parts.push(`hostiles in ${hostileRooms.slice(0, 8).join(", ")}${hostileRooms.length > 8 ? "..." : ""}`);
    if (safeModes > 0) parts.push(`${safeModes} safe mode${safeModes > 1 ? "s" : ""} activated`);
    if (underSafeMode.length > 0) parts.push(`safe mode ${underSafeMode.join(", ")}`);
    if (lost > 0) parts.push(`${lost} squad creeps lost`);
    return parts.length > 0 ? [`Defense ${parts.join(" | ")}`] : [];
}

function expansionLines({ state }: ReportContext): string[] {
    const expand = Memory.expand;
    if (!expand) return [];
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
    return parts.length > 0 ? [`Expansion ${parts.join(" | ")}`] : [];
}

function attackLines({ state }: ReportContext): string[] {
    const military = Memory.military;
    if (!military) return [];
    const parts: string[] = [];
    // Colony missions: the bases spawning members, the rally first
    const missions = [...Object.values(military.duos ?? {}), ...Object.values(military.quads ?? {})];
    const from = (room: string): string => {
        const mission = missions.find(m => m.targetRoom === room);
        if (!mission) return "";
        return ` from ${_.uniq([mission.spawnRoom, ...(mission.bases ?? [])]).join("+")}`;
    };
    if (military.attack) parts.push(`${military.attack} (manual)${from(military.attack)}`);
    for (const target of military.targets ?? []) if (target.room !== military.attack) parts.push(`${target.room} (${target.reason})${from(target.room)}`);
    for (const [room, siege] of Object.entries(military.sieges ?? {}))
        parts.push(`siege ${room} (${siege.owner}) RCL ${siege.level ?? "?"}, ${siege.attacks} attacks`);
    for (const entry of (military.log ?? []).filter(e => e.time > state.time)) parts.push(`${entry.room} ${entry.result}, ${entry.losses} lost`);
    const skipped = Object.keys(military.skipped ?? {});
    if (skipped.length > 0) parts.push(`left alone ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? ` +${skipped.length - 5}` : ""}`);
    return parts.length > 0 ? [`Attack ${parts.join(" | ")}`] : [];
}

export function buildReport(state: ReportState, window: HistoryWindow): string {
    const context: ReportContext = {
        state,
        window,
        ticks: Math.max(1, Game.time - state.time),
        windowTicks: Math.max(1, Game.time - window.start)
    };
    const header = `Report tick ${Game.time} (last ${context.ticks} ticks` + (window.start !== state.time ? `, history since ${window.start})` : ")");
    return [
        header,
        gclLine(context),
        ...roomLines(context),
        ...incomeLines(context),
        cpuLine(context),
        ...healthLines(context),
        ...remoteLines(),
        ...defenseLines(context),
        ...expansionLines(context),
        ...attackLines(context)
    ].join("\n");
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
    if ("counters" in state) for (const field of LEGACY_FIELDS) delete (state as unknown as Record<string, unknown>)[field];

    if (config.alerts !== false && Game.time - state.alertCheck >= ALERT_CHECK_INTERVAL) checkAlerts(state);

    if (Game.time - state.time < (config.interval ?? DEFAULT_INTERVAL)) return;
    // The history segment loads within a tick or two: the report waits for it
    const window = historyWindow(state.time);
    if (!window) return;
    const text = buildReport(state, window);
    console.log(`[Reports]\n${text}`);
    notify(text);

    // Baseline of the next report
    state.time = Game.time;
    state.gcl = { level: Game.gcl.level, progress: Math.round(Game.gcl.progress) };
};
