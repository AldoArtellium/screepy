/**
 * Dashboard - Unified Visual Module
 *
 * Displays actionable, visual-heavy dashboard using screeps-viz widgets
 * with time-series tracking for CPU and energy income.
 *
 * Layout:
 * +--------------------------------------------------+
 * | TOP ROW: Empire Status (GCL, Credits, Bucket)    |
 * +--------------------------------------------------+
 * | LEFT          | CENTER         | RIGHT           |
 * | Room Status   | CPU Chart      | Alerts          |
 * | Economy       | Energy Chart   | Panel           |
 * | Operations    | Task Breakdown |                 |
 * | Spawn Queue   |                |                 |
 * +--------------------------------------------------+
 */

import { Dashboard, Rectangle } from "screeps-viz";
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
    createEnergyIncomeChart,
    createAlertsPanel,
    createTaskBreakdown,
    createOperationsTable,
    createSpawnQueueTable,
    createCreepSummary,
    createBucketDial,
    createGCLBar,
    createEmpireStats
} from "./DashboardWidgets";
import { remoteMiningManager } from "../RemoteMiningManager";
import { combatManager } from "../CombatManager";
import { highwayManager } from "../HighwayManager";

/** Cache for widget rendering (reduces CPU) */
interface WidgetCache {
    tick: number;
    cpuChart: any;
    energyChart: any;
}

const widgetCaches: Map<string, WidgetCache> = new Map();
const CACHE_DURATION = 5; // Refresh charts every 5 ticks

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
    if (!cache || Game.time - cache.tick >= CACHE_DURATION) {
        cache = {
            tick: Game.time,
            cpuChart: createCpuChart(metricsCollector.getCpuTimeseries()),
            energyChart: createEnergyIncomeChart(metricsCollector.getEnergyIncomeTimeseries(roomName))
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

    // Build dashboard widgets with proper padding
    // Layout: 1 unit gap between widgets, columns at x=1, x=15, x=33
    Dashboard({
        config: { room: roomName },
        widgets: [
            // ===== TOP ROW: Empire Status (y=1-4) =====
            // GCL Progress Bar
            {
                pos: { x: 1, y: 1 },
                width: 11,
                height: 3,
                widget: Rectangle({
                    data: createGCLBar()
                })
            },
            // Empire Stats
            {
                pos: { x: 13, y: 1 },
                width: 10,
                height: 4,
                widget: Rectangle({
                    data: createEmpireStats()
                })
            },
            // Bucket Dial
            {
                pos: { x: 44, y: 1 },
                width: 5,
                height: 4,
                widget: createBucketDial()
            },

            // ===== LEFT COLUMN: Room Status (x=1-12) =====
            // Phase Bar
            {
                pos: { x: 1, y: 6 },
                width: 11,
                height: 3,
                widget: Rectangle({
                    data: createPhaseBar(phase)
                })
            },
            // RCL Progress
            {
                pos: { x: 1, y: 10 },
                width: 11,
                height: 3,
                widget: Rectangle({
                    data: createRCLBar(room)
                })
            },
            // Spawn Energy Bar
            {
                pos: { x: 1, y: 14 },
                width: 11,
                height: 3,
                widget: Rectangle({
                    data: createEnergyBar(room)
                })
            },
            // Storage Bar
            {
                pos: { x: 1, y: 18 },
                width: 11,
                height: 3,
                widget: Rectangle({
                    data: createStorageBar(room)
                })
            },
            // Part Demand Table
            {
                pos: { x: 1, y: 22 },
                width: 11,
                height: 7,
                widget: Rectangle({
                    data: createPartDemandBars(room)
                })
            },

            // ===== CENTER COLUMN: Charts & Stats (x=14-30) =====
            // CPU Chart
            {
                pos: { x: 14, y: 6 },
                width: 17,
                height: 7,
                widget: Rectangle({
                    data: cache.cpuChart
                })
            },
            // Energy Income Chart
            {
                pos: { x: 14, y: 14 },
                width: 17,
                height: 7,
                widget: Rectangle({
                    data: cache.energyChart
                })
            },
            // Creep Summary & Task Breakdown
            {
                pos: { x: 14, y: 22 },
                width: 8,
                height: 7,
                widget: Rectangle({
                    data: createCreepSummary(room)
                })
            },
            {
                pos: { x: 23, y: 22 },
                width: 8,
                height: 7,
                widget: Rectangle({
                    data: createTaskBreakdown(room)
                })
            },

            // ===== RIGHT COLUMN: Alerts & Operations (x=33-49) =====
            // Alerts Panel
            {
                pos: { x: 33, y: 6 },
                width: 16,
                height: 7,
                widget: Rectangle({
                    data: createAlertsPanel(alerts)
                })
            },
            // Operations Table
            {
                pos: { x: 33, y: 14 },
                width: 16,
                height: 7,
                widget: Rectangle({
                    data: createOperationsTable(remotes, combatOps, highwayOps, debugMode)
                })
            },
            // Spawn Queue
            {
                pos: { x: 33, y: 22 },
                width: 16,
                height: 7,
                widget: Rectangle({
                    data: createSpawnQueueTable(spawnQueue)
                })
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
