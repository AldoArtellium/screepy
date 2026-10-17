/**
 * ScoutManager - Exploration and room scouting
 *
 * Features:
 * - Spawn scout creeps for exploration
 * - Systematic room scouting
 * - Integration with IntelManager
 * - Scout routing optimization
 */

import { intelManager } from "./IntelManager";
import { log } from "../utils/logger";
import { trafficManager } from "./TrafficManager";
import { spawnManager } from "./SpawnManager";
import { registerRole } from "../roles/registry";

const SCOUT_ROLE = "scout";

/** Economy scale (higher = sooner): after everything else */
const SCOUT_SPAWN_PRIORITY = 1;

/** Scout configuration */
const SCOUT_CONFIG = {
    /** Maximum scouts per owned room */
    MAX_SCOUTS_PER_ROOM: 1,
    /** Distance to scout from each owned room */
    SCOUT_RANGE: 3,
    /** Minimum RCL to start scouting (remote mining starts at RCL 1, like Hivemind) */
    MIN_RCL: 1,
    /** Ticks between scout spawns */
    SPAWN_COOLDOWN: 500
};

class ScoutManager {
    /**
     * Main scout management function
     */
    manage(): void {
        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];
            if (!room.controller?.my) continue;

            if (room.controller.level < SCOUT_CONFIG.MIN_RCL) continue;

            this.manageRoomScouts(room);
        }

    }

    /**
     * Manage scouts for a specific room: request one through SpawnManager when needed
     */
    private manageRoomScouts(room: Room): void {
        const scouts = _.filter(Game.creeps, c => c.memory.role === SCOUT_ROLE && c.memory.room === room.name);
        if (scouts.length > 0) {
            // Cooldown counts from the last tick a scout was alive
            room.memory.lastScoutSpawn = Game.time;
            if (scouts.length >= SCOUT_CONFIG.MAX_SCOUTS_PER_ROOM) return;
        }

        const lastSpawn = room.memory.lastScoutSpawn ?? 0;
        if (Game.time - lastSpawn < SCOUT_CONFIG.SPAWN_COOLDOWN) return;

        const roomsToScout = intelManager.getRoomsNeedingScouting(room.name, SCOUT_CONFIG.SCOUT_RANGE);
        if (roomsToScout.length === 0) return;

        spawnManager.requestSpawn({
            id: `scout-${room.name}`,
            roomName: room.name,
            body: [MOVE],
            // Hivemind: priority 4 / weight 1 in the early game (one room, no storage), else 1
            priority: room.storage ? SCOUT_SPAWN_PRIORITY : 4,
            weight: room.storage ? 0 : 1,
            memory: { role: SCOUT_ROLE, room: room.name }
        });
    }

    /**
     * Run individual scout behavior
     */
    runScout(scout: Creep): void {
        // Get or assign target room
        if (!scout.memory.scoutTarget) {
            const homeRoom = scout.memory.room ?? scout.room.name;
            const roomsToScout = intelManager.getRoomsNeedingScouting(homeRoom, SCOUT_CONFIG.SCOUT_RANGE);

            if (roomsToScout.length === 0) {
                // No rooms to scout - idle near spawn
                this.idleScout(scout);
                return;
            }

            // Assign closest unvisited room
            const sorted = roomsToScout.sort((a, b) => {
                const distA = intelManager.getRoomDistance(scout.room.name, a);
                const distB = intelManager.getRoomDistance(scout.room.name, b);
                return distA - distB;
            });

            scout.memory.scoutTarget = sorted[0];
            log.debug("ScoutManager", `Scout ${scout.name} assigned to ${scout.memory.scoutTarget}`);
        }

        const targetRoom = scout.memory.scoutTarget;

        // If in target room, we're done scouting it
        if (scout.room.name === targetRoom) {
            // Intel is recorded automatically by IntelManager
            log.debug("ScoutManager", `Scout ${scout.name} completed scouting ${targetRoom}`);
            delete scout.memory.scoutTarget;
            return;
        }

        // Move towards target room
        if (Game.map.findRoute(scout.room.name, targetRoom) === ERR_NO_PATH) {
            log.warn("ScoutManager", `Scout ${scout.name} cannot path to ${targetRoom}`);
            delete scout.memory.scoutTarget;
            return;
        }
        trafficManager.moveToRoom(scout, targetRoom, { priority: 80 });
    }

    /**
     * Idle behavior for scouts with no target
     */
    private idleScout(scout: Creep): void {
        const homeRoom = scout.memory.room;
        if (!homeRoom) return;

        // Return to home room if not there
        if (scout.room.name !== homeRoom) {
            trafficManager.moveToRoom(scout, homeRoom, { priority: 80 });
            return;
        }

        // In home room - move near spawn
        const spawn = scout.room.find(FIND_MY_SPAWNS)[0];
        if (spawn) {
            trafficManager.requestMove(scout, spawn, { range: 5, priority: 100 });
        }
    }
}

// Extend CreepMemory for scout-specific fields
declare global {
    interface CreepMemory {
        /** Room the scout is heading to */
        scoutTarget?: string;
    }

    interface RoomMemory {
        lastScoutSpawn?: number;
    }
}

// Singleton instance
const scoutManagerInstance = new ScoutManager();

export const scoutManagerModule = () => {
    scoutManagerInstance.manage();
};

export const scoutManager = scoutManagerInstance;

registerRole(SCOUT_ROLE, creep => scoutManagerInstance.runScout(creep));
