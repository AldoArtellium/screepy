/**
 * StrongholdManager - Invader stronghold detection and assault
 *
 * Features:
 * - Stronghold detection via scouting/observers
 * - Level assessment and attack planning
 * - Composition calculation based on stronghold level
 * - Coordinated assault timing
 * - Loot collection after victory
 */

import { log } from "../utils/logger";
import { intelManager } from "./IntelManager";

/** Stronghold levels and their characteristics */
const STRONGHOLD_CONFIG: Record<number, {
    coreHits: number;
    towers: number;
    ramparts: number;
    minRCL: number;
    boostsRequired: boolean;
    attackers: number;
    healers: number;
    dismantlers: number;
}> = {
    1: { coreHits: 10000, towers: 0, ramparts: 10000, minRCL: 5, boostsRequired: false, attackers: 2, healers: 1, dismantlers: 1 },
    2: { coreHits: 20000, towers: 1, ramparts: 50000, minRCL: 6, boostsRequired: false, attackers: 3, healers: 2, dismantlers: 2 },
    3: { coreHits: 50000, towers: 2, ramparts: 200000, minRCL: 7, boostsRequired: true, attackers: 4, healers: 3, dismantlers: 3 },
    4: { coreHits: 100000, towers: 3, ramparts: 500000, minRCL: 7, boostsRequired: true, attackers: 5, healers: 4, dismantlers: 4 },
    5: { coreHits: 200000, towers: 4, ramparts: 1000000, minRCL: 8, boostsRequired: true, attackers: 6, healers: 5, dismantlers: 5 }
};

/** Stronghold operation */
interface StrongholdOperation {
    id: string;
    roomName: string;
    coreId: Id<StructureInvaderCore> | null;
    level: number;
    collapseTime: number;
    sourceRoom: string;
    status: "scouted" | "preparing" | "attacking" | "looting" | "complete" | "failed";
    attackers: string[];
    healers: string[];
    dismantlers: string[];
    haulers: string[];
    createdAt: number;
    boostsReady: boolean;
}

/** Configuration */
const CONFIG = {
    /** Maximum distance to consider strongholds */
    MAX_DISTANCE: 5,
    /** Minimum time remaining to attempt attack */
    MIN_COLLAPSE_TIME: 10000,
    /** Time to wait for team assembly */
    ASSEMBLY_TIMEOUT: 2000,
    /** Loot value threshold (in credits equivalent) */
    MIN_LOOT_VALUE: 10000
};

class StrongholdManager {
    /** Active stronghold operations */
    private operations: Map<string, StrongholdOperation> = new Map();

    /** Detected strongholds */
    private detectedStrongholds: Map<string, { roomName: string; level: number; collapseTime: number }> = new Map();

    /**
     * Main stronghold management function
     */
    manage(): void {
        // Only run for rooms with sufficient RCL
        const eligibleRooms = Object.values(Game.rooms).filter(
            r => r.controller?.my && r.controller.level >= 5
        );

        if (eligibleRooms.length === 0) return;

        // Scan for strongholds
        this.scanForStrongholds(eligibleRooms);

        // Evaluate detected strongholds
        this.evaluateStrongholds();

        // Process active operations
        this.processOperations();

        // Cleanup
        this.cleanup();
    }

    /**
     * Scan visible rooms for strongholds
     */
    private scanForStrongholds(ownedRooms: Room[]): void {
        // Check intel data for strongholds
        for (const room of ownedRooms) {
            const nearbyRooms = this.getNearbyRooms(room.name, CONFIG.MAX_DISTANCE);

            for (const roomName of nearbyRooms) {
                // Skip if already have operation
                if (this.operations.has(roomName)) continue;

                // Check if room is visible
                const targetRoom = Game.rooms[roomName];
                if (targetRoom) {
                    this.checkRoomForStronghold(targetRoom);
                }
            }
        }
    }

    /**
     * Get nearby room names
     */
    private getNearbyRooms(roomName: string, range: number): string[] {
        const rooms: string[] = [];
        const match = roomName.match(/^([WE])(\d+)([NS])(\d+)$/);
        if (!match) return rooms;

        const [, we, xStr, ns, yStr] = match;
        const x = parseInt(xStr, 10);
        const y = parseInt(yStr, 10);

        for (let dx = -range; dx <= range; dx++) {
            for (let dy = -range; dy <= range; dy++) {
                if (dx === 0 && dy === 0) continue;

                const newX = x + dx;
                const newY = y + dy;
                if (newX < 0 || newY < 0) continue;

                rooms.push(`${we}${newX}${ns}${newY}`);
            }
        }

        return rooms;
    }

    /**
     * Check a room for stronghold core
     */
    private checkRoomForStronghold(room: Room): void {
        const core = room.find(FIND_HOSTILE_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_INVADER_CORE
        })[0] as StructureInvaderCore | undefined;

        if (!core) {
            this.detectedStrongholds.delete(room.name);
            return;
        }

        // Only track active strongholds (not deploying)
        if (core.ticksToDeploy > 0) return;

        this.detectedStrongholds.set(room.name, {
            roomName: room.name,
            level: core.level,
            collapseTime: Game.time + (core.effects?.find(e => e.effect === EFFECT_COLLAPSE_TIMER)?.ticksRemaining ?? 0)
        });
    }

    /**
     * Evaluate detected strongholds for attack viability
     */
    private evaluateStrongholds(): void {
        for (const [roomName, stronghold] of this.detectedStrongholds) {
            // Skip if already have operation
            if (this.operations.has(roomName)) continue;

            // Check collapse time
            const timeRemaining = stronghold.collapseTime - Game.time;
            if (timeRemaining < CONFIG.MIN_COLLAPSE_TIME) {
                log.debug("StrongholdManager", `Stronghold ${roomName} too close to collapse: ${timeRemaining} ticks`);
                continue;
            }

            // Find source room
            const sourceRoom = this.findSourceRoom(roomName, stronghold.level);
            if (!sourceRoom) {
                log.debug("StrongholdManager", `No suitable source room for stronghold ${roomName}`);
                continue;
            }

            // Check if profitable
            if (!this.isStrongholdProfitable(stronghold.level, sourceRoom, roomName)) {
                continue;
            }

            // Create operation
            this.createOperation(roomName, stronghold.level, stronghold.collapseTime, sourceRoom);
        }
    }

    /**
     * Find a suitable source room for the operation
     */
    private findSourceRoom(targetRoom: string, level: number): string | null {
        const config = STRONGHOLD_CONFIG[level];
        if (!config) return null;

        let best: string | null = null;
        let bestDist = Infinity;

        for (const room of Object.values(Game.rooms)) {
            if (!room.controller?.my) continue;
            if (room.controller.level < config.minRCL) continue;

            // Check if room can support boosts if required
            if (config.boostsRequired) {
                const labs = room.find(FIND_MY_STRUCTURES, {
                    filter: s => s.structureType === STRUCTURE_LAB
                });
                if (labs.length < 3) continue;
            }

            const dist = intelManager.getRoomDistance(room.name, targetRoom);
            if (dist < bestDist) {
                bestDist = dist;
                best = room.name;
            }
        }

        return best;
    }

    /**
     * Check if attacking a stronghold is profitable
     */
    private isStrongholdProfitable(level: number, sourceRoom: string, targetRoom: string): boolean {
        // Simplified profitability check
        // Higher level strongholds have better loot
        const baseLootValue = level * 5000;
        const distance = intelManager.getRoomDistance(sourceRoom, targetRoom);
        const travelCost = distance * 500; // Rough energy cost

        return baseLootValue > travelCost;
    }

    /**
     * Create a stronghold operation
     */
    private createOperation(roomName: string, level: number, collapseTime: number, sourceRoom: string): void {
        const room = Game.rooms[roomName];
        const core = room?.find(FIND_HOSTILE_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_INVADER_CORE
        })[0] as StructureInvaderCore | undefined;

        const operation: StrongholdOperation = {
            id: `stronghold-${roomName}-${Game.time}`,
            roomName,
            coreId: core?.id ?? null,
            level,
            collapseTime,
            sourceRoom,
            status: "scouted",
            attackers: [],
            healers: [],
            dismantlers: [],
            haulers: [],
            createdAt: Game.time,
            boostsReady: false
        };

        this.operations.set(roomName, operation);
        log.info("StrongholdManager", `Created operation for level ${level} stronghold in ${roomName}`);

        // Store in memory for SpawnManager
        if (!Memory.strongholdOperations) {
            Memory.strongholdOperations = {};
        }
        Memory.strongholdOperations[roomName] = operation;
    }

    /**
     * Process active stronghold operations
     */
    private processOperations(): void {
        for (const [roomName, op] of this.operations) {
            const config = STRONGHOLD_CONFIG[op.level];
            if (!config) continue;

            switch (op.status) {
                case "scouted":
                    this.processScoutedOperation(op, config);
                    break;

                case "preparing":
                    this.processPreparingOperation(op, config);
                    break;

                case "attacking":
                    this.processAttackingOperation(op);
                    break;

                case "looting":
                    this.processLootingOperation(op);
                    break;
            }

            // Update memory
            if (Memory.strongholdOperations) {
                Memory.strongholdOperations[roomName] = op;
            }
        }
    }

    /**
     * Process scouted operation - request spawns
     */
    private processScoutedOperation(op: StrongholdOperation, config: typeof STRONGHOLD_CONFIG[1]): void {
        // Request spawn via memory
        const memOp = Memory.strongholdOperations?.[op.roomName];
        if (memOp) {
            memOp.attackersNeeded = config.attackers;
            memOp.healersNeeded = config.healers;
            memOp.dismantlersNeeded = config.dismantlers;
        }

        // Check if we have minimum creeps
        const attackers = op.attackers.filter(n => Game.creeps[n]).length;
        const healers = op.healers.filter(n => Game.creeps[n]).length;
        const dismantlers = op.dismantlers.filter(n => Game.creeps[n]).length;

        if (attackers >= 1 && healers >= 1 && dismantlers >= 1) {
            op.status = "preparing";
            log.info("StrongholdManager", `Operation ${op.id} preparing for attack`);
        }
    }

    /**
     * Process preparing operation - wait for full team and boosts
     */
    private processPreparingOperation(op: StrongholdOperation, config: typeof STRONGHOLD_CONFIG[1]): void {
        const attackers = op.attackers.filter(n => Game.creeps[n]).length;
        const healers = op.healers.filter(n => Game.creeps[n]).length;
        const dismantlers = op.dismantlers.filter(n => Game.creeps[n]).length;

        // Check if team is ready
        const teamReady = attackers >= config.attackers * 0.75 &&
                         healers >= config.healers * 0.75 &&
                         dismantlers >= config.dismantlers * 0.75;

        // Check boost status if required
        if (config.boostsRequired && !op.boostsReady) {
            // TODO: Check if boosts are ready via LabManager
            // For now, assume boosts are ready after 500 ticks
            if (Game.time - op.createdAt > 500) {
                op.boostsReady = true;
            }
        }

        const boostsOK = !config.boostsRequired || op.boostsReady;

        // Timeout check
        if (Game.time - op.createdAt > CONFIG.ASSEMBLY_TIMEOUT) {
            if (teamReady && boostsOK) {
                op.status = "attacking";
                log.info("StrongholdManager", `Operation ${op.id} starting attack (partial team)`);
            } else {
                op.status = "failed";
                log.warn("StrongholdManager", `Operation ${op.id} failed - team assembly timeout`);
            }
            return;
        }

        // Full team ready
        if (teamReady && boostsOK) {
            op.status = "attacking";
            log.info("StrongholdManager", `Operation ${op.id} starting attack (full team)`);
        }
    }

    /**
     * Process attacking operation - coordinate assault
     */
    private processAttackingOperation(op: StrongholdOperation): void {
        const room = Game.rooms[op.roomName];

        // Check if core is destroyed
        if (op.coreId) {
            const core = Game.getObjectById(op.coreId);
            if (!core) {
                op.status = "looting";
                log.info("StrongholdManager", `Stronghold ${op.roomName} core destroyed, looting`);

                // Request haulers
                const memOp = Memory.strongholdOperations?.[op.roomName];
                if (memOp) {
                    memOp.haulersNeeded = 3;
                }
                return;
            }
        }

        // Check if we lost too many creeps
        const attackers = op.attackers.filter(n => Game.creeps[n]).length;
        const healers = op.healers.filter(n => Game.creeps[n]).length;

        if (attackers === 0 || healers === 0) {
            op.status = "failed";
            log.warn("StrongholdManager", `Operation ${op.id} failed - lost critical creeps`);
            return;
        }

        // Manage attacking creeps (they should have combat tasks)
        // The actual combat is handled by their assigned tasks
    }

    /**
     * Process looting operation - collect resources
     */
    private processLootingOperation(op: StrongholdOperation): void {
        const room = Game.rooms[op.roomName];

        if (!room) {
            // Can't see room, assume looting complete after timeout
            if (Game.time - op.createdAt > 5000) {
                op.status = "complete";
            }
            return;
        }

        // Check for remaining loot
        const loot = room.find(FIND_DROPPED_RESOURCES);
        const ruins = room.find(FIND_RUINS, {
            filter: r => r.store.getUsedCapacity() > 0
        });

        if (loot.length === 0 && ruins.length === 0) {
            op.status = "complete";
            log.info("StrongholdManager", `Operation ${op.id} complete - looting finished`);
        }
    }

    /**
     * Cleanup completed operations
     */
    private cleanup(): void {
        for (const [roomName, op] of this.operations) {
            // Remove completed or failed operations
            if (op.status === "complete" || op.status === "failed") {
                this.operations.delete(roomName);
                this.detectedStrongholds.delete(roomName);

                if (Memory.strongholdOperations) {
                    delete Memory.strongholdOperations[roomName];
                }
                continue;
            }

            // Remove if stronghold collapsed
            if (Game.time > op.collapseTime) {
                log.info("StrongholdManager", `Operation ${op.id} ended - stronghold collapsed`);
                this.operations.delete(roomName);
                this.detectedStrongholds.delete(roomName);

                if (Memory.strongholdOperations) {
                    delete Memory.strongholdOperations[roomName];
                }
            }

            // Remove very old operations
            if (Game.time - op.createdAt > 20000) {
                this.operations.delete(roomName);

                if (Memory.strongholdOperations) {
                    delete Memory.strongholdOperations[roomName];
                }
            }
        }
    }

    /**
     * Get active operations
     */
    getOperations(): StrongholdOperation[] {
        return [...this.operations.values()];
    }

    /**
     * Assign a creep to an operation
     */
    assignCreep(creepName: string, roomName: string, role: "attacker" | "healer" | "dismantler" | "hauler"): void {
        const op = this.operations.get(roomName);
        if (!op) return;

        switch (role) {
            case "attacker":
                if (!op.attackers.includes(creepName)) op.attackers.push(creepName);
                break;
            case "healer":
                if (!op.healers.includes(creepName)) op.healers.push(creepName);
                break;
            case "dismantler":
                if (!op.dismantlers.includes(creepName)) op.dismantlers.push(creepName);
                break;
            case "hauler":
                if (!op.haulers.includes(creepName)) op.haulers.push(creepName);
                break;
        }
    }

    /**
     * Get target priorities for combat creeps
     */
    getTargetPriority(room: Room): (Structure | Creep)[] {
        const targets: (Structure | Creep)[] = [];

        // Priority 1: Invader core
        const core = room.find(FIND_HOSTILE_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_INVADER_CORE
        });
        targets.push(...core);

        // Priority 2: Towers
        const towers = room.find(FIND_HOSTILE_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_TOWER
        });
        targets.push(...towers);

        // Priority 3: Keeper hostiles
        const hostiles = room.find(FIND_HOSTILE_CREEPS);
        targets.push(...hostiles);

        // Priority 4: Ramparts (lowest hits first)
        const ramparts = room.find(FIND_HOSTILE_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_RAMPART
        }).sort((a, b) => a.hits - b.hits);
        targets.push(...ramparts);

        return targets;
    }
}

// Add memory interface
declare global {
    interface Memory {
        strongholdOperations?: {
            [roomName: string]: StrongholdOperation & {
                attackersNeeded?: number;
                healersNeeded?: number;
                dismantlersNeeded?: number;
                haulersNeeded?: number;
            };
        };
    }
}

// Singleton instance
const strongholdManagerInstance = new StrongholdManager();

export const strongholdManagerModule = () => {
    // Only run every 10 ticks
    if (Game.time % 10 !== 0) return;
    strongholdManagerInstance.manage();
};

export const strongholdManager = strongholdManagerInstance;
