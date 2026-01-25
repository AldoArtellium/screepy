/**
 * IntelManager - Room intelligence storage and queries
 *
 * Features:
 * - Store scouted room data (sources, controller, threats)
 * - Calculate room value for remote mining
 * - Track hostile activity
 * - Memory-efficient storage with expiration
 */

import { log } from "../utils/logger";

/** How long intel remains valid (ticks) */
const INTEL_EXPIRY = {
    /** Room structure data (sources, controller) */
    STRUCTURE: 50000,
    /** Hostile activity data */
    HOSTILE: 1500,
    /** Owner/reservation data */
    OWNERSHIP: 10000
};

/** Room intel data structure */
export interface RoomIntel {
    /** Room name */
    name: string;
    /** Last scouted tick */
    lastScouted: number;
    /** Number of sources */
    sourceCount: number;
    /** Source positions for pathfinding */
    sourcePositions: { x: number; y: number }[];
    /** Controller level (0 = no controller, -1 = reserved) */
    controllerLevel: number;
    /** Controller owner username (if owned) */
    owner?: string;
    /** Controller reserver username (if reserved) */
    reserver?: string;
    /** Reservation ticks remaining */
    reservationTicks?: number;
    /** Whether room has invader core */
    hasInvaderCore: boolean;
    /** Whether room has source keepers */
    hasSourceKeepers: boolean;
    /** Last hostile seen tick */
    lastHostileSeen?: number;
    /** Hostile threat level when last seen */
    hostileThreat?: number;
    /** Mineral type (if visible) */
    mineralType?: MineralConstant;
    /** Room terrain difficulty (% walls) */
    terrainDifficulty: number;
    /** Calculated room value for remote mining */
    miningValue: number;
}

class IntelManager {
    /**
     * Get intel for a room (from memory)
     */
    getIntel(roomName: string): RoomIntel | undefined {
        return Memory.intel?.[roomName];
    }

    /**
     * Check if intel for a room is still valid
     */
    isIntelValid(roomName: string, maxAge: number = INTEL_EXPIRY.STRUCTURE): boolean {
        const intel = this.getIntel(roomName);
        if (!intel) return false;
        return Game.time - intel.lastScouted < maxAge;
    }

    /**
     * Record intel for a visible room
     */
    recordRoomIntel(room: Room): void {
        if (!Memory.intel) {
            Memory.intel = {};
        }

        const sources = room.find(FIND_SOURCES);
        const controller = room.controller;
        const mineral = room.find(FIND_MINERALS)[0];

        // Calculate terrain difficulty
        const terrain = room.getTerrain();
        let walls = 0;
        for (let x = 0; x < 50; x++) {
            for (let y = 0; y < 50; y++) {
                if (terrain.get(x, y) === TERRAIN_MASK_WALL) {
                    walls++;
                }
            }
        }
        const terrainDifficulty = walls / 2500;

        // Check for source keepers
        const hasSourceKeepers = sources.some(s => {
            const lair = s.pos.findInRange(FIND_HOSTILE_STRUCTURES, 5, {
                filter: st => st.structureType === STRUCTURE_KEEPER_LAIR
            })[0];
            return !!lair;
        });

        // Check for invader core
        const invaderCore = room.find(FIND_HOSTILE_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_INVADER_CORE
        })[0];

        // Check hostiles
        const hostiles = room.find(FIND_HOSTILE_CREEPS);
        let hostileThreat = 0;
        let lastHostileSeen: number | undefined;

        if (hostiles.length > 0) {
            hostileThreat = this.calculateThreat(hostiles);
            lastHostileSeen = Game.time;
        }

        const intel: RoomIntel = {
            name: room.name,
            lastScouted: Game.time,
            sourceCount: sources.length,
            sourcePositions: sources.map(s => ({ x: s.pos.x, y: s.pos.y })),
            controllerLevel: controller?.level ?? 0,
            owner: controller?.owner?.username,
            reserver: controller?.reservation?.username,
            reservationTicks: controller?.reservation?.ticksToEnd,
            hasInvaderCore: !!invaderCore,
            hasSourceKeepers,
            lastHostileSeen,
            hostileThreat,
            mineralType: mineral?.mineralType,
            terrainDifficulty,
            miningValue: 0 // Calculated below
        };

        // Calculate mining value
        intel.miningValue = this.calculateMiningValue(intel);

        Memory.intel[room.name] = intel;

        log.debug("IntelManager", `Recorded intel for ${room.name}: ${sources.length} sources, value=${intel.miningValue}`);
    }

    /**
     * Calculate threat level from hostile creeps
     */
    private calculateThreat(hostiles: Creep[]): number {
        let threat = 0;
        for (const hostile of hostiles) {
            for (const part of hostile.body) {
                if (part.hits <= 0) continue;
                switch (part.type) {
                    case ATTACK: threat += 25; break;
                    case RANGED_ATTACK: threat += 30; break;
                    case HEAL: threat += 50; break;
                    case WORK: threat += 20; break;
                    default: threat += 1;
                }
            }
        }
        return threat;
    }

    /**
     * Calculate mining value for a room
     * Higher = better for remote mining
     */
    private calculateMiningValue(intel: RoomIntel): number {
        let value = 0;

        // Base value from sources (each source = 3000 e/300 ticks = 10 e/tick)
        value += intel.sourceCount * 1000;

        // Penalty for owned rooms (can't mine)
        if (intel.owner) {
            return 0;
        }

        // Penalty for reserved by others
        if (intel.reserver && intel.reserver !== Memory.username) {
            value *= 0.5;
        }

        // Penalty for source keepers (require combat)
        if (intel.hasSourceKeepers) {
            value *= 0.3;
        }

        // Penalty for invader core
        if (intel.hasInvaderCore) {
            value *= 0.6;
        }

        // Penalty for difficult terrain
        value *= (1 - intel.terrainDifficulty * 0.5);

        // Penalty for recent hostile activity
        if (intel.lastHostileSeen && Game.time - intel.lastHostileSeen < 500) {
            value *= 0.7;
        }

        return Math.floor(value);
    }

    /**
     * Get all rooms suitable for remote mining from a base room
     */
    getRemoteMiningCandidates(baseRoomName: string, maxDistance: number = 2): RoomIntel[] {
        const candidates: RoomIntel[] = [];

        if (!Memory.intel) return candidates;

        // Get nearby room names
        const nearbyRooms = this.getRoomsInRange(baseRoomName, maxDistance);

        for (const roomName of nearbyRooms) {
            const intel = Memory.intel[roomName];
            if (!intel) continue;

            // Skip owned rooms
            if (intel.owner) continue;

            // Skip rooms with no sources
            if (intel.sourceCount === 0) continue;

            // Skip source keeper rooms (for now)
            if (intel.hasSourceKeepers) continue;

            // Check intel freshness
            if (!this.isIntelValid(roomName)) continue;

            candidates.push(intel);
        }

        // Sort by mining value (highest first)
        return candidates.sort((a, b) => b.miningValue - a.miningValue);
    }

    /**
     * Get room names within a certain distance
     */
    getRoomsInRange(centerRoom: string, range: number): string[] {
        const rooms: string[] = [];
        const parsed = this.parseRoomName(centerRoom);
        if (!parsed) return rooms;

        const { wx, wy, quadrant } = parsed;

        for (let dx = -range; dx <= range; dx++) {
            for (let dy = -range; dy <= range; dy++) {
                if (dx === 0 && dy === 0) continue;

                // Calculate new coordinates
                const newX = wx + dx;
                const newY = wy + dy;

                // Handle coordinate wrapping at sector boundaries
                const roomName = this.buildRoomName(newX, newY, quadrant);
                if (roomName) {
                    rooms.push(roomName);
                }
            }
        }

        return rooms;
    }

    /**
     * Parse room name into coordinates
     */
    private parseRoomName(roomName: string): { wx: number; wy: number; quadrant: string } | null {
        const match = roomName.match(/^([WE])(\d+)([NS])(\d+)$/);
        if (!match) return null;

        const [, we, xStr, ns, yStr] = match;
        const x = parseInt(xStr, 10);
        const y = parseInt(yStr, 10);

        // Convert to signed coordinates
        const wx = we === "W" ? -x - 1 : x;
        const wy = ns === "N" ? -y - 1 : y;

        return { wx, wy, quadrant: `${we}${ns}` };
    }

    /**
     * Build room name from coordinates
     */
    private buildRoomName(wx: number, wy: number, _quadrant: string): string | null {
        const we = wx < 0 ? "W" : "E";
        const ns = wy < 0 ? "N" : "S";
        const x = wx < 0 ? -wx - 1 : wx;
        const y = wy < 0 ? -wy - 1 : wy;

        return `${we}${x}${ns}${y}`;
    }

    /**
     * Get distance between two rooms
     */
    getRoomDistance(room1: string, room2: string): number {
        const p1 = this.parseRoomName(room1);
        const p2 = this.parseRoomName(room2);

        if (!p1 || !p2) return Infinity;

        return Math.max(
            Math.abs(p1.wx - p2.wx),
            Math.abs(p1.wy - p2.wy)
        );
    }

    /**
     * Clean up old intel data
     */
    cleanupIntel(): void {
        if (!Memory.intel) return;

        const now = Game.time;
        let cleaned = 0;

        for (const roomName in Memory.intel) {
            const intel = Memory.intel[roomName];
            if (now - intel.lastScouted > INTEL_EXPIRY.STRUCTURE * 2) {
                delete Memory.intel[roomName];
                cleaned++;
            }
        }

        if (cleaned > 0) {
            log.debug("IntelManager", `Cleaned up ${cleaned} stale intel entries`);
        }
    }

    /**
     * Get rooms that need scouting
     */
    getRoomsNeedingScouting(baseRoomName: string, maxDistance: number = 3): string[] {
        const nearbyRooms = this.getRoomsInRange(baseRoomName, maxDistance);

        return nearbyRooms.filter(roomName => {
            // Never scouted
            if (!Memory.intel?.[roomName]) return true;

            // Intel is stale
            return !this.isIntelValid(roomName);
        });
    }
}

// Add intel to Memory interface
declare global {
    interface Memory {
        intel?: { [roomName: string]: RoomIntel };
        username?: string;
    }
}

// Singleton instance
const intelManagerInstance = new IntelManager();

export const intelManagerModule = () => {
    // Clean up stale intel every 1000 ticks
    if (Game.time % 1000 === 0) {
        intelManagerInstance.cleanupIntel();
    }

    // Record intel for all visible rooms
    for (const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        // Only record intel for rooms we can see but don't own
        if (!room.controller?.my) {
            intelManagerInstance.recordRoomIntel(room);
        }
    }

    // Store our username for reservation checks
    if (!Memory.username) {
        const spawn = Object.values(Game.spawns)[0];
        if (spawn) {
            Memory.username = spawn.owner.username;
        }
    }
};

export const intelManager = intelManagerInstance;
