/**
 * ScoutManager - Exploration and room scouting
 *
 * Features:
 * - Spawn scout creeps for exploration
 * - Systematic room scouting
 * - Integration with IntelManager
 * - Scout routing optimization
 */

import { BodyType } from "../config/bodyTypes";
import { intelManager } from "./IntelManager";
import { log } from "../utils/logger";

/** Scout configuration */
const SCOUT_CONFIG = {
    /** Maximum scouts per owned room */
    MAX_SCOUTS_PER_ROOM: 1,
    /** Distance to scout from each owned room */
    SCOUT_RANGE: 3,
    /** Minimum phase to start scouting */
    MIN_PHASE: 2,
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

            const phase = room.memory.phase ?? 0;
            if (phase < SCOUT_CONFIG.MIN_PHASE) continue;

            this.manageRoomScouts(room);
        }

        // Run existing scouts
        this.runScouts();
    }

    /**
     * Manage scouts for a specific room
     */
    private manageRoomScouts(room: Room): void {
        // Count existing scouts for this room
        const scouts = _.filter(Game.creeps, c =>
            c.memory.bodyType === BodyType.SCOUT &&
            c.memory.room === room.name
        );

        if (scouts.length >= SCOUT_CONFIG.MAX_SCOUTS_PER_ROOM) return;

        // Check spawn cooldown
        const lastSpawn = room.memory.lastScoutSpawn ?? 0;
        if (Game.time - lastSpawn < SCOUT_CONFIG.SPAWN_COOLDOWN) return;

        // Check if there are rooms to scout
        const roomsToScout = intelManager.getRoomsNeedingScouting(room.name, SCOUT_CONFIG.SCOUT_RANGE);
        if (roomsToScout.length === 0) return;

        // Request scout spawn
        this.requestScout(room);
    }

    /**
     * Request a scout spawn
     */
    private requestScout(room: Room): void {
        // This integrates with SpawnManager through the demand system
        // For scouts, we just check if we need one and set a flag

        // Store scout request in room memory
        if (!room.memory.scoutRequest) {
            room.memory.scoutRequest = {
                requested: Game.time,
                targetRooms: intelManager.getRoomsNeedingScouting(room.name, SCOUT_CONFIG.SCOUT_RANGE).slice(0, 5)
            };
            log.debug("ScoutManager", `${room.name}: Requested scout for ${room.memory.scoutRequest.targetRooms.length} rooms`);
        }
    }

    /**
     * Run all scout creeps
     */
    private runScouts(): void {
        for (const name in Game.creeps) {
            const creep = Game.creeps[name];
            if (creep.memory.bodyType !== BodyType.SCOUT) continue;
            if (creep.spawning) continue;

            this.runScout(creep);
        }
    }

    /**
     * Run individual scout behavior
     */
    private runScout(scout: Creep): void {
        // Get or assign target room
        if (!scout.memory.targetRoom) {
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

            scout.memory.targetRoom = sorted[0];
            log.debug("ScoutManager", `Scout ${scout.name} assigned to ${scout.memory.targetRoom}`);
        }

        const targetRoom = scout.memory.targetRoom;

        // If in target room, we're done scouting it
        if (scout.room.name === targetRoom) {
            // Intel is recorded automatically by IntelManager
            log.debug("ScoutManager", `Scout ${scout.name} completed scouting ${targetRoom}`);
            delete scout.memory.targetRoom;
            return;
        }

        // Move towards target room
        const exitDir = scout.room.findExitTo(targetRoom);
        if (exitDir === ERR_NO_PATH || exitDir === ERR_INVALID_ARGS) {
            log.warn("ScoutManager", `Scout ${scout.name} cannot path to ${targetRoom}`);
            delete scout.memory.targetRoom;
            return;
        }

        const exit = scout.pos.findClosestByRange(exitDir as FindConstant);
        if (exit) {
            scout.moveTo(exit, {
                reusePath: 20,
                visualizePathStyle: { stroke: "#00ffff", opacity: 0.3 }
            });
        }
    }

    /**
     * Idle behavior for scouts with no target
     */
    private idleScout(scout: Creep): void {
        const homeRoom = scout.memory.room;
        if (!homeRoom) return;

        // Return to home room if not there
        if (scout.room.name !== homeRoom) {
            const exitDir = scout.room.findExitTo(homeRoom);
            if (exitDir !== ERR_NO_PATH && exitDir !== ERR_INVALID_ARGS) {
                const exit = scout.pos.findClosestByRange(exitDir as FindConstant);
                if (exit) {
                    scout.moveTo(exit);
                }
            }
            return;
        }

        // In home room - move near spawn
        const spawn = scout.room.find(FIND_MY_SPAWNS)[0];
        if (spawn && !scout.pos.inRangeTo(spawn, 5)) {
            scout.moveTo(spawn);
        }
    }

    /**
     * Check if a room needs scouts spawned
     */
    needsScout(roomName: string): boolean {
        const room = Game.rooms[roomName];
        if (!room?.controller?.my) return false;

        const phase = room.memory.phase ?? 0;
        if (phase < SCOUT_CONFIG.MIN_PHASE) return false;

        const scouts = _.filter(Game.creeps, c =>
            c.memory.bodyType === BodyType.SCOUT &&
            c.memory.room === roomName
        );

        if (scouts.length >= SCOUT_CONFIG.MAX_SCOUTS_PER_ROOM) return false;

        const roomsToScout = intelManager.getRoomsNeedingScouting(roomName, SCOUT_CONFIG.SCOUT_RANGE);
        return roomsToScout.length > 0;
    }

    /**
     * Get scout body for spawning
     */
    getScoutBody(): BodyPartConstant[] {
        return [MOVE]; // Scouts are just single MOVE parts
    }
}

// Extend CreepMemory for scout-specific fields
declare global {
    interface CreepMemory {
        targetRoom?: string;
    }

    interface RoomMemory {
        lastScoutSpawn?: number;
        scoutRequest?: {
            requested: number;
            targetRooms: string[];
        };
    }
}

// Singleton instance
const scoutManagerInstance = new ScoutManager();

export const scoutManagerModule = () => {
    scoutManagerInstance.manage();
};

export const scoutManager = scoutManagerInstance;
