/**
 * Memory Reset Utility
 * Allows recreating/resetting memory structures with various options.
 *
 * Usage from Screeps console:
 *   MemoryReset.all()           - Full memory wipe and reinitialize
 *   MemoryReset.rooms()         - Reset all room memory
 *   MemoryReset.room("E1N1")    - Reset specific room
 *   MemoryReset.creeps()        - Reset all creep memory
 *   MemoryReset.traffic()       - Reset path cache and traffic data
 *   MemoryReset.tasks()         - Reset task queues in all rooms
 *   MemoryReset.metrics()       - Reset dashboard metrics
 *   MemoryReset.intel()         - Reset intel data
 *   MemoryReset.preview()       - Show what would be reset without doing it
 */

import { log } from "./logger";

export interface ResetOptions {
    /** Keep intel data when resetting */
    keepIntel?: boolean;
    /** Keep path cache when resetting */
    keepPathCache?: boolean;
    /** Keep metrics when resetting */
    keepMetrics?: boolean;
}

/**
 * Create default room memory structure
 */
function createDefaultRoomMemory(): RoomMemory {
    return {
        sources: {},
        constructionSites: {},
        threatLevel: 0,
        threatLevelLastTick: 0,
        phase: 0,
        defenseMode: false,
        phaseData: {
            lastEvaluation: Game.time,
            extensionsPlanned: false,
            roadsPlanned: false
        },
        taskQueue: [],
        partDemand: {}
    };
}

/**
 * Create default global memory structure
 */
function createDefaultMemory(): Memory {
    return {
        rooms: {},
        creeps: {},
        spawn: {},
        init: false
    } as Memory;
}

class MemoryResetUtil {
    /**
     * Full memory wipe - resets everything and reinitializes
     */
    all(options: ResetOptions = {}): string {
        const preserved: Partial<Memory> = {};

        // Preserve optional data
        if (options.keepIntel && Memory.rooms) {
            for (const roomName in Memory.rooms) {
                if (Memory.rooms[roomName].intel) {
                    if (!preserved.rooms) preserved.rooms = {};
                    preserved.rooms[roomName] = { intel: Memory.rooms[roomName].intel } as RoomMemory;
                }
            }
        }
        if (options.keepPathCache && Memory.pathCache) {
            preserved.pathCache = Memory.pathCache;
        }
        if (options.keepMetrics && Memory.metrics) {
            preserved.metrics = Memory.metrics;
        }

        // Wipe memory
        const newMemory = createDefaultMemory();

        // Restore preserved data
        if (preserved.pathCache) {
            newMemory.pathCache = preserved.pathCache;
        }
        if (preserved.metrics) {
            newMemory.metrics = preserved.metrics;
        }

        // Clear and reassign
        for (const key in Memory) {
            delete (Memory as any)[key];
        }
        Object.assign(Memory, newMemory);

        // Restore intel to room memory if preserved
        if (preserved.rooms) {
            for (const roomName in preserved.rooms) {
                if (!Memory.rooms[roomName]) {
                    Memory.rooms[roomName] = createDefaultRoomMemory();
                }
                Memory.rooms[roomName].intel = preserved.rooms[roomName].intel;
            }
        }

        log.info("MemoryReset", "Full memory reset complete. Init flag cleared - will reinitialize next tick.");
        return "Memory reset complete. Will reinitialize next tick.";
    }

    /**
     * Reset all room memory
     */
    rooms(): string {
        const roomCount = Object.keys(Memory.rooms || {}).length;
        Memory.rooms = {};
        Memory.init = false;

        log.info("MemoryReset", `Reset ${roomCount} room(s). Will reinitialize next tick.`);
        return `Reset ${roomCount} room(s). Will reinitialize next tick.`;
    }

    /**
     * Reset specific room memory
     */
    room(roomName: string): string {
        if (!Memory.rooms) {
            Memory.rooms = {};
        }

        const existed = !!Memory.rooms[roomName];
        Memory.rooms[roomName] = createDefaultRoomMemory();

        const msg = existed
            ? `Reset room ${roomName} memory.`
            : `Initialized new memory for room ${roomName}.`;

        log.info("MemoryReset", msg);
        return msg;
    }

    /**
     * Reset all creep memory (dead creeps will be cleaned up)
     */
    creeps(): string {
        const creepCount = Object.keys(Memory.creeps || {}).length;
        Memory.creeps = {};

        log.info("MemoryReset", `Reset ${creepCount} creep memory entries.`);
        return `Reset ${creepCount} creep memory entries.`;
    }

    /**
     * Reset traffic system (path cache and traffic data)
     */
    traffic(): string {
        const pathCount = Object.keys(Memory.pathCache || {}).length;

        delete Memory.pathCache;
        delete Memory.traffic;

        // Clear creep path data
        for (const name in Memory.creeps) {
            const creep = Memory.creeps[name];
            delete creep._path;
            delete creep._pathTick;
            delete creep._pathTarget;
        }

        log.info("MemoryReset", `Reset traffic system. Cleared ${pathCount} cached paths.`);
        return `Reset traffic system. Cleared ${pathCount} cached paths.`;
    }

    /**
     * Reset task queues in all rooms
     */
    tasks(): string {
        let taskCount = 0;

        for (const roomName in Memory.rooms) {
            const room = Memory.rooms[roomName];
            if (room.taskQueue) {
                taskCount += room.taskQueue.length;
                room.taskQueue = [];
            }
            if (room.partDemand) {
                room.partDemand = {};
            }
        }

        // Clear creep task assignments
        for (const name in Memory.creeps) {
            const creep = Memory.creeps[name];
            delete creep.currentTask;
            delete creep.state;
            delete creep.targetId;
            delete creep.targetRoom;
            delete creep.targetTick;
        }

        log.info("MemoryReset", `Reset ${taskCount} tasks across all rooms.`);
        return `Reset ${taskCount} tasks across all rooms.`;
    }

    /**
     * Reset dashboard metrics
     */
    metrics(): string {
        delete Memory.metrics;
        log.info("MemoryReset", "Reset dashboard metrics.");
        return "Reset dashboard metrics.";
    }

    /**
     * Reset intel data
     */
    intel(): string {
        let intelCount = 0;

        for (const roomName in Memory.rooms) {
            if (Memory.rooms[roomName].intel) {
                delete Memory.rooms[roomName].intel;
                intelCount++;
            }
        }

        log.info("MemoryReset", `Reset intel for ${intelCount} room(s).`);
        return `Reset intel for ${intelCount} room(s).`;
    }

    /**
     * Reset spawn queue data
     */
    spawn(): string {
        Memory.spawn = {};

        log.info("MemoryReset", "Reset spawn data.");
        return "Reset spawn data.";
    }

    /**
     * Preview what would be reset - shows current memory sizes
     */
    preview(): string {
        const stats = {
            rooms: Object.keys(Memory.rooms || {}).length,
            creeps: Object.keys(Memory.creeps || {}).length,
            pathCache: Object.keys(Memory.pathCache || {}).length,
            hasMetrics: !!Memory.metrics,
            hasTraffic: !!Memory.traffic,
            totalTasks: 0,
            roomsWithIntel: 0
        };

        for (const roomName in Memory.rooms || {}) {
            const room = Memory.rooms[roomName];
            stats.totalTasks += (room.taskQueue?.length || 0);
            if (room.intel) stats.roomsWithIntel++;
        }

        const memorySize = JSON.stringify(Memory).length;

        const report = [
            "=== Memory Preview ===",
            `Total memory size: ${(memorySize / 1024).toFixed(2)} KB`,
            `Rooms: ${stats.rooms}`,
            `Creeps: ${stats.creeps}`,
            `Cached paths: ${stats.pathCache}`,
            `Total tasks: ${stats.totalTasks}`,
            `Rooms with intel: ${stats.roomsWithIntel}`,
            `Has metrics: ${stats.hasMetrics}`,
            `Has traffic data: ${stats.hasTraffic}`,
            "",
            "Available commands:",
            "  MemoryReset.all()        - Full reset",
            "  MemoryReset.rooms()      - Reset room memory",
            "  MemoryReset.room(name)   - Reset specific room",
            "  MemoryReset.creeps()     - Reset creep memory",
            "  MemoryReset.traffic()    - Reset path cache",
            "  MemoryReset.tasks()      - Reset task queues",
            "  MemoryReset.metrics()    - Reset metrics",
            "  MemoryReset.intel()      - Reset intel data",
            "  MemoryReset.spawn()      - Reset spawn data"
        ].join("\n");

        console.log(report);
        return report;
    }
}

// Singleton instance
export const MemoryReset = new MemoryResetUtil();

// Expose to global for console access
(global as any).MemoryReset = MemoryReset;
