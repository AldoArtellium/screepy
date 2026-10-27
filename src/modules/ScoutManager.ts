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
import { ScoutHome, scoutHomeOf } from "../utils/scouting";

const SCOUT_ROLE = "scout";

/** Economy scale (higher = sooner): after everything else */
const SCOUT_SPAWN_PRIORITY = 1;

/** Scout configuration */
const SCOUT_CONFIG = {
    /** Maximum scouts per owned room */
    MAX_SCOUTS_PER_ROOM: 1,
    /** Distance to scout from each owned room */
    SCOUT_RANGE: 3,
    /** From RCL 4 (expansion): candidates further away (expansion targets beyond 3 rooms score lower) */
    EXPANSION_SCOUT_RANGE: 5,
    EXPANSION_RCL: 4,
    /** Minimum RCL to start scouting (remote mining starts at RCL 1, like Hivemind) */
    MIN_RCL: 1,
    /** Ticks between scout spawns */
    SPAWN_COOLDOWN: 500
};

/** Ticks a room whose path failed is left out of the scout targets */
const UNREACHABLE_TTL = 5000;

class ScoutManager {
    /** Heap only: rooms whose path failed, until when they are skipped */
    private unreachable: Map<string, number> = new Map();
    private homesCache: ScoutHome[] = [];
    private homesTick = -1;

    private scoutRange(roomName: string): number {
        const level = Game.rooms[roomName]?.controller?.level ?? 0;
        return level >= SCOUT_CONFIG.EXPANSION_RCL ? SCOUT_CONFIG.EXPANSION_SCOUT_RANGE : SCOUT_CONFIG.SCOUT_RANGE;
    }

    /** Owned rooms that scout, with their range (heap, once per tick) */
    private homes(): ScoutHome[] {
        if (this.homesTick !== Game.time) {
            this.homesTick = Game.time;
            this.homesCache = Object.values(Game.rooms)
                .filter(r => r.controller?.my && r.controller.level >= SCOUT_CONFIG.MIN_RCL)
                .map(r => ({ name: r.name, range: this.scoutRange(r.name) }));
        }
        return this.homesCache;
    }

    /** Rooms this home scouts: those it is the closest scouting home of (utils/scouting.ts), one scout per room */
    private roomsToScout(homeRoom: string): string[] {
        const homes = this.homes();
        const distance = (a: string, b: string) => Game.map.getRoomLinearDistance(a, b);
        return intelManager
            .getRoomsNeedingScouting(homeRoom, this.scoutRange(homeRoom))
            .filter(r => (this.unreachable.get(r) ?? 0) < Game.time)
            .filter(r => homes.length <= 1 || scoutHomeOf(r, homes, distance) === homeRoom);
    }

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

        const roomsToScout = this.roomsToScout(room.name);
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
        // Scouts walk through hostile rooms: no "creep attacked" email from the game (one intent per scout)
        if (!scout.memory.scoutQuiet && scout.notifyWhenAttacked(false) === OK) {
            scout.memory.scoutQuiet = true;
        }

        // Get or assign target room
        if (!scout.memory.scoutTarget) {
            const homeRoom = scout.memory.room ?? scout.room.name;
            const roomsToScout = this.roomsToScout(homeRoom);

            if (roomsToScout.length === 0) {
                // Nothing left to scout: a 50-energy scout idling for the rest of its life cost ~0.24 CPU per tick
                scout.suicide();
                return;
            }

            // Assign closest unvisited room
            const sorted = roomsToScout.sort((a, b) => {
                const distA = Game.map.getRoomLinearDistance(scout.room.name, a);
                const distB = Game.map.getRoomLinearDistance(scout.room.name, b);
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
        // No path (walled area, blocked exits): drop the target instead of searching again every tick
        if (
            Game.map.findRoute(scout.room.name, targetRoom) === ERR_NO_PATH ||
            trafficManager.moveToRoom(scout, targetRoom, { priority: 80 }) === ERR_NO_PATH
        ) {
            log.warn("ScoutManager", `Scout ${scout.name} cannot path to ${targetRoom}`);
            this.unreachable.set(targetRoom, Game.time + UNREACHABLE_TTL);
            delete scout.memory.scoutTarget;
        }
    }
}

// Extend CreepMemory for scout-specific fields
declare global {
    interface CreepMemory {
        /** Room the scout is heading to */
        scoutTarget?: string;
        /** notifyWhenAttacked(false) already applied */
        scoutQuiet?: boolean;
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
