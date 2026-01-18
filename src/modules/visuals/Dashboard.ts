/**
 * Dashboard - Unified Visual Module
 * Displays CPU metrics, task queue summary, and creep task assignments.
 */

import { Dashboard, Dial, Rectangle, Table } from "screeps-viz";
import { TaskStatus, TaskType } from "../../types/TaskTypes";
import { getSpawnQueueSnapshot } from "../SpawnManager";
import { TaskManager } from "../TaskManager";

/**
 * Abbreviate task type names for compact display
 */
function abbreviateTaskType(type: TaskType): string {
    switch (type) {
        case TaskType.FILL_SPAWN: return "FILL_SP";
        case TaskType.FILL_EXTENSION: return "FILL_EXT";
        case TaskType.FILL_TOWER: return "FILL_TWR";
        case TaskType.FILL_STORAGE: return "FILL_STG";
        case TaskType.PICKUP_RESOURCE: return "PICKUP";
        case TaskType.WITHDRAW_CONTAINER: return "WITH_CNT";
        case TaskType.WITHDRAW_STORAGE: return "WITH_STG";
        case TaskType.BUILD_STRUCTURE: return "BUILD";
        case TaskType.REPAIR_STRUCTURE: return "REPAIR";
        case TaskType.REPAIR_WALL: return "REP_WALL";
        case TaskType.REPAIR_RAMPART: return "REP_RAMP";
        case TaskType.UPGRADE_CONTROLLER: return "UPGRADE";
        case TaskType.HARVEST_SOURCE: return "HARVEST";
        case TaskType.ATTACK_HOSTILE: return "ATTACK";
        default: return "UNKNOWN";
    }
}

/**
 * Abbreviate task status for compact display
 */
function abbreviateStatus(status: TaskStatus): string {
    switch (status) {
        case TaskStatus.PENDING: return "PEND";
        case TaskStatus.ASSIGNED: return "ASGN";
        case TaskStatus.IN_PROGRESS: return "PROG";
        case TaskStatus.COMPLETED: return "DONE";
        case TaskStatus.FAILED: return "FAIL";
        default: return "?";
    }
}

/**
 * Abbreviate creep task state for compact display
 */
function abbreviateTaskState(state: string | undefined): string {
    switch (state) {
        case "acquiring": return "acq";
        case "executing": return "exec";
        case "returning": return "ret";
        default: return "-";
    }
}

/**
 * Render the unified dashboard for a room
 */
function renderDashboard(room: Room): void {
    const bucket = Game.cpu.bucket;

    // Get task counts for summary
    const taskCounts = TaskManager.getTaskCounts(room);

    // Get task queue for detailed display
    const queue = room.memory.taskQueue;
    const tasks = queue?.tasks ?? {};

    // Get top 10 tasks sorted by priority
    const sortedTasks = Object.values(tasks)
        .filter(t => t.status !== TaskStatus.COMPLETED && t.status !== TaskStatus.FAILED)
        .sort((a, b) => a.priority - b.priority)
        .slice(0, 10);

    // Build task queue table data
    const taskQueueData = sortedTasks.map(task => [
        abbreviateTaskType(task.type),
        task.priority.toString(),
        abbreviateStatus(task.status),
        task.assignedTo?.substring(0, 8) ?? "-",
        (Game.time - task.createdAt).toString()
    ]);

    // Build task summary table data
    const taskSummaryData = [
        ["Pending", taskCounts.pending.toString()],
        ["Assigned", taskCounts.assigned.toString()],
        ["In Progress", taskCounts.inProgress.toString()],
        ["Total", taskCounts.total.toString()]
    ];

    // Build spawn queue table data
    const spawnQueueSnapshot = getSpawnQueueSnapshot();
    const spawnQueueData = spawnQueueSnapshot.slice(0, 8).map(entry => [
        entry.role.substring(0, 8),
        entry.priority.toString(),
        entry.roomName,
        entry.bodyCost.toString()
    ]);

    // Build creep assignments table data
    const creepAssignments: string[][] = [];
    for (const creep of Object.values(Game.creeps)) {
        if (creep.room.name !== room.name) continue;

        const creepMem = creep.memory;
        if (creepMem.task) {
            const task = tasks[creepMem.task.id];
            const taskType = task ? abbreviateTaskType(task.type) : "INVALID";
            const duration = Game.time - creepMem.task.startedAt;

            creepAssignments.push([
                creep.name.substring(0, 8),
                creepMem.role ?? "-",
                taskType,
                abbreviateTaskState(creepMem.task.state),
                duration.toString()
            ]);
        }
    }

    // Render the dashboard - tables on left, bucket dial top-right
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
            // Task Summary Table
            {
                pos: { x: 1, y: 1 },
                width: 10,
                height: 5,
                widget: Rectangle({
                    data: Table({
                        data: taskSummaryData,
                        config: {
                            headers: ["Status", "Count"],
                            label: "Tasks"
                        }
                    })
                })
            },
            // Task Queue Table
            {
                pos: { x: 1, y: 6 },
                width: 22,
                height: 7,
                widget: Rectangle({
                    data: Table({
                        data: taskQueueData,
                        config: {
                            headers: ["Type", "Pri", "St", "Creep", "Age"],
                            label: "Task Queue"
                        }
                    })
                })
            },
            // Spawn Queue Table
            {
                pos: { x: 1, y: 13 },
                width: 18,
                height: 6,
                widget: Rectangle({
                    data: Table({
                        data: spawnQueueData,
                        config: {
                            headers: ["Role", "Pri", "Room", "Cost"],
                            label: "Spawn Queue"
                        }
                    })
                })
            },
            // Creep Assignments Table
            {
                pos: { x: 1, y: 19 },
                width: 22,
                height: 6,
                widget: Rectangle({
                    data: Table({
                        data: creepAssignments,
                        config: {
                            headers: ["Name", "Role", "Task", "St", "Dur"],
                            label: "Creep Tasks"
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
