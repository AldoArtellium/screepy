/**
 * SKManager - Source Keeper room mining operations
 *
 * Features:
 * - SK room selection and evaluation
 * - Keeper tracking and spawn prediction
 * - SK killer creep management
 * - Safe mining window calculation
 * - Mineral extraction from SK rooms
 * - Invader raid detection and response
 */

import { log } from "../utils/logger";
import { intelManager } from "./IntelManager";

/** Source Keeper lair respawn time - reserved for respawn prediction */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const KEEPER_RESPAWN_TIME = 300;

/** SK room operation */
interface SKRoomOperation {
    roomName: string;
    sourceRoom: string;
    status: "scouting" | "active" | "paused" | "abandoned";
    sources: SKSourceInfo[];
    mineral?: SKMineralInfo;
    killers: string[];
    miners: string[];
    haulers: string[];
    lastKeeperKill: number;
    createdAt: number;
}

/** Source info in SK room */
interface SKSourceInfo {
    sourceId: Id<Source>;
    pos: { x: number; y: number };
    lairId?: Id<StructureKeeperLair>;
    lairPos?: { x: number; y: number };
    containerId?: Id<StructureContainer>;
    minerId?: string;
    nextKeeperSpawn?: number;
    isSafe: boolean;
}

/** Mineral info in SK room */
interface SKMineralInfo {
    mineralId: Id<Mineral>;
    mineralType: MineralConstant;
    pos: { x: number; y: number };
    lairId?: Id<StructureKeeperLair>;
    extractorId?: Id<StructureExtractor>;
    minerId?: string;
    nextKeeperSpawn?: number;
    isSafe: boolean;
}

/** SK killer body - designed to kill keepers efficiently - reserved for spawning */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const SK_KILLER_BODY = {
    /** Parts for RCL 7 */
    RCL7: [
        TOUGH, TOUGH, TOUGH, TOUGH, TOUGH,
        MOVE, MOVE, MOVE, MOVE, MOVE,
        MOVE, MOVE, MOVE, MOVE, MOVE,
        ATTACK, ATTACK, ATTACK, ATTACK, ATTACK,
        ATTACK, ATTACK, ATTACK, ATTACK, ATTACK,
        HEAL, HEAL, HEAL, HEAL, HEAL
    ],
    /** Parts for RCL 8 with boosts */
    RCL8_BOOSTED: [
        TOUGH, TOUGH, TOUGH, TOUGH, TOUGH,
        TOUGH, TOUGH, TOUGH, TOUGH, TOUGH,
        MOVE, MOVE, MOVE, MOVE, MOVE,
        MOVE, MOVE, MOVE, MOVE, MOVE,
        ATTACK, ATTACK, ATTACK, ATTACK, ATTACK,
        ATTACK, ATTACK, ATTACK, ATTACK, ATTACK,
        HEAL, HEAL, HEAL, HEAL, HEAL,
        HEAL, HEAL, HEAL, HEAL, HEAL
    ]
};

/** Configuration */
const CONFIG = {
    /** Minimum RCL to mine SK rooms */
    MIN_RCL: 7,
    /** Maximum distance to SK room */
    MAX_DISTANCE: 2,
    /** Time before keeper spawn to leave */
    SAFE_MARGIN: 20,
    /** Minimum energy in source to start mining */
    MIN_SOURCE_ENERGY: 500,
    /** Raid warning time (ticks before invasion) */
    RAID_WARNING_TIME: 100
};

class SKManager {
    /** Active SK room operations */
    private operations: Map<string, SKRoomOperation> = new Map();

    /**
     * Main SK management function
     */
    manage(): void {
        // Only run for rooms with RCL 7+
        const eligibleRooms = Object.values(Game.rooms).filter(
            r => r.controller?.my && r.controller.level >= CONFIG.MIN_RCL
        );

        if (eligibleRooms.length === 0) return;

        // Find and evaluate SK rooms
        this.evaluateSKRooms(eligibleRooms);

        // Process active operations
        for (const [, op] of this.operations) {
            this.processOperation(op);
        }

        // Cleanup abandoned operations
        this.cleanup();
    }

    /**
     * Evaluate nearby SK rooms for mining
     */
    private evaluateSKRooms(ownedRooms: Room[]): void {
        for (const room of ownedRooms) {
            // Get nearby SK rooms
            const skRooms = this.findNearbySKRooms(room.name);

            for (const skRoomName of skRooms) {
                // Skip if already have an operation
                if (this.operations.has(skRoomName)) continue;

                // Check intel
                const intel = intelManager.getIntel(skRoomName);
                if (!intel || !intel.hasSourceKeepers) continue;

                // Check if room is visible
                const skRoom = Game.rooms[skRoomName];
                if (!skRoom) continue;

                // Evaluate room value
                if (this.evaluateSKRoom(skRoom, room.name)) {
                    this.createOperation(skRoom, room.name);
                }
            }
        }
    }

    /**
     * Find SK rooms near an owned room
     */
    private findNearbySKRooms(roomName: string): string[] {
        const skRooms: string[] = [];
        const nearbyRooms = intelManager.getRoomsInRange(roomName, CONFIG.MAX_DISTANCE);

        for (const nearbyRoom of nearbyRooms) {
            if (this.isSKRoom(nearbyRoom)) {
                skRooms.push(nearbyRoom);
            }
        }

        return skRooms;
    }

    /**
     * Check if a room is a Source Keeper room
     */
    private isSKRoom(roomName: string): boolean {
        const match = roomName.match(/^[WE](\d+)[NS](\d+)$/);
        if (!match) return false;

        const x = parseInt(match[1], 10) % 10;
        const y = parseInt(match[2], 10) % 10;

        // SK rooms are at coordinates 4-6 from sector center
        // (not highway, not center)
        return (x >= 4 && x <= 6) && (y >= 4 && y <= 6) &&
               !(x === 5 && y === 5); // Center room is different
    }

    /**
     * Evaluate if an SK room is worth mining
     */
    private evaluateSKRoom(room: Room, sourceRoom: string): boolean {
        const sources = room.find(FIND_SOURCES);
        // Mineral checked but not used yet - reserved for mineral value evaluation
        room.find(FIND_MINERALS);

        // Must have at least 2 sources
        if (sources.length < 2) return false;

        // Check for invader core (skip if present)
        const invaderCore = room.find(FIND_HOSTILE_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_INVADER_CORE
        })[0];

        if (invaderCore) return false;

        // Check distance
        const distance = intelManager.getRoomDistance(sourceRoom, room.name);
        if (distance > CONFIG.MAX_DISTANCE) return false;

        return true;
    }

    /**
     * Create an SK room operation
     */
    private createOperation(room: Room, sourceRoom: string): void {
        const sources = room.find(FIND_SOURCES);
        const mineral = room.find(FIND_MINERALS)[0];
        const lairs = room.find(FIND_HOSTILE_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_KEEPER_LAIR
        }) as StructureKeeperLair[];

        // Map sources with their lairs
        const sourceInfos: SKSourceInfo[] = sources.map(source => {
            const lair = source.pos.findInRange(lairs, 5)[0];
            const container = source.pos.findInRange(FIND_STRUCTURES, 1, {
                filter: s => s.structureType === STRUCTURE_CONTAINER
            })[0] as StructureContainer | undefined;

            return {
                sourceId: source.id,
                pos: { x: source.pos.x, y: source.pos.y },
                lairId: lair?.id,
                lairPos: lair ? { x: lair.pos.x, y: lair.pos.y } : undefined,
                containerId: container?.id,
                isSafe: !lair || (lair.ticksToSpawn ?? 0) > CONFIG.SAFE_MARGIN
            };
        });

        // Map mineral with its lair
        let mineralInfo: SKMineralInfo | undefined;
        if (mineral) {
            const lair = mineral.pos.findInRange(lairs, 5)[0];
            const extractor = mineral.pos.lookFor(LOOK_STRUCTURES)
                .find(s => s.structureType === STRUCTURE_EXTRACTOR) as StructureExtractor | undefined;

            mineralInfo = {
                mineralId: mineral.id,
                mineralType: mineral.mineralType,
                pos: { x: mineral.pos.x, y: mineral.pos.y },
                lairId: lair?.id,
                extractorId: extractor?.id,
                isSafe: !lair || (lair.ticksToSpawn ?? 0) > CONFIG.SAFE_MARGIN
            };
        }

        const operation: SKRoomOperation = {
            roomName: room.name,
            sourceRoom,
            status: "scouting",
            sources: sourceInfos,
            mineral: mineralInfo,
            killers: [],
            miners: [],
            haulers: [],
            lastKeeperKill: 0,
            createdAt: Game.time
        };

        this.operations.set(room.name, operation);

        // Store in memory
        if (!Memory.skOperations) {
            Memory.skOperations = {};
        }
        Memory.skOperations[room.name] = operation;

        log.info("SKManager", `Created SK operation for ${room.name} from ${sourceRoom}`);
    }

    /**
     * Process an SK room operation
     */
    private processOperation(op: SKRoomOperation): void {
        const room = Game.rooms[op.roomName];

        // Update operation state
        this.updateOperationState(op, room);

        // Handle different statuses
        switch (op.status) {
            case "scouting":
                this.handleScouting(op);
                break;

            case "active":
                this.handleActive(op, room);
                break;

            case "paused":
                this.handlePaused(op, room);
                break;
        }
    }

    /**
     * Update operation state based on room visibility
     */
    private updateOperationState(op: SKRoomOperation, room: Room | undefined): void {
        if (!room) return;

        // Update keeper spawn times
        // Lairs found for potential future use in spawn prediction
        room.find(FIND_HOSTILE_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_KEEPER_LAIR
        });

        for (const source of op.sources) {
            if (source.lairId) {
                const lair = Game.getObjectById(source.lairId);
                if (lair) {
                    source.nextKeeperSpawn = lair.ticksToSpawn ?? Infinity;
                    source.isSafe = (lair.ticksToSpawn ?? Infinity) > CONFIG.SAFE_MARGIN;
                }
            }

            // Check for active keepers near source
            const keepers = room.find(FIND_HOSTILE_CREEPS, {
                filter: c => c.pos.inRangeTo(source.pos.x, source.pos.y, 5) &&
                            c.owner.username === "Source Keeper"
            });
            if (keepers.length > 0) {
                source.isSafe = false;
            }
        }

        if (op.mineral?.lairId) {
            const lair = Game.getObjectById(op.mineral.lairId);
            if (lair) {
                op.mineral.nextKeeperSpawn = lair.ticksToSpawn ?? Infinity;
                op.mineral.isSafe = (lair.ticksToSpawn ?? Infinity) > CONFIG.SAFE_MARGIN;
            }
        }

        // Check for invader raid
        const invaders = room.find(FIND_HOSTILE_CREEPS, {
            filter: c => c.owner.username === "Invader"
        });

        if (invaders.length > 0) {
            op.status = "paused";
            log.warn("SKManager", `${op.roomName}: Invader raid detected, pausing operation`);
        }
    }

    /**
     * Handle scouting phase
     */
    private handleScouting(op: SKRoomOperation): void {
        // Check if we have killers
        const aliveKillers = op.killers.filter(n => Game.creeps[n]).length;

        if (aliveKillers === 0) {
            // Request killer spawn
            const memOp = Memory.skOperations?.[op.roomName];
            if (memOp) {
                memOp.needsKiller = true;
            }
        } else {
            // Transition to active when killer arrives
            op.status = "active";
            log.info("SKManager", `${op.roomName}: SK operation now active`);
        }
    }

    /**
     * Handle active mining
     */
    private handleActive(op: SKRoomOperation, room: Room | undefined): void {
        if (!room) return;

        // Manage SK killers
        this.manageKillers(op, room);

        // Check if miners are needed for safe sources
        const safeSources = op.sources.filter(s => s.isSafe && !s.minerId);
        if (safeSources.length > 0) {
            const memOp = Memory.skOperations?.[op.roomName];
            if (memOp) {
                memOp.needsMiners = safeSources.length;
            }
        }

        // Check if haulers are needed
        const containers = op.sources
            .filter(s => s.containerId)
            .map(s => Game.getObjectById(s.containerId!))
            .filter((c): c is StructureContainer => !!c);

        const fullContainers = containers.filter(
            c => c.store.getUsedCapacity(RESOURCE_ENERGY) > 1500
        ).length;

        if (fullContainers > 0) {
            const memOp = Memory.skOperations?.[op.roomName];
            if (memOp) {
                memOp.needsHaulers = Math.ceil(fullContainers / 2);
            }
        }
    }

    /**
     * Manage SK killer creeps
     */
    private manageKillers(op: SKRoomOperation, room: Room): void {
        const killers = op.killers
            .map(n => Game.creeps[n])
            .filter((c): c is Creep => !!c);

        if (killers.length === 0) {
            // Need to spawn new killer
            op.status = "scouting";
            return;
        }

        // Find active keepers
        const keepers = room.find(FIND_HOSTILE_CREEPS, {
            filter: c => c.owner.username === "Source Keeper"
        });

        for (const killer of killers) {
            // Self-heal if damaged
            if (killer.hits < killer.hitsMax) {
                killer.heal(killer);
            }

            if (keepers.length > 0) {
                // Attack nearest keeper
                const target = killer.pos.findClosestByRange(keepers);
                if (target) {
                    if (killer.pos.isNearTo(target)) {
                        killer.attack(target);
                    } else {
                        killer.moveTo(target);
                    }

                    // Use ranged attack if available
                    if (killer.pos.inRangeTo(target, 3)) {
                        killer.rangedAttack(target);
                    }
                }
            } else {
                // Patrol between lairs
                this.patrolLairs(killer, op);
            }
        }
    }

    /**
     * Patrol between keeper lairs
     */
    private patrolLairs(killer: Creep, op: SKRoomOperation): void {
        // Find lair with soonest spawn
        let targetLair: StructureKeeperLair | null = null;
        let soonestSpawn = Infinity;

        for (const source of op.sources) {
            if (source.lairId) {
                const lair = Game.getObjectById(source.lairId);
                if (lair && (lair.ticksToSpawn ?? Infinity) < soonestSpawn) {
                    soonestSpawn = lair.ticksToSpawn ?? Infinity;
                    targetLair = lair;
                }
            }
        }

        if (op.mineral?.lairId) {
            const lair = Game.getObjectById(op.mineral.lairId);
            if (lair && (lair.ticksToSpawn ?? Infinity) < soonestSpawn) {
                targetLair = lair;
            }
        }

        if (targetLair && !killer.pos.inRangeTo(targetLair, 3)) {
            killer.moveTo(targetLair);
        }

        // Self-heal while waiting
        if (killer.hits < killer.hitsMax) {
            killer.heal(killer);
        }
    }

    /**
     * Handle paused operation (during raids)
     */
    private handlePaused(op: SKRoomOperation, room: Room | undefined): void {
        if (!room) return;

        // Check if raid is over
        const invaders = room.find(FIND_HOSTILE_CREEPS, {
            filter: c => c.owner.username === "Invader"
        });

        if (invaders.length === 0) {
            op.status = "active";
            log.info("SKManager", `${op.roomName}: Raid over, resuming operation`);
        }
    }

    /**
     * Cleanup abandoned operations
     */
    private cleanup(): void {
        for (const [roomName, op] of this.operations) {
            // Remove if abandoned
            if (op.status === "abandoned") {
                this.operations.delete(roomName);
                if (Memory.skOperations) {
                    delete Memory.skOperations[roomName];
                }
                continue;
            }

            // Remove if too old with no activity
            if (Game.time - op.createdAt > 50000 && op.killers.length === 0) {
                this.operations.delete(roomName);
                if (Memory.skOperations) {
                    delete Memory.skOperations[roomName];
                }
            }
        }
    }

    /**
     * Assign a creep to an operation
     */
    assignCreep(creepName: string, roomName: string, role: "killer" | "miner" | "hauler"): void {
        const op = this.operations.get(roomName);
        if (!op) return;

        switch (role) {
            case "killer":
                op.killers.push(creepName);
                break;
            case "miner":
                op.miners.push(creepName);
                break;
            case "hauler":
                op.haulers.push(creepName);
                break;
        }
    }

    /**
     * Get active operations
     */
    getOperations(): SKRoomOperation[] {
        return [...this.operations.values()];
    }

    /**
     * Abandon an operation
     */
    abandonOperation(roomName: string): void {
        const op = this.operations.get(roomName);
        if (op) {
            op.status = "abandoned";
            log.info("SKManager", `Abandoned SK operation for ${roomName}`);
        }
    }
}

// Add memory interface
declare global {
    interface Memory {
        skOperations?: {
            [roomName: string]: SKRoomOperation & {
                needsKiller?: boolean;
                needsMiners?: number;
                needsHaulers?: number;
            };
        };
    }
}

// Singleton instance
const skManagerInstance = new SKManager();

export const skManagerModule = () => {
    // Only run every 5 ticks
    if (Game.time % 5 !== 0) return;
    skManagerInstance.manage();
};

export const skManager = skManagerInstance;
