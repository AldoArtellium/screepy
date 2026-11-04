/**
 * IntelManager - static intel of every room we have seen: sources, controller, mineral,
 * owner/reserver, source keepers. Kept in RawMemory segments 1-2 (utils/segments.ts, heap copy;
 * was `Memory.intel`, migrated on load). Hostiles and invader cores live in RoomIntel
 * (`Memory.rooms[r].enemies`, refreshed every tick), never here.
 */

import { cpuPressure } from "../remote/remoteIncome";
import { log } from "../utils/logger";
import { roomsInRange } from "../utils/rooms";
import { ownershipRescoutAge } from "../utils/scouting";
import { segmentStore } from "../utils/segments";

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

type IntelData = { [roomName: string]: RoomIntel };

/** Written at most every 100 ticks: a global reset loses at most that much of refreshed intel */
const store = segmentStore<IntelData>("intel", [1, 2], 100, {
    read: () => Memory.intel,
    clear: () => delete Memory.intel
});

class IntelManager {
    getIntel(roomName: string): RoomIntel | undefined {
        return store.get()[roomName];
    }

    /** Every room with intel (read only) */
    allIntel(): Readonly<IntelData> {
        return store.get();
    }

    /** Number of sources (0 for an unknown room or an entry older than the source list) */
    sourceCount(roomName: string): number {
        return this.getIntel(roomName)?.sources?.length ?? 0;
    }

    /** Record intel for a visible room (owned rooms too: their owner and mineral count) */
    recordRoomIntel(room: Room): void {
        const intel = store.get();
        const previous = intel[room.name];
        if (previous?.sources && Game.time - previous.lastScouted < INTEL_REFRESH) return;

        const sources = room.find(FIND_SOURCES);
        const controller = room.controller;
        const mineral = room.find(FIND_MINERALS)[0];
        const terrain = room.getTerrain();
        const hasSourceKeepers = sources.some(s =>
            s.pos.findInRange(FIND_HOSTILE_STRUCTURES, 5, { filter: st => st.structureType === STRUCTURE_KEEPER_LAIR })
                .length > 0
        );

        store.touch();
        intel[room.name] = {
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
        const all = store.get();
        let cleaned = 0;
        for (const roomName in all) {
            const intel = all[roomName] as RoomIntel & Record<string, unknown>;
            if (Game.time - intel.lastScouted > INTEL_EXPIRY.STRUCTURE * 2) {
                delete all[roomName];
                cleaned++;
                continue;
            }
            for (const field of LEGACY_FIELDS) delete intel[field];
        }
        store.touch();
        if (cleaned > 0) log.debug("IntelManager", `Cleaned up ${cleaned} stale intel entries`);
    }

    /**
     * Rooms within range that need a scout: never seen, without a source list (old entries), older
     * than STRUCTURE, or with a controller whose owner/reservation is older than OWNERSHIP (x3 under
     * CPU pressure, utils/scouting.ts)
     */
    getRoomsNeedingScouting(baseRoomName: string, maxDistance: number): string[] {
        const ownershipAge = ownershipRescoutAge(INTEL_EXPIRY.OWNERSHIP, cpuPressure());
        return roomsInRange(baseRoomName, maxDistance).filter(roomName => {
            const intel = this.getIntel(roomName);
            if (!intel?.sources) return true;
            const age = Game.time - intel.lastScouted;
            return age >= INTEL_EXPIRY.STRUCTURE || (!!intel.controllerPos && age >= ownershipAge);
        });
    }
}

declare global {
    interface Memory {
        /** Legacy: intel now lives in segments, this copy is migrated then deleted */
        intel?: { [roomName: string]: RoomIntel };
        username?: string;
    }
}

const intelManagerInstance = new IntelManager();
let lastIntelCleanup = 0;

export const intelManagerModule = () => {
    // Store our username for reservation checks
    if (!Memory.username) {
        const spawn = Object.values(Game.spawns)[0];
        if (spawn) Memory.username = spawn.owner.username;
    }

    // Elapsed time, not Game.time % 1000: the module is bucket-throttled and could miss the multiple
    if (Game.time - lastIntelCleanup >= 1000) {
        lastIntelCleanup = Game.time;
        intelManagerInstance.cleanupIntel();
    }

    for (const roomName in Game.rooms) intelManagerInstance.recordRoomIntel(Game.rooms[roomName]);
};

export const intelManager = intelManagerInstance;
