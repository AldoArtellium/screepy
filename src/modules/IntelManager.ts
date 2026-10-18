/**
 * IntelManager - static intel of every room we have seen (`Memory.intel`): sources, controller,
 * mineral, owner/reserver, source keepers. Hostiles and invader cores live in RoomIntel
 * (`Memory.rooms[r].enemies`, refreshed every tick), never here.
 */

import { log } from "../utils/logger";
import { roomsInRange } from "../utils/rooms";

/** How long intel remains valid (ticks) */
const INTEL_EXPIRY = {
    /** Room structure data (sources, controller) */
    STRUCTURE: 50000,
    /** Owner/reservation data of a room with a controller: rescouted after that */
    OWNERSHIP: 10000
};

/** Ticks between two intel records of a visible room */
const INTEL_REFRESH = 100;

/** Fields of older intel versions, dropped from Memory */
const LEGACY_FIELDS = [
    "name", "sourceCount", "sourcePositions", "controllerLevel", "hasInvaderCore", "lastHostileSeen",
    "hostileThreat", "terrainDifficulty", "miningValue"
];

function freeTilesAround(terrain: RoomTerrain, pos: RoomPosition): number {
    let free = 0;
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            if (!dx && !dy) continue;
            const x = pos.x + dx;
            const y = pos.y + dy;
            if (x < 0 || x > 49 || y < 0 || y > 49) continue;
            if (terrain.get(x, y) !== TERRAIN_MASK_WALL) free++;
        }
    }
    return free;
}

/** Room intel data structure */
export interface RoomIntel {
    /** Last scouted tick */
    lastScouted: number;
    /** Sources with their free adjacent tiles (remote harvesters per source); missing in old entries */
    sources?: { id: Id<Source>; x: number; y: number; free: number }[];
    /** Controller position, if any */
    controllerPos?: { x: number; y: number };
    /** Free tiles around the controller (reservers per room) */
    reservePositions?: number;
    /** Controller owner username (if owned) */
    owner?: string;
    /** Controller reserver username (if reserved) */
    reserver?: string;
    /** Reservation ticks remaining when scouted */
    reservationTicks?: number;
    /** Whether room has source keepers */
    hasSourceKeepers: boolean;
    /** Mineral type (if any) */
    mineralType?: MineralConstant;
}

class IntelManager {
    getIntel(roomName: string): RoomIntel | undefined {
        return Memory.intel?.[roomName];
    }

    /** Number of sources (0 for an unknown room or an entry older than the source list) */
    sourceCount(roomName: string): number {
        return this.getIntel(roomName)?.sources?.length ?? 0;
    }

    /** Record intel for a visible room (owned rooms too: their owner and mineral count) */
    recordRoomIntel(room: Room): void {
        if (!Memory.intel) Memory.intel = {};
        const previous = Memory.intel[room.name];
        if (previous?.sources && Game.time - previous.lastScouted < INTEL_REFRESH) return;

        const sources = room.find(FIND_SOURCES);
        const controller = room.controller;
        const mineral = room.find(FIND_MINERALS)[0];
        const terrain = room.getTerrain();
        const hasSourceKeepers = sources.some(s =>
            s.pos.findInRange(FIND_HOSTILE_STRUCTURES, 5, { filter: st => st.structureType === STRUCTURE_KEEPER_LAIR })
                .length > 0
        );

        Memory.intel[room.name] = {
            lastScouted: Game.time,
            sources: sources.map(s => ({ id: s.id, x: s.pos.x, y: s.pos.y, free: freeTilesAround(terrain, s.pos) })),
            controllerPos: controller ? { x: controller.pos.x, y: controller.pos.y } : undefined,
            reservePositions: controller ? freeTilesAround(terrain, controller.pos) : undefined,
            owner: controller?.owner?.username,
            reserver: controller?.reservation?.username,
            reservationTicks: controller?.reservation?.ticksToEnd,
            hasSourceKeepers,
            mineralType: mineral?.mineralType
        };
    }

    /** Drop intel not refreshed for a long time, and fields of older versions */
    cleanupIntel(): void {
        if (!Memory.intel) return;
        let cleaned = 0;
        for (const roomName in Memory.intel) {
            const intel = Memory.intel[roomName] as RoomIntel & Record<string, unknown>;
            if (Game.time - intel.lastScouted > INTEL_EXPIRY.STRUCTURE * 2) {
                delete Memory.intel[roomName];
                cleaned++;
                continue;
            }
            for (const field of LEGACY_FIELDS) delete intel[field];
        }
        if (cleaned > 0) log.debug("IntelManager", `Cleaned up ${cleaned} stale intel entries`);
    }

    /**
     * Rooms within range that need a scout: never seen, without a source list (old entries), older
     * than STRUCTURE, or with a controller whose owner/reservation is older than OWNERSHIP
     */
    getRoomsNeedingScouting(baseRoomName: string, maxDistance: number): string[] {
        return roomsInRange(baseRoomName, maxDistance).filter(roomName => {
            const intel = this.getIntel(roomName);
            if (!intel?.sources) return true;
            const age = Game.time - intel.lastScouted;
            return age >= INTEL_EXPIRY.STRUCTURE || (!!intel.controllerPos && age >= INTEL_EXPIRY.OWNERSHIP);
        });
    }
}

declare global {
    interface Memory {
        intel?: { [roomName: string]: RoomIntel };
        username?: string;
    }
}

const intelManagerInstance = new IntelManager();

export const intelManagerModule = () => {
    // Store our username for reservation checks
    if (!Memory.username) {
        const spawn = Object.values(Game.spawns)[0];
        if (spawn) Memory.username = spawn.owner.username;
    }

    if (Game.time % 1000 === 0) intelManagerInstance.cleanupIntel();

    for (const roomName in Game.rooms) intelManagerInstance.recordRoomIntel(Game.rooms[roomName]);
};

export const intelManager = intelManagerInstance;
