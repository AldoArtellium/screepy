/**
 * Economy panel (top left) and room info lines below it: RCL with ETA, energy, income, CPU, creeps,
 * spawning, remotes, construction, then enemies, safe mode, towers, plan, expansion and attack.
 * Rates come from heap samples taken every SAMPLE_INTERVAL ticks over a WINDOW-tick sliding window.
 */

import { hasEnemies } from "../core/roomState";
import { enemyStrength } from "../defense/RoomDefense";
import { spawnManager } from "../modules/SpawnManager";

const SAMPLE_INTERVAL = 100;
/** Samples kept: 10 intervals = 1000 ticks */
const MAX_SAMPLES = 11;
const STRENGTH_NAMES = ["NONE", "WEAK", "NORMAL", "STRONG", "DEADLY"];

const FONT = 0.6;
const LINE_HEIGHT = 0.8;
const PANEL_WIDTH = 15;
const TEXT_COLOR = "#e8e8e8";
const TITLE_COLOR = "#ffe56d";
const WARN_COLOR = "#ff6060";

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

type Line = [text: string, color?: string];

function economyLines(room: Room): Line[] {
    const controller = room.controller!;
    const lines: Line[] = [];

    // RCL, progress and ETA of the next level
    const progressRate = sampleProgress(controller);
    if (controller.level >= 8) {
        lines.push([`${room.name}  RCL 8`, TITLE_COLOR]);
    } else {
        const percent = ((100 * controller.progress) / controller.progressTotal).toFixed(1);
        const remaining = controller.progressTotal - controller.progress;
        const eta = progressRate && progressRate > 0 ? `ETA ${short(remaining / progressRate)} t` : "ETA -";
        lines.push([`${room.name}  RCL ${controller.level}  ${percent}%  ${eta}`, TITLE_COLOR]);
    }

    const storage = room.storage ? `  storage ${short(room.storage.store.getUsedCapacity(RESOURCE_ENERGY))}` : "";
    lines.push([`Energy ${room.energyAvailable}/${room.energyCapacityAvailable}${storage}`]);

    const local = rate(incomeSamples.local);
    const remote = rate(incomeSamples.remote);
    const total = local === undefined || remote === undefined ? undefined : local + remote;
    lines.push([`Income ${rateText(total)}/t (local ${rateText(local)}, remote ${rateText(remote)})`]);

    const stats = Memory.stats;
    const cpu = `CPU ${(stats?.cpu ?? 0).toFixed(1)} avg ${(stats?.cpuAvg ?? 0).toFixed(1)} / ${Game.cpu.limit}`;
    lines.push([`${cpu}  bucket ${Game.cpu.bucket}`, Game.cpu.bucket < 5000 ? WARN_COLOR : undefined]);

    // Creeps of the room by role, three roles per line
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
        .map(role => `${role} ${roles[role]}`);
    lines.push([`Creeps ${creeps}`]);
    for (let i = 0; i < entries.length; i += 3) lines.push([`  ${entries.slice(i, i + 3).join(", ")}`]);

    // Spawning, then the role waiting for energy
    for (const spawn of room.find(FIND_MY_SPAWNS)) {
        if (!spawn.spawning) continue;
        const role = Memory.creeps[spawn.spawning.name]?.role ?? spawn.spawning.name;
        lines.push([`Spawning ${role} (${spawn.spawning.remainingTime} t)`]);
    }
    const next = spawnManager.nextRole(room.name);
    if (next) lines.push([`Next ${next}`]);

    const remotes = Object.values(Memory.remoteMining?.sources ?? {}).filter(s => s.homeRoom === room.name);
    if (remotes.length > 0) {
        lines.push([`Remotes ${remotes.length} sources in ${new Set(remotes.map(s => s.room)).size} rooms`]);
    }

    const sites = room.find(FIND_MY_CONSTRUCTION_SITES);
    if (sites.length > 0) {
        const done = sites.reduce((sum, s) => sum + s.progress, 0);
        const needed = sites.reduce((sum, s) => sum + s.progressTotal, 0);
        lines.push([`Sites ${sites.length} (${Math.floor((100 * done) / needed)}%)`]);
    }
    return lines;
}

function infoLines(room: Room): Line[] {
    const lines: Line[] = [];
    const strength = hasEnemies(room) ? enemyStrength(room) : 0;
    lines.push([`Enemies ${STRENGTH_NAMES[strength]}`, strength > 0 ? WARN_COLOR : undefined]);

    const safeMode = room.controller?.safeMode;
    if (safeMode) lines.push([`Safe mode ${safeMode} t`, WARN_COLOR]);

    const towers = room.find(FIND_MY_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_TOWER
    }) as StructureTower[];
    if (towers.length > 0) {
        const energy = towers.reduce((sum, t) => sum + t.store.getUsedCapacity(RESOURCE_ENERGY), 0);
        lines.push([`Towers ${towers.length}: ${energy}/${towers.length * TOWER_CAPACITY}`]);
    }

    const plan = room.memory.plan;
    if (plan) lines.push([`Plan ${plan.k ?? "?"}  score ${plan.s?.toFixed(2) ?? "-"}${plan.done ? "" : " (searching)"}`]);

    const expansion = Memory.expand?.current;
    if (expansion?.spawnRoom === room.name) {
        lines.push([`Expanding ${expansion.roomName}${expansion.claimed ? " (claimed)" : ""}`, TITLE_COLOR]);
    }
    const attack = Memory.military?.attack;
    if (attack) lines.push([`Attacking ${attack}`, WARN_COLOR]);
    return lines;
}

/** Draws the panel of an owned room */
export function drawPanel(visual: RoomVisual, room: Room): void {
    const lines = [...economyLines(room), ["", undefined] as Line, ...infoLines(room)];
    visual.rect(0.2, 0.2, PANEL_WIDTH, lines.length * LINE_HEIGHT + 0.4, {
        fill: "#000000",
        opacity: 0.55,
        stroke: "#555555",
        strokeWidth: 0.05
    });
    lines.forEach(([text, color], i) => {
        if (!text) return;
        visual.text(text, 0.6, 0.2 + (i + 1) * LINE_HEIGHT, {
            align: "left",
            font: FONT,
            color: color ?? TEXT_COLOR
        });
    });
}
