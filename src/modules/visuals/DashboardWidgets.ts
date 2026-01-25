/**
 * DashboardWidgets - Reusable widget factory functions for the dashboard
 *
 * Uses screeps-viz components: Bar, Dial, LineChart, Table
 */

import { Dial, Table } from "screeps-viz";

/** Phase names for display */
const PHASE_NAMES = [
    "EMERGENCY",
    "BOOTSTRAP",
    "FOUNDATION",
    "EXPANSION",
    "ESTABLISHED",
    "ADVANCED",
    "DOMINANT"
];

/**
 * Create a phase display (as table for cleaner text)
 */
export function createPhaseBar(phase: number) {
    const phaseName = PHASE_NAMES[phase] ?? "UNKNOWN";

    return Table({
        data: [
            ["Phase", `${phase}: ${phaseName}`]
        ],
        config: {
            label: "Room Phase"
        }
    });
}

/**
 * Create an RCL progress display
 */
export function createRCLBar(room: Room) {
    const controller = room.controller;
    if (!controller) {
        return Table({
            data: [["RCL", "N/A"]],
            config: { label: "Controller" }
        });
    }

    const level = controller.level;
    const progress = controller.progress ?? 0;
    const total = controller.progressTotal ?? 1;
    const percent = Math.floor((progress / total) * 100);
    const kProgress = Math.floor(progress / 1000);
    const kTotal = Math.floor(total / 1000);

    return Table({
        data: [
            ["Level", level.toString()],
            ["Progress", `${kProgress}k/${kTotal}k (${percent}%)`]
        ],
        config: {
            label: "Controller"
        }
    });
}

/**
 * Create spawn energy display
 */
export function createEnergyBar(room: Room) {
    const available = room.energyAvailable;
    const capacity = room.energyCapacityAvailable || 1;
    const percent = Math.floor((available / capacity) * 100);

    return Table({
        data: [
            ["Energy", `${available}/${capacity}`],
            ["Fill", `${percent}%`]
        ],
        config: {
            label: "Spawn Energy"
        }
    });
}

/**
 * Create storage level display
 */
export function createStorageBar(room: Room) {
    const storage = room.storage;
    if (!storage) {
        return Table({
            data: [["Storage", "None"]],
            config: { label: "Storage" }
        });
    }

    const energy = storage.store.getUsedCapacity(RESOURCE_ENERGY);
    const kEnergy = Math.floor(energy / 1000);
    const total = storage.store.getUsedCapacity();
    const capacity = storage.store.getCapacity();
    const percent = Math.floor((total / capacity) * 100);

    return Table({
        data: [
            ["Energy", `${kEnergy}k`],
            ["Used", `${percent}%`]
        ],
        config: {
            label: "Storage"
        }
    });
}

/**
 * Create part demand table
 */
export function createPartDemandBars(room: Room) {
    const partDemand = room.memory.partDemand ?? {};

    // Count current parts by type
    const currentParts: Record<string, number> = {};
    for (const creep of Object.values(Game.creeps)) {
        if (creep.room.name !== room.name) continue;
        for (const part of creep.body) {
            currentParts[part.type] = (currentParts[part.type] || 0) + 1;
        }
    }

    // Build table rows for parts with demand
    const rows: string[][] = [];

    const partTypes: BodyPartConstant[] = [WORK, CARRY, MOVE, ATTACK, RANGED_ATTACK, HEAL, CLAIM];

    for (const part of partTypes) {
        const demand = (partDemand as Record<string, number>)[part] ?? 0;
        const current = currentParts[part] ?? 0;

        if (demand > 0 || current > 0) {
            const status = demand > 0 ? `-${demand}` : "OK";
            rows.push([
                part.substring(0, 4).toUpperCase(),
                current.toString(),
                status
            ]);
        }
    }

    if (rows.length === 0) {
        rows.push(["No demand", "", ""]);
    }

    return Table({
        data: rows,
        config: {
            headers: ["Part", "Have", "Need"],
            label: "Parts"
        }
    });
}

/**
 * Convert our TimeseriesData to screeps-viz format
 */
function convertToVizTimeseries(data: TimeseriesData | undefined): [number, number][] {
    if (!data || data.values.length === 0) return [];

    // screeps-viz expects [tick, value] tuples
    const result: [number, number][] = [];
    for (let i = 0; i < data.values.length; i++) {
        result.push([data.timestamps[i], data.values[i]]);
    }
    return result;
}

/**
 * Create CPU time series chart
 */
export function createCpuChart(timeseries: TimeseriesData | undefined) {
    const vizData = convertToVizTimeseries(timeseries);

    if (vizData.length < 2) {
        return Table({
            data: [
                ["Status", "Collecting..."],
                ["Points", "0"]
            ],
            config: { label: "CPU Usage" }
        });
    }

    // Show as table with recent values instead of chart to avoid overlap
    const lastValue = vizData[vizData.length - 1][1].toFixed(1);
    const avgValue = (vizData.reduce((s, v) => s + v[1], 0) / vizData.length).toFixed(1);
    const maxValue = Math.max(...vizData.map(v => v[1])).toFixed(1);
    const cpuLimit = Game.cpu.limit ?? 20;

    return Table({
        data: [
            ["Current", lastValue],
            ["Average", avgValue],
            ["Max", maxValue],
            ["Limit", cpuLimit.toString()]
        ],
        config: { label: "CPU Usage" }
    });
}

/**
 * Create energy income display
 */
export function createEnergyIncomeChart(timeseries: TimeseriesData | undefined) {
    const vizData = convertToVizTimeseries(timeseries);

    if (vizData.length < 2) {
        return Table({
            data: [
                ["Status", "Collecting..."],
                ["Points", "0"]
            ],
            config: { label: "Energy Income" }
        });
    }

    // Show as table with statistics
    const lastValue = Math.floor(vizData[vizData.length - 1][1]);
    const avgValue = Math.floor(vizData.reduce((s, v) => s + v[1], 0) / vizData.length);
    const totalValue = Math.floor(vizData.reduce((s, v) => s + v[1], 0));

    return Table({
        data: [
            ["Last Tick", lastValue.toString()],
            ["Avg/Tick", avgValue.toString()],
            ["Total", totalValue.toString()],
            ["Samples", vizData.length.toString()]
        ],
        config: { label: "Energy Income" }
    });
}

/**
 * Create alerts panel
 */
export function createAlertsPanel(alerts: AlertInfo[]) {
    if (alerts.length === 0) {
        return Table({
            data: [["All systems normal"]],
            config: {
                label: "Alerts"
            }
        });
    }

    const rows = alerts.slice(0, 6).map(alert => {
        const prefix = alert.level === "critical" ? "!!" :
                       alert.level === "warning" ? " !" : " *";
        const roomStr = alert.room ? `[${alert.room.substring(0, 3)}]` : "";
        return [`${prefix} ${roomStr}${alert.message}`];
    });

    return Table({
        data: rows,
        config: {
            label: "Alerts"
        }
    });
}

/**
 * Create task breakdown table
 */
export function createTaskBreakdown(room: Room) {
    const taskQueue = room.memory.taskQueue ?? [];

    // Count by category
    const categories: Record<string, number> = {};
    for (const task of taskQueue) {
        const cat = task.category ?? "other";
        categories[cat] = (categories[cat] || 0) + 1;
    }

    const rows = Object.entries(categories).map(([cat, count]) => [
        cat.substring(0, 8).toUpperCase(),
        count.toString()
    ]);

    if (rows.length === 0) {
        rows.push(["No tasks", ""]);
    }

    return Table({
        data: rows,
        config: {
            headers: ["Category", "Count"],
            label: "Tasks"
        }
    });
}

/**
 * Create operations summary table
 */
export function createOperationsTable(
    remotes: RemoteSummary[],
    combatOps: CombatOpSummary[],
    highwayOps: HighwayOpSummary[],
    detailed: boolean = false
) {
    const rows: string[][] = [];

    // Remotes section
    if (remotes.length > 0) {
        rows.push(["-- REMOTES --", ""]);
        for (const remote of remotes.slice(0, detailed ? 10 : 3)) {
            const status = remote.threat ? "THREAT" : "OK";
            rows.push([
                remote.roomName,
                `${remote.miners}M ${remote.haulers}H ${status}`
            ]);
        }
        if (!detailed && remotes.length > 3) {
            rows.push([`+${remotes.length - 3} more`, ""]);
        }
    }

    // Combat ops section
    if (combatOps.length > 0) {
        rows.push(["-- COMBAT --", ""]);
        for (const op of combatOps.slice(0, detailed ? 5 : 2)) {
            rows.push([
                `${op.type} ${op.target}`,
                `${op.status} (${op.creepCount})`
            ]);
        }
    }

    // Highway ops section
    if (highwayOps.length > 0) {
        rows.push(["-- HIGHWAY --", ""]);
        for (const op of highwayOps.slice(0, detailed ? 5 : 2)) {
            const valueStr = op.type === "power" ? `${op.value}P` : op.value.toString();
            rows.push([
                `${op.type} ${op.room}`,
                `${op.status} ${valueStr}`
            ]);
        }
    }

    if (rows.length === 0) {
        rows.push(["No operations", ""]);
    }

    return Table({
        data: rows,
        config: {
            label: "Operations",
            headers: ["Op", "Status"]
        }
    });
}

/**
 * Create spawn queue table
 */
export function createSpawnQueueTable(
    spawnQueue: { bodyType: string; priority: number; roomName: string; bodyCost: number }[]
) {
    const rows = spawnQueue.slice(0, 6).map(entry => [
        entry.bodyType.substring(0, 8),
        entry.priority.toString(),
        entry.roomName,
        entry.bodyCost.toString()
    ]);

    if (rows.length === 0) {
        rows.push(["Queue empty", "", "", ""]);
    }

    return Table({
        data: rows,
        config: {
            headers: ["Type", "Pri", "Room", "Cost"],
            label: "Spawn Queue"
        }
    });
}

/**
 * Create creep summary table
 */
export function createCreepSummary(room: Room) {
    const creepsByType: Record<string, number> = {};

    for (const creep of Object.values(Game.creeps)) {
        if (creep.room.name !== room.name) continue;
        const bodyType = creep.memory.bodyType ?? "unknown";
        creepsByType[bodyType] = (creepsByType[bodyType] || 0) + 1;
    }

    const rows = Object.entries(creepsByType).map(([type, count]) => [
        type.substring(0, 10),
        count.toString()
    ]);

    if (rows.length === 0) {
        rows.push(["No creeps", ""]);
    }

    return Table({
        data: rows,
        config: {
            headers: ["Type", "#"],
            label: "Creeps"
        }
    });
}

/**
 * Create bucket dial widget
 */
export function createBucketDial() {
    const bucket = Game.cpu.bucket;

    // Color based on level
    let color = "#00ff00";
    if (bucket < 5000) color = "#ffaa00";
    if (bucket < 2000) color = "#ff8800";
    if (bucket < 500) color = "#ff0000";

    return Dial({
        data: { value: bucket },
        config: {
            label: "Bucket",
            textStyle: { color: "white" },
            foregroundStyle: { fill: color }
        }
    });
}

/**
 * Create GCL progress display
 */
export function createGCLBar() {
    const progress = Game.gcl.progress;
    const total = Game.gcl.progressTotal;
    const level = Game.gcl.level;
    const percent = Math.floor((progress / total) * 100);

    return Table({
        data: [
            ["GCL", level.toString()],
            ["Progress", `${percent}%`]
        ],
        config: {
            label: "Global Control"
        }
    });
}

/**
 * Create empire overview stats
 */
export function createEmpireStats() {
    const ownedRooms = Object.values(Game.rooms).filter(r => r.controller?.my).length;
    const creepCount = Object.keys(Game.creeps).length;
    const credits = Game.market.credits;
    const creditsStr = credits >= 1000000 ? `${(credits / 1000000).toFixed(1)}M` :
                       credits >= 1000 ? `${Math.floor(credits / 1000)}k` :
                       credits.toString();

    return Table({
        data: [
            ["Rooms", ownedRooms.toString()],
            ["Creeps", creepCount.toString()],
            ["Credits", creditsStr],
            ["GPL", (Game.gpl?.level ?? 0).toString()]
        ],
        config: {
            label: "Empire"
        }
    });
}
