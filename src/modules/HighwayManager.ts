/**
 * HighwayManager - Power bank and deposit harvesting
 *
 * Features:
 * - Observer integration for highway scanning
 * - Power bank detection and profitability check
 * - Deposit detection and mining
 * - Attack team coordination
 * - Hauler timing for power pickup
 * - Power processing management
 */

import { log } from "../utils/logger";
import { intelManager } from "./IntelManager";

/** Highway target types */
export enum HighwayTargetType {
    POWER_BANK = "powerBank",
    DEPOSIT = "deposit"
}

/** Power bank operation */
interface PowerBankOperation {
    id: string;
    roomName: string;
    bankId: Id<StructurePowerBank>;
    bankPos: { x: number; y: number };
    power: number;
    hits: number;
    decayTime: number;
    sourceRoom: string;
    status: "scouted" | "attacking" | "collecting" | "complete";
    attackers: string[];
    healers: string[];
    haulers: string[];
    createdAt: number;
}

/** Deposit operation */
interface DepositOperation {
    id: string;
    roomName: string;
    depositId: Id<Deposit>;
    depositPos: { x: number; y: number };
    depositType: DepositConstant;
    cooldown: number;
    decayTime: number;
    sourceRoom: string;
    status: "mining" | "complete";
    miners: string[];
    haulers: string[];
    createdAt: number;
}

/** Configuration */
const CONFIG = {
    /** Minimum power to be worth harvesting */
    MIN_POWER_AMOUNT: 3000,
    /** Maximum distance to highway rooms */
    MAX_HIGHWAY_DISTANCE: 4,
    /** Minimum RCL to harvest power */
    MIN_RCL_FOR_POWER: 7,
    /** Minimum RCL for deposits */
    MIN_RCL_FOR_DEPOSITS: 6,
    /** Attackers needed per 500k hits */
    ATTACKERS_PER_500K: 2,
    /** Healers per attacker */
    HEALERS_PER_ATTACKER: 1,
    /** Hauler capacity assumption */
    HAULER_CAPACITY: 2500
};

class HighwayManager {
    /** Active power bank operations */
    private powerOperations: Map<string, PowerBankOperation> = new Map();

    /** Active deposit operations */
    private depositOperations: Map<string, DepositOperation> = new Map();

    /** Rooms we've scanned recently */
    private scannedRooms: Set<string> = new Set();

    /**
     * Main highway management function
     */
    manage(): void {
        // Only run for rooms with sufficient RCL
        const eligibleRooms = Object.values(Game.rooms).filter(
            r => r.controller?.my && r.controller.level >= CONFIG.MIN_RCL_FOR_DEPOSITS
        );

        if (eligibleRooms.length === 0) return;

        // Scan highways using observers
        this.scanHighways(eligibleRooms);

        // Process power bank operations
        this.processPowerOperations();

        // Process deposit operations
        this.processDepositOperations();

        // Cleanup completed operations
        this.cleanup();
    }

    /**
     * Scan highway rooms using observers
     */
    private scanHighways(rooms: Room[]): void {
        for (const room of rooms) {
            // Find observer in room
            const observer = room.find(FIND_MY_STRUCTURES, {
                filter: s => s.structureType === STRUCTURE_OBSERVER
            })[0] as StructureObserver | undefined;

            if (!observer) continue;

            // Get nearby highway rooms to scan
            const highways = this.getNearbyHighways(room.name);
            const unscanned = highways.filter(r => !this.scannedRooms.has(r));

            if (unscanned.length === 0) {
                // Reset scanned rooms periodically
                if (Game.time % 1000 === 0) {
                    this.scannedRooms.clear();
                }
                continue;
            }

            // Scan one room per tick per observer
            const targetRoom = unscanned[Game.time % unscanned.length];
            observer.observeRoom(targetRoom);
            this.scannedRooms.add(targetRoom);
        }

        // Check visible highway rooms for targets
        for (const roomName in Game.rooms) {
            if (!this.isHighway(roomName)) continue;

            const room = Game.rooms[roomName];
            this.checkRoomForTargets(room);
        }
    }

    /**
     * Get highway room names near a room
     */
    private getNearbyHighways(roomName: string): string[] {
        const highways: string[] = [];

        // Parse room coordinates
        const match = roomName.match(/^([WE])(\d+)([NS])(\d+)$/);
        if (!match) return highways;

        const [, we, xStr, ns, yStr] = match;
        const x = parseInt(xStr, 10);
        const y = parseInt(yStr, 10);

        // Search in range for highway rooms
        for (let dx = -CONFIG.MAX_HIGHWAY_DISTANCE; dx <= CONFIG.MAX_HIGHWAY_DISTANCE; dx++) {
            for (let dy = -CONFIG.MAX_HIGHWAY_DISTANCE; dy <= CONFIG.MAX_HIGHWAY_DISTANCE; dy++) {
                const newX = x + dx;
                const newY = y + dy;

                if (newX < 0 || newY < 0) continue;

                const newRoomName = `${we}${newX}${ns}${newY}`;

                if (this.isHighway(newRoomName)) {
                    highways.push(newRoomName);
                }
            }
        }

        return highways;
    }

    /**
     * Check if a room is a highway (room coords divisible by 10)
     */
    private isHighway(roomName: string): boolean {
        const match = roomName.match(/^[WE](\d+)[NS](\d+)$/);
        if (!match) return false;

        const x = parseInt(match[1], 10);
        const y = parseInt(match[2], 10);

        // Highway rooms have x % 10 === 0 or y % 10 === 0
        return x % 10 === 0 || y % 10 === 0;
    }

    /**
     * Check a room for power banks and deposits
     */
    private checkRoomForTargets(room: Room): void {
        // Check for power banks
        const powerBanks = room.find(FIND_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_POWER_BANK
        }) as StructurePowerBank[];

        for (const bank of powerBanks) {
            if (this.powerOperations.has(bank.id)) continue;

            // Check if profitable
            if (!this.isPowerBankProfitable(bank, room.name)) continue;

            // Find source room
            const sourceRoom = this.findNearestOwnedRoom(room.name, CONFIG.MIN_RCL_FOR_POWER);
            if (!sourceRoom) continue;

            this.createPowerOperation(bank, sourceRoom);
        }

        // Check for deposits
        const deposits = room.find(FIND_DEPOSITS);

        for (const deposit of deposits) {
            if (this.depositOperations.has(deposit.id)) continue;

            // Check if deposit is fresh (low cooldown)
            if (deposit.cooldown > 100) continue;

            // Find source room
            const sourceRoom = this.findNearestOwnedRoom(room.name, CONFIG.MIN_RCL_FOR_DEPOSITS);
            if (!sourceRoom) continue;

            this.createDepositOperation(deposit, sourceRoom);
        }
    }

    /**
     * Check if a power bank is worth harvesting
     */
    private isPowerBankProfitable(bank: StructurePowerBank, roomName: string): boolean {
        // Check power amount
        if (bank.power < CONFIG.MIN_POWER_AMOUNT) {
            return false;
        }

        // Check decay time (need at least 3000 ticks)
        if (bank.ticksToDecay < 3000) {
            return false;
        }

        // Find nearest owned room
        const sourceRoom = this.findNearestOwnedRoom(roomName, CONFIG.MIN_RCL_FOR_POWER);
        if (!sourceRoom) return false;

        // Calculate distance
        const distance = intelManager.getRoomDistance(sourceRoom, roomName);

        // Check if we have enough time
        const travelTime = distance * 50; // Rough estimate
        const attackTime = bank.hits / 600; // 600 damage per tick with 1 attacker
        const totalTime = travelTime * 2 + attackTime;

        return totalTime < bank.ticksToDecay;
    }

    /**
     * Find nearest owned room with minimum RCL
     */
    private findNearestOwnedRoom(targetRoom: string, minRCL: number): string | null {
        let nearest: string | null = null;
        let nearestDist = Infinity;

        for (const room of Object.values(Game.rooms)) {
            if (!room.controller?.my) continue;
            if (room.controller.level < minRCL) continue;

            const dist = intelManager.getRoomDistance(room.name, targetRoom);
            if (dist < nearestDist) {
                nearestDist = dist;
                nearest = room.name;
            }
        }

        return nearest;
    }

    /**
     * Create a power bank operation
     */
    private createPowerOperation(bank: StructurePowerBank, sourceRoom: string): void {
        const operation: PowerBankOperation = {
            id: `power-${bank.id}`,
            roomName: bank.room!.name,
            bankId: bank.id,
            bankPos: { x: bank.pos.x, y: bank.pos.y },
            power: bank.power,
            hits: bank.hits,
            decayTime: bank.ticksToDecay,
            sourceRoom,
            status: "scouted",
            attackers: [],
            healers: [],
            haulers: [],
            createdAt: Game.time
        };

        this.powerOperations.set(bank.id, operation);
        log.info("HighwayManager", `Created power bank operation: ${operation.id} (${bank.power} power)`);

        // Store in memory for SpawnManager
        if (!Memory.highwayOperations) {
            Memory.highwayOperations = { power: {}, deposits: {} };
        }
        Memory.highwayOperations.power[bank.id] = operation;
    }

    /**
     * Create a deposit operation
     */
    private createDepositOperation(deposit: Deposit, sourceRoom: string): void {
        const operation: DepositOperation = {
            id: `deposit-${deposit.id}`,
            roomName: deposit.room!.name,
            depositId: deposit.id,
            depositPos: { x: deposit.pos.x, y: deposit.pos.y },
            depositType: deposit.depositType,
            cooldown: deposit.cooldown,
            decayTime: deposit.ticksToDecay,
            sourceRoom,
            status: "mining",
            miners: [],
            haulers: [],
            createdAt: Game.time
        };

        this.depositOperations.set(deposit.id, operation);
        log.info("HighwayManager", `Created deposit operation: ${operation.id} (${deposit.depositType})`);

        // Store in memory for SpawnManager
        if (!Memory.highwayOperations) {
            Memory.highwayOperations = { power: {}, deposits: {} };
        }
        Memory.highwayOperations.deposits[deposit.id] = operation;
    }

    /**
     * Process power bank operations
     */
    private processPowerOperations(): void {
        for (const [id, op] of this.powerOperations) {
            const bank = Game.getObjectById(op.bankId);

            // Bank is destroyed
            if (!bank) {
                if (op.status === "attacking") {
                    op.status = "collecting";
                    log.info("HighwayManager", `Power bank ${id} destroyed, collecting power`);
                }
                continue;
            }

            // Update bank stats
            op.hits = bank.hits;
            op.decayTime = bank.ticksToDecay;

            // Check if we should spawn attackers
            if (op.status === "scouted") {
                const attackersNeeded = Math.ceil(op.hits / 500000) * CONFIG.ATTACKERS_PER_500K;
                const healersNeeded = attackersNeeded * CONFIG.HEALERS_PER_ATTACKER;

                // Request spawns through memory
                const memOp = Memory.highwayOperations?.power[id];
                if (memOp) {
                    memOp.attackersNeeded = attackersNeeded;
                    memOp.healersNeeded = healersNeeded;
                }

                // Check if we have creeps assigned
                const attackers = op.attackers.filter(n => Game.creeps[n]).length;
                const healers = op.healers.filter(n => Game.creeps[n]).length;

                if (attackers >= 1 && healers >= 1) {
                    op.status = "attacking";
                    log.info("HighwayManager", `Power bank ${id} attack starting`);
                }
            }

            // Time haulers for power pickup
            if (op.status === "attacking" && bank.hits < 100000) {
                const haulersNeeded = Math.ceil(op.power / CONFIG.HAULER_CAPACITY);
                const memOp = Memory.highwayOperations?.power[id];
                if (memOp) {
                    memOp.haulersNeeded = haulersNeeded;
                }
            }
        }
    }

    /**
     * Process deposit operations
     */
    private processDepositOperations(): void {
        for (const [, op] of this.depositOperations) {
            const deposit = Game.getObjectById(op.depositId);

            // Deposit is gone
            if (!deposit) {
                op.status = "complete";
                continue;
            }

            // Update deposit stats
            op.cooldown = deposit.cooldown;
            op.decayTime = deposit.ticksToDecay;

            // Check if deposit is still worth mining
            if (deposit.cooldown > 100 || deposit.ticksToDecay < 1000) {
                op.status = "complete";
                continue;
            }
        }
    }

    /**
     * Cleanup completed operations
     */
    private cleanup(): void {
        // Power operations
        for (const [id, op] of this.powerOperations) {
            if (op.status === "complete" || Game.time - op.createdAt > 10000) {
                this.powerOperations.delete(id);
                if (Memory.highwayOperations?.power) {
                    delete Memory.highwayOperations.power[id];
                }
            }

            // Check for collection complete
            if (op.status === "collecting") {
                // Check if power is picked up
                const room = Game.rooms[op.roomName];
                if (room) {
                    const droppedPower = room.find(FIND_DROPPED_RESOURCES, {
                        filter: r => r.resourceType === RESOURCE_POWER
                    });

                    if (droppedPower.length === 0) {
                        op.status = "complete";
                        log.info("HighwayManager", `Power operation ${id} complete`);
                    }
                }
            }
        }

        // Deposit operations
        for (const [id, op] of this.depositOperations) {
            if (op.status === "complete" || Game.time - op.createdAt > 10000) {
                this.depositOperations.delete(id);
                if (Memory.highwayOperations?.deposits) {
                    delete Memory.highwayOperations.deposits[id];
                }
            }
        }
    }

    /**
     * Get active operations
     */
    getOperations(): { power: PowerBankOperation[]; deposits: DepositOperation[] } {
        return {
            power: [...this.powerOperations.values()],
            deposits: [...this.depositOperations.values()]
        };
    }

    /**
     * Assign a creep to an operation
     */
    assignCreep(creepName: string, operationId: string, role: "attacker" | "healer" | "hauler" | "miner"): void {
        // Check power operations
        for (const [id, op] of this.powerOperations) {
            if (id === operationId || op.id === operationId) {
                if (role === "attacker") op.attackers.push(creepName);
                else if (role === "healer") op.healers.push(creepName);
                else if (role === "hauler") op.haulers.push(creepName);
                return;
            }
        }

        // Check deposit operations
        for (const [id, op] of this.depositOperations) {
            if (id === operationId || op.id === operationId) {
                if (role === "miner") op.miners.push(creepName);
                else if (role === "hauler") op.haulers.push(creepName);
                return;
            }
        }
    }

    /**
     * Get summary of highway operations for dashboard
     */
    getHighwaySummary(_detailed: boolean = false): HighwayOpSummary[] {
        const summaries: HighwayOpSummary[] = [];

        // Power bank operations
        for (const [, op] of this.powerOperations) {
            summaries.push({
                id: op.id,
                type: "power",
                room: op.roomName,
                status: op.status,
                value: op.power
            });
        }

        // Deposit operations
        for (const [, op] of this.depositOperations) {
            summaries.push({
                id: op.id,
                type: "deposit",
                room: op.roomName,
                status: op.status,
                value: 0 // Deposits don't have a fixed value
            });
        }

        return summaries;
    }
}

// Add memory interface
declare global {
    interface Memory {
        highwayOperations?: {
            power: {
                [id: string]: PowerBankOperation & {
                    attackersNeeded?: number;
                    healersNeeded?: number;
                    haulersNeeded?: number;
                };
            };
            deposits: { [id: string]: DepositOperation };
        };
    }
}

// Singleton instance
const highwayManagerInstance = new HighwayManager();

export const highwayManagerModule = () => {
    // Only run every 5 ticks
    if (Game.time % 5 !== 0) return;
    highwayManagerInstance.manage();
};

export const highwayManager = highwayManagerInstance;
