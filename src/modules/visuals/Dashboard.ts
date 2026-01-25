/**
 * Dashboard - Unified Visual Module
 *
 * Displays actionable, visual-heavy dashboard using screeps-viz widgets
 * with time-series tracking for CPU and energy income.
 *
 * Layout (left side of room):
 * +----------------------------------+
 * | HEADER: Empire | Bucket         |
 * +----------------------------------+
 * | CPU Chart      | Room Status    |
 * | [stats row]    |                |
 * |                |                |
 * | Energy Chart   | Operations     |
 * | [stats row]    |                |
 * |                |                |
 * | Alerts         | Spawn Queue    |
 * +----------------------------------+
 */

import { Dashboard } from "screeps-viz";
import { getSpawnQueueSnapshot } from "../SpawnManager";
import { metricsCollector } from "../MetricsCollector";
import { alertSystem } from "./AlertSystem";
import {
    createPhaseBar,
    createRCLBar,
    createEnergyBar,
    createStorageBar,
    createPartDemandBars,
    createCpuChart,
    createCpuStats,
    createEnergyIncomeChart,
    createEnergyStats,
    createAlertsPanel,
    createTaskBreakdown,
    createOperationsTable,
    createSpawnQueueTable,
    createCreepSummary,
    createBucketDial,
    createEmpireStats
} from "./DashboardWidgets";
import { remoteMiningManager } from "../RemoteMiningManager";
import { combatManager } from "../CombatManager";
import { highwayManager } from "../HighwayManager";

/** Cache for widget rendering (reduces CPU) */
interface WidgetCache {
    tick: number;
    cpuChart: any;
    cpuStats: any;
    energyChart: any;
    energyStats: any;
}

const widgetCaches: Map<string, WidgetCache> = new Map();
const CACHE_DURATION = 5; // Refresh charts every 5 ticks

// Layout constants - left side of room
const X_LEFT = 0;    // Left column start
const X_RIGHT = 100;  // Right column start
const COL_WIDTH = 11;

/**
 * Render the unified dashboard for a room
 */
function renderDashboard(room: Room): void {
    // Skip if bucket is critically low (save CPU)
    if (Game.cpu.bucket < 2000) return;

    const roomName = room.name;
    const phase = room.memory.phase ?? 0;
    const debugMode = Memory.debugDashboard ?? false;

    // Get or create cache
    let cache = widgetCaches.get(roomName);
    const cpuTs = metricsCollector.getCpuTimeseries();
    const energyTs = metricsCollector.getEnergyIncomeTimeseries(roomName);

    if (!cache || Game.time - cache.tick >= CACHE_DURATION) {
        cache = {
            tick: Game.time,
            cpuChart: createCpuChart(cpuTs),
            cpuStats: createCpuStats(cpuTs),
            energyChart: createEnergyIncomeChart(energyTs),
            energyStats: createEnergyStats(energyTs)
        };
        widgetCaches.set(roomName, cache);
    }

    // Get data for operations table
    const remotes = remoteMiningManager.getRemotesSummary(debugMode);
    const combatOps = combatManager.getOperationsSummary(debugMode);
    const highwayOps = highwayManager.getHighwaySummary(debugMode);

    // Get spawn queue
    const spawnQueue = getSpawnQueueSnapshot().map(entry => ({
        bodyType: entry.bodyType,
        priority: entry.priority,
        roomName: entry.roomName,
        bodyCost: entry.bodyCost
    }));

    // Get alerts for this room (includes global alerts)
    const alerts = alertSystem.getAlertsForRoom(roomName);

    // Build dashboard - positioned on LEFT side of room
    // Two columns: LEFT (charts) and RIGHT (status/tables)
    Dashboard({
        config: { room: roomName },
        widgets: [
            // ===== ROW 1: Header (y=1) =====
            {
                pos: { x: X_LEFT, y: 1 },
                width: COL_WIDTH,
                height: 4,
                widget: createEmpireStats()
            },
            {
                pos: { x: X_RIGHT, y: 1 },
                width: COL_WIDTH,
                height: 4,
                widget: createBucketDial()
            },

            // ===== ROW 2: CPU Chart + Room Status (y=6) =====
            {
                pos: { x: X_LEFT, y: 6 },
                width: COL_WIDTH,
                height: 6,
                widget: cache.cpuChart
            },
            // CPU Stats (below chart with gap)
            {
                pos: { x: X_LEFT, y: 13 },
                width: COL_WIDTH,
                height: 2,
                widget: cache.cpuStats
            },
            // Room status column
            {
                pos: { x: X_RIGHT, y: 6 },
                width: COL_WIDTH,
                height: 3,
                widget: createPhaseBar(phase)
            },
            {
                pos: { x: X_RIGHT, y: 10 },
                width: COL_WIDTH,
                height: 3,
                widget: createRCLBar(room)
            },
            {
                pos: { x: X_RIGHT, y: 14 },
                width: COL_WIDTH,
                height: 3,
                widget: createEnergyBar(room)
            },

            // ===== ROW 3: Energy Chart + Storage/Parts (y=18) =====
            {
                pos: { x: X_LEFT, y: 16 },
                width: COL_WIDTH,
                height: 6,
                widget: cache.energyChart
            },
            // Energy Stats (below chart with gap)
            {
                pos: { x: X_LEFT, y: 23 },
                width: COL_WIDTH,
                height: 2,
                widget: cache.energyStats
            },
            {
                pos: { x: X_RIGHT, y: 18 },
                width: COL_WIDTH,
                height: 3,
                widget: createStorageBar(room)
            },
            {
                pos: { x: X_RIGHT, y: 22 },
                width: COL_WIDTH,
                height: 5,
                widget: createPartDemandBars(room)
            },

            // ===== ROW 4: Alerts + Operations (y=26) =====
            {
                pos: { x: X_LEFT, y: 26 },
                width: COL_WIDTH,
                height: 6,
                widget: createAlertsPanel(alerts)
            },
            {
                pos: { x: X_RIGHT, y: 28 },
                width: COL_WIDTH,
                height: 6,
                widget: createOperationsTable(remotes, combatOps, highwayOps, debugMode)
            },

            // ===== ROW 5: Creeps/Tasks + Spawn Queue (y=33) =====
            {
                pos: { x: X_LEFT, y: 33 },
                width: COL_WIDTH,
                height: 5,
                widget: createCreepSummary(room)
            },
            {
                pos: { x: X_RIGHT, y: 35 },
                width: COL_WIDTH,
                height: 6,
                widget: createSpawnQueueTable(spawnQueue)
            },

            // ===== ROW 6: Task Breakdown (y=39) =====
            {
                pos: { x: X_LEFT, y: 39 },
                width: COL_WIDTH,
                height: 5,
                widget: createTaskBreakdown(room)
            }
        ]
    });

    // Render defense mode indicator if active
    if (room.memory.defenseMode) {
        room.visual.text(
            "!! DEFENSE MODE !!",
            25, 0.5,
            { color: "#ff0000", font: "bold 1 Arial", align: "center" }
        );
    }
}

/**
 * Dashboard module export for game loop integration
 */
export const dashboardModule = {
    name: "Dashboard",
    fn: () => {
        // Render dashboard for each owned room
        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];
            if (!room.controller?.my) continue;
            renderDashboard(room);
        }
    },
    mandatory: false
};
