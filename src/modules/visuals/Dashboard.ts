/**
 * Dashboard - Unified Visual Module
 * Displays CPU metrics, spawn queue, part demand, and task summary.
 */

import { Dashboard, Dial, Rectangle, Table } from "screeps-viz";
import { BodyType } from "../../config/bodyTypes";
import { demandCalculator } from "../DemandCalculator";
import { getSpawnQueueSnapshot } from "../SpawnManager";
import { taskGenerator } from "../TaskGenerator";

/**
 * Render the unified dashboard for a room
 */
function renderDashboard(room: Room): void {
    const bucket = Game.cpu.bucket;
    const phase = room.memory.phase ?? 0;
    const defenseMode = room.memory.defenseMode ?? false;

    // Build spawn queue table data
    const spawnQueueSnapshot = getSpawnQueueSnapshot();
    const spawnQueueData = spawnQueueSnapshot.slice(0, 6).map(entry => [
        entry.bodyType.substring(0, 8),
        entry.priority.toString(),
        entry.roomName,
        entry.bodyCost.toString()
    ]);

    // Build creep summary by body type
    const creepsByType: { [type: string]: number } = {};
    for (const creep of Object.values(Game.creeps)) {
        if (creep.room.name !== room.name) continue;
        const bodyType = creep.memory.bodyType ?? "unknown";
        creepsByType[bodyType] = (creepsByType[bodyType] || 0) + 1;
    }

    const creepSummaryData = Object.entries(creepsByType).map(([type, count]) => [
        type,
        count.toString()
    ]);

    // Build part demand table
    const demandData = demandCalculator.getDemandSummary(room).map(line => {
        const parts = line.split(": ");
        return [parts[0], parts[1] || ""];
    });

    // Build room status data
    const roomStatusData = [
        ["Phase", phase.toString()],
        ["Defense", defenseMode ? "ACTIVE" : "off"],
        ["RCL", (room.controller?.level ?? 0).toString()],
        ["Energy", `${room.energyAvailable}/${room.energyCapacityAvailable}`]
    ];

    // Build task queue summary
    const taskQueue = room.memory.taskQueue ?? [];
    const pendingTasks = taskQueue.filter(t => t.status === "pending").length;
    const assignedTasks = taskQueue.filter(t => t.status === "assigned" || t.status === "in_progress").length;

    const taskStatusData = [
        ["Pending", pendingTasks.toString()],
        ["Active", assignedTasks.toString()],
        ["Total", taskQueue.length.toString()]
    ];

    // Render the dashboard
    Dashboard({
        config: { room: room.name },
        widgets: [
            // Bucket Dial (top-right)
            {
                pos: { x: 44, y: 1 },
                width: 5,
                height: 4,
                widget: Dial({
                    data: { value: bucket },
                    config: {
                        label: "Bucket",
                        textStyle: { color: "white" },
                        foregroundStyle: { fill: "green" }
                    }
                })
            },
            // Room Status Table
            {
                pos: { x: 1, y: 1 },
                width: 12,
                height: 5,
                widget: Rectangle({
                    data: Table({
                        data: roomStatusData,
                        config: {
                            headers: ["Status", "Value"],
                            label: "Room"
                        }
                    })
                })
            },
            // Creep Summary Table
            {
                pos: { x: 1, y: 6 },
                width: 12,
                height: 6,
                widget: Rectangle({
                    data: Table({
                        data: creepSummaryData,
                        config: {
                            headers: ["Type", "Count"],
                            label: "Creeps"
                        }
                    })
                })
            },
            // Part Demand Table
            {
                pos: { x: 1, y: 12 },
                width: 14,
                height: 6,
                widget: Rectangle({
                    data: Table({
                        data: demandData,
                        config: {
                            headers: ["Part", "Supply/Demand"],
                            label: "Part Demand"
                        }
                    })
                })
            },
            // Task Status Table
            {
                pos: { x: 15, y: 12 },
                width: 10,
                height: 5,
                widget: Rectangle({
                    data: Table({
                        data: taskStatusData,
                        config: {
                            headers: ["Status", "Count"],
                            label: "Tasks"
                        }
                    })
                })
            },
            // Spawn Queue Table
            {
                pos: { x: 1, y: 18 },
                width: 18,
                height: 6,
                widget: Rectangle({
                    data: Table({
                        data: spawnQueueData,
                        config: {
                            headers: ["Type", "Pri", "Room", "Cost"],
                            label: "Spawn Queue"
                        }
                    })
                })
            }
        ]
    });
}

/**
 * Dashboard module export for game loop integration
 */
export const dashboardModule = {
    name: "Dashboard",
    fn: () => {
        // Render dashboard for each owned room
        Object.values(Game.rooms).forEach(room => {
            if (!room.controller?.my) return;
            renderDashboard(room);
        });
    },
    mandatory: false
};
