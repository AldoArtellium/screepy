/**
 * Room panel (top left): a two-column table with thin bars - controller progress and ETA, energy,
 * storage, income, CPU, bucket; creeps, spawning, construction; defense, remotes, expansion, attack.
 * Bars turn orange then red only when something needs attention; empty rows are left out.
 * Rates come from heap samples taken every SAMPLE_INTERVAL ticks over a 1000-tick sliding window.
 */

import { hasEnemies } from "../core/roomState";
import { enemyStrength } from "../defense/RoomDefense";
import { spawnManager } from "../modules/SpawnManager";

const SAMPLE_INTERVAL = 100;
/** Samples kept: 10 intervals = 1000 ticks */
const MAX_SAMPLES = 11;
const STRENGTH_NAMES = ["NONE", "WEAK", "NORMAL", "STRONG", "DEADLY"];

const FONT = 0.5;
const ROW = 0.7;
const LEFT = 0.4;
const TOP = 0.4;
const WIDTH = 13;
/** x of the value column, relative to LEFT */
const VALUE_X = 3.2;
const BAR_WIDTH = 4;
const BAR_HEIGHT = 0.3;

const TEXT = "#d8d8d8";
const DIM = "#8a8a8a";
const TITLE = "#ffffff";
const OK = "#5fbf6f";
const WARN = "#e8a23a";
const BAD = "#e05555";
const BAR_BACK = "#3a3a3a";

/** Short role names for the creeps row */
const ROLE_NAMES: { [role: string]: string } = {
    harvester: "harv",
    transporter: "tran",
    builder: "buil",
    upgrader: "upg",
    remoteHarvester: "rHarv",
    remoteHauler: "rHaul",
    remoteBuilder: "rBuil",
    remoteDefender: "rDef",
    reserver: "res",
    guardian: "guard",
    claimer: "claim",
    pioneer: "pion"
};

interface Sample {
    tick: number;
    value: number;
}

/** Controller progress by room (reset on level change) and empire-wide harvest counters */
const progressSamples: Map<string, { level: number; samples: Sample[] }> = new Map();
const incomeSamples: { local: Sample[]; remote: Sample[] } = { local: [], remote: [] };

function pushSample(samples: Sample[], value: number): void {
    const last = samples[samples.length - 1];
    if (last && Game.time - last.tick < SAMPLE_INTERVAL) return;
    samples.push({ tick: Game.time, value });
    if (samples.length > MAX_SAMPLES) samples.shift();
}

/** Increase per tick over the window, undefined with a single sample */
function rate(samples: Sample[]): number | undefined {
    if (samples.length < 2) return undefined;
    const first = samples[0];
    const last = samples[samples.length - 1];
    return (last.value - first.value) / (last.tick - first.tick);
}

/** Samples the empire-wide harvest counters (WORK parts that harvested, cumulated) */
export function sampleIncome(): void {
    const counters = Memory.stats?.counters ?? {};
    pushSample(incomeSamples.local, (counters["work:harvest"] ?? 0) * HARVEST_POWER);
    pushSample(incomeSamples.remote, (counters["work:remoteHarvest"] ?? 0) * HARVEST_POWER);
}

function sampleProgress(controller: StructureController): number | undefined {
    let state = progressSamples.get(controller.room.name);
    if (!state || state.level !== controller.level) {
        state = { level: controller.level, samples: [] };
        progressSamples.set(controller.room.name, state);
    }
    pushSample(state.samples, controller.progress);
    return rate(state.samples);
}

function short(value: number): string {
    if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
    if (Math.abs(value) >= 1e4) return `${(value / 1e3).toFixed(1)}k`;
    return `${Math.round(value)}`;
}

function rateText(value: number | undefined): string {
    return value === undefined ? "-" : value.toFixed(1);
}

/** A table row: label, optional bar (fill 0..1 and color), text after the bar */
interface Row {
    label: string;
    bar?: { fill: number; color: string };
    text: string;
    color?: string;
}

/** "separator" draws a thin line between groups */
type Entry = Row | "separator";

/** Green below `warn`, orange below `bad`, red above (or the reverse with `lowIsBad`) */
function level(value: number, warn: number, bad: number, lowIsBad = false): string {
    if (lowIsBad) return value < bad ? BAD : value < warn ? WARN : OK;
    return value > bad ? BAD : value > warn ? WARN : OK;
}

function economyRows(room: Room): Entry[] {
    const controller = room.controller!;
    const rows: Entry[] = [];

    const progressRate = sampleProgress(controller);
    if (controller.level < 8) {
        const fill = controller.progress / controller.progressTotal;
        const remaining = controller.progressTotal - controller.progress;
        const eta = progressRate && progressRate > 0 ? `  ~${short(remaining / progressRate)} t` : "";
        rows.push({ label: "Controller", bar: { fill, color: OK }, text: `${Math.floor(100 * fill)}%${eta}` });
    }
    const energyFill = room.energyAvailable / Math.max(1, room.energyCapacityAvailable);
    rows.push({
        label: "Energy",
        bar: { fill: energyFill, color: level(energyFill, 0.5, 0.25, true) },
        text: `${room.energyAvailable}/${room.energyCapacityAvailable}`
    });
    if (room.storage) {
        const stored = room.storage.store.getUsedCapacity(RESOURCE_ENERGY);
        rows.push({ label: "Storage", bar: { fill: stored / STORAGE_CAPACITY, color: OK }, text: short(stored) });
    }
    const local = rate(incomeSamples.local);
    const remote = rate(incomeSamples.remote);
    if (local !== undefined && remote !== undefined) {
        rows.push({ label: "Income", text: `${rateText(local + remote)}/t   local ${rateText(local)} · remote ${rateText(remote)}` });
    }
    const cpu = Memory.stats?.cpuAvg ?? 0;
    const cpuFill = cpu / Game.cpu.limit;
    rows.push({ label: "CPU", bar: { fill: cpuFill, color: level(cpuFill, 0.8, 0.95) }, text: `${cpu.toFixed(1)}/${Game.cpu.limit}` });
    const bucketFill = Game.cpu.bucket / 10000;
    rows.push({ label: "Bucket", bar: { fill: bucketFill, color: level(bucketFill, 0.5, 0.2, true) }, text: `${Game.cpu.bucket}` });
    return rows;
}

function creepRows(room: Room): Entry[] {
    const rows: Entry[] = [];
    const roles: { [role: string]: number } = {};
    let creeps = 0;
    for (const name in Game.creeps) {
        const creep = Game.creeps[name];
        if ((creep.memory.room ?? creep.room.name) !== room.name) continue;
        const role = creep.memory.role ?? "none";
        roles[role] = (roles[role] ?? 0) + 1;
        creeps++;
    }
    const entries = Object.keys(roles)
        .sort()
        .map(role => `${ROLE_NAMES[role] ?? role} ${roles[role]}`);
    for (let i = 0; i < Math.max(1, entries.length); i += 4) {
        rows.push({ label: i === 0 ? `Creeps ${creeps}` : "", text: entries.slice(i, i + 4).join(" · "), color: DIM });
    }

    const spawning: string[] = [];
    for (const spawn of room.find(FIND_MY_SPAWNS)) {
        if (!spawn.spawning) continue;
        const role = Memory.creeps[spawn.spawning.name]?.role ?? spawn.spawning.name;
        spawning.push(`▶ ${ROLE_NAMES[role] ?? role} ${spawn.spawning.remainingTime}t`);
    }
    const next = spawnManager.nextRole(room.name);
    if (next) spawning.push(`next ${ROLE_NAMES[next] ?? next}`);
    if (spawning.length > 0) rows.push({ label: "Spawn", text: spawning.join(" · ") });

    const sites = room.find(FIND_MY_CONSTRUCTION_SITES);
    if (sites.length > 0) {
        const done = sites.reduce((sum, s) => sum + s.progress, 0);
        const needed = sites.reduce((sum, s) => sum + s.progressTotal, 0);
        rows.push({ label: "Sites", bar: { fill: done / needed, color: OK }, text: `${sites.length} · ${Math.floor((100 * done) / needed)}%` });
    }
    return rows;
}

function infoRows(room: Room): Entry[] {
    const rows: Entry[] = [];
    const strength = hasEnemies(room) ? enemyStrength(room) : 0;
    const towers = room.find(FIND_MY_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_TOWER
    }) as StructureTower[];
    const towerEnergy = towers.reduce((sum, t) => sum + t.store.getUsedCapacity(RESOURCE_ENERGY), 0);
    const towerText =
        towers.length > 0 ? `   towers ${towers.length} · ${Math.floor((100 * towerEnergy) / (towers.length * TOWER_CAPACITY))}%` : "";
    rows.push({
        label: "Defense",
        text: `● ${STRENGTH_NAMES[strength]}${towerText}`,
        color: strength >= 2 ? BAD : strength === 1 ? WARN : OK
    });
    const safeMode = room.controller?.safeMode;
    if (safeMode) rows.push({ label: "Safe mode", text: `${short(safeMode)} t`, color: WARN });

    const remotes = Object.values(Memory.remoteMining?.sources ?? {}).filter(s => s.homeRoom === room.name);
    if (remotes.length > 0) {
        rows.push({ label: "Remotes", text: `${remotes.length} sources · ${new Set(remotes.map(s => s.room)).size} rooms` });
    }
    const plan = room.memory.plan;
    if (plan && !plan.done) rows.push({ label: "Plan", text: `searching (${plan.k ?? "?"})`, color: DIM });

    const expansion = Memory.expand?.current;
    if (expansion?.spawnRoom === room.name) {
        rows.push({ label: "Expansion", text: `${expansion.roomName}${expansion.claimed ? " · claimed" : ""}` });
    }
    const attack = Memory.military?.attack;
    if (attack) rows.push({ label: "Attack", text: attack, color: BAD });
    return rows;
}

/** Draws the panel of an owned room */
export function drawPanel(visual: RoomVisual, room: Room): void {
    const controller = room.controller!;
    const entries: Entry[] = [...economyRows(room), "separator", ...creepRows(room), "separator", ...infoRows(room)];
    const height = 1.1 + entries.reduce((h, e) => h + (e === "separator" ? 0.3 : ROW), 0);

    visual.rect(LEFT, TOP, WIDTH, height, { fill: "#101010", opacity: 0.7, stroke: "#444444", strokeWidth: 0.04 });
    const rcl = controller.level < 8 ? `RCL ${controller.level} → ${controller.level + 1}` : "RCL 8";
    visual.text(room.name, LEFT + 0.3, TOP + 0.7, { align: "left", font: `bold ${FONT + 0.1}`, color: TITLE });
    visual.text(rcl, LEFT + WIDTH - 0.3, TOP + 0.7, { align: "right", font: FONT, color: DIM });

    let y = TOP + 1.1;
    for (const entry of entries) {
        if (entry === "separator") {
            visual.line(LEFT + 0.2, y + 0.1, LEFT + WIDTH - 0.2, y + 0.1, { color: "#444444", width: 0.03 });
            y += 0.3;
            continue;
        }
        const baseline = y + ROW * 0.65;
        visual.text(entry.label, LEFT + 0.3, baseline, { align: "left", font: FONT, color: DIM });
        let x = LEFT + VALUE_X;
        if (entry.bar) {
            const fill = Math.max(0, Math.min(1, entry.bar.fill));
            const top = baseline - 0.3;
            visual.rect(x, top, BAR_WIDTH, BAR_HEIGHT, { fill: BAR_BACK, opacity: 0.9 });
            if (fill > 0) visual.rect(x, top, BAR_WIDTH * fill, BAR_HEIGHT, { fill: entry.bar.color, opacity: 0.9 });
            x += BAR_WIDTH + 0.3;
        }
        visual.text(entry.text, x, baseline, { align: "left", font: FONT, color: entry.color ?? TEXT });
        y += ROW;
    }
}
