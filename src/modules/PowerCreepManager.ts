/**
 * PowerCreepManager - Power creep spawning and management
 *
 * Features:
 * - Power creep spawning based on GPL
 * - Economy power selection (OPERATE_SPAWN, OPERATE_EXTENSION, etc.)
 * - Room assignment optimization
 * - Power usage cooldown tracking
 * - Renewal management
 */

import { log } from "../utils/logger";
import { trafficManager } from "./TrafficManager";

/** Power types focused on economy */
const ECONOMY_POWERS: PowerConstant[] = [
    PWR_OPERATE_SPAWN,
    PWR_OPERATE_EXTENSION,
    PWR_OPERATE_STORAGE,
    PWR_OPERATE_TERMINAL,
    PWR_OPERATE_FACTORY,
    PWR_GENERATE_OPS,
    PWR_REGEN_SOURCE,
    PWR_REGEN_MINERAL
];

/** Power costs and effects */
const POWER_CONFIG: Partial<Record<PowerConstant, {
    cooldown: number;
    range: number;
    duration?: number;
    effect?: number;
    ops: number;
    level: number;
}>> = {
    [PWR_GENERATE_OPS]: { cooldown: 50, range: 0, ops: 0, level: 0 },
    [PWR_OPERATE_SPAWN]: { cooldown: 300, range: 3, duration: 1000, effect: 0.5, ops: 100, level: 1 },
    [PWR_OPERATE_EXTENSION]: { cooldown: 50, range: 3, ops: 2, level: 1 },
    [PWR_OPERATE_STORAGE]: { cooldown: 800, range: 3, duration: 1000, ops: 100, level: 2 },
    [PWR_OPERATE_TERMINAL]: { cooldown: 500, range: 3, duration: 1000, ops: 100, level: 2 },
    [PWR_OPERATE_FACTORY]: { cooldown: 1000, range: 3, duration: 1000, ops: 100, level: 3 },
    [PWR_REGEN_SOURCE]: { cooldown: 300, range: 3, duration: 300, ops: 0, level: 1 },
    [PWR_REGEN_MINERAL]: { cooldown: 100, range: 3, duration: 100, ops: 0, level: 2 },
    // Combat powers (included for completeness but not prioritized)
    [PWR_SHIELD]: { cooldown: 50, range: 3, duration: 50, ops: 100, level: 4 },
    [PWR_DISRUPT_SPAWN]: { cooldown: 5, range: 20, duration: 1, ops: 10, level: 3 },
    [PWR_DISRUPT_TOWER]: { cooldown: 10, range: 50, duration: 5, ops: 10, level: 3 },
    [PWR_DISRUPT_SOURCE]: { cooldown: 100, range: 3, duration: 100, ops: 100, level: 5 },
    [PWR_DISRUPT_TERMINAL]: { cooldown: 8, range: 50, duration: 10, ops: 50, level: 5 },
    [PWR_OPERATE_OBSERVER]: { cooldown: 400, range: 3, duration: 400, ops: 10, level: 1 },
    [PWR_OPERATE_LAB]: { cooldown: 50, range: 3, duration: 1000, ops: 10, level: 2 },
    [PWR_OPERATE_POWER]: { cooldown: 800, range: 3, duration: 1000, ops: 200, level: 3 },
    [PWR_OPERATE_CONTROLLER]: { cooldown: 800, range: 3, duration: 1000, ops: 200, level: 4 },
    [PWR_FORTIFY]: { cooldown: 5, range: 3, duration: 1, ops: 5, level: 2 },
};

/** Power creep class (Operator for economy) */
const OPERATOR_CLASS = "operator";

/** Configuration */
const CONFIG = {
    /** Minimum ops to have before using powers */
    MIN_OPS_RESERVE: 500,
    /** Ticks before death to renew */
    RENEW_THRESHOLD: 500,
    /** Enable room threshold */
    MIN_RCL_FOR_POWER: 8
};

/** Power creep assignment */
interface PowerCreepAssignment {
    creepName: string;
    roomName: string;
    lastRenewal: number;
    powersUsed: Partial<Record<PowerConstant, number>>;
}

class PowerCreepManager {
    /** Power creep assignments */
    private assignments: Map<string, PowerCreepAssignment> = new Map();

    /**
     * Main power creep management function
     */
    manage(): void {
        // Check if we have any power creeps
        if (Object.keys(Game.powerCreeps).length === 0) {
            // Try to create one if we have GPL
            this.tryCreatePowerCreep();
            return;
        }

        // Process each power creep
        for (const name in Game.powerCreeps) {
            const powerCreep = Game.powerCreeps[name];

            // Skip unspawned power creeps
            if (!powerCreep.room) {
                this.trySpawnPowerCreep(powerCreep);
                continue;
            }

            this.processPowerCreep(powerCreep);
        }

        // Update assignments
        this.updateAssignments();
    }

    /**
     * Try to create a new power creep
     */
    private tryCreatePowerCreep(): void {
        // Only try once per 1000 ticks
        if (Game.time % 1000 !== 0) return;

        // Check if we have GPL
        if (Game.gpl.level === 0) return;

        // Check if we have unspent GPL
        const existingCount = Object.keys(Game.powerCreeps).length;
        if (existingCount >= Game.gpl.level) return;

        // Create an operator power creep
        const name = `Operator${existingCount + 1}`;
        const result = PowerCreep.create(name, OPERATOR_CLASS as any);

        if (result === OK) {
            log.info("PowerCreepManager", `Created power creep: ${name}`);
        }
    }

    /**
     * Try to spawn an unspawned power creep
     */
    private trySpawnPowerCreep(powerCreep: PowerCreep): void {
        // Find a suitable room with PowerSpawn
        for (const room of Object.values(Game.rooms)) {
            if (!room.controller?.my) continue;
            if (room.controller.level < CONFIG.MIN_RCL_FOR_POWER) continue;

            const powerSpawn = room.find(FIND_MY_STRUCTURES, {
                filter: s => s.structureType === STRUCTURE_POWER_SPAWN
            })[0] as StructurePowerSpawn | undefined;

            if (!powerSpawn) continue;

            // Check if room already has a power creep
            const hasPC = Object.values(Game.powerCreeps).some(
                pc => pc.room?.name === room.name
            );
            if (hasPC) continue;

            const result = powerCreep.spawn(powerSpawn);
            if (result === OK) {
                log.info("PowerCreepManager", `Spawned ${powerCreep.name} in ${room.name}`);
            }
            return;
        }
    }

    /**
     * Process an active power creep
     */
    private processPowerCreep(pc: PowerCreep): void {
        if (!pc.room) return;

        // Check renewal
        if (pc.ticksToLive && pc.ticksToLive < CONFIG.RENEW_THRESHOLD) {
            this.renewPowerCreep(pc);
            return;
        }

        // Generate ops if low
        if (pc.store.getUsedCapacity(RESOURCE_OPS) < CONFIG.MIN_OPS_RESERVE) {
            this.generateOps(pc);
        }

        // Enable room if needed
        if (!pc.room.controller?.isPowerEnabled) {
            this.enableRoom(pc);
            return;
        }

        // Use economy powers
        this.useEconomyPowers(pc);
    }

    /**
     * Renew power creep at PowerSpawn
     */
    private renewPowerCreep(pc: PowerCreep): void {
        const powerSpawn = pc.room?.find(FIND_MY_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_POWER_SPAWN
        })[0] as StructurePowerSpawn | undefined;

        if (!powerSpawn) {
            // Move to a room with PowerSpawn
            const targetRoom = this.findPowerSpawnRoom(pc);
            if (targetRoom) {
                trafficManager.moveToRoom(pc, targetRoom);
            }
            return;
        }

        if (pc.pos.isNearTo(powerSpawn)) {
            const result = pc.renew(powerSpawn);
            if (result === OK) {
                log.debug("PowerCreepManager", `${pc.name} renewed`);
                const assignment = this.assignments.get(pc.name);
                if (assignment) {
                    assignment.lastRenewal = Game.time;
                }
            }
        } else {
            trafficManager.requestMove(pc, powerSpawn);
        }
    }

    /**
     * Generate ops
     */
    private generateOps(pc: PowerCreep): void {
        if (!pc.powers[PWR_GENERATE_OPS]) return;

        const power = pc.powers[PWR_GENERATE_OPS];
        if (power.cooldown && power.cooldown > 0) return;

        const result = pc.usePower(PWR_GENERATE_OPS);
        if (result === OK) {
            log.debug("PowerCreepManager", `${pc.name} generated ops`);
        }
    }

    /**
     * Enable room for power usage
     */
    private enableRoom(pc: PowerCreep): void {
        const controller = pc.room?.controller;
        if (!controller) return;

        if (pc.pos.isNearTo(controller)) {
            const result = pc.enableRoom(controller);
            if (result === OK) {
                log.info("PowerCreepManager", `Enabled power in ${pc.room?.name}`);
            }
        } else {
            trafficManager.requestMove(pc, controller);
        }
    }

    /**
     * Use economy powers
     */
    private useEconomyPowers(pc: PowerCreep): void {
        if (!pc.room) return;

        const ops = pc.store.getUsedCapacity(RESOURCE_OPS);

        // Priority 1: OPERATE_SPAWN during high activity
        this.tryOperateSpawn(pc, ops);

        // Priority 2: OPERATE_EXTENSION for fast filling
        this.tryOperateExtension(pc, ops);

        // Priority 3: REGEN_SOURCE for bonus energy
        this.tryRegenSource(pc);

        // Priority 4: OPERATE_FACTORY if factory exists
        this.tryOperateFactory(pc, ops);

        // Priority 5: REGEN_MINERAL if mineral exists
        this.tryRegenMineral(pc);
    }

    /**
     * Try to use OPERATE_SPAWN
     */
    private tryOperateSpawn(pc: PowerCreep, ops: number): void {
        const powerInfo = POWER_CONFIG[PWR_OPERATE_SPAWN];
        if (!powerInfo) return;
        if (!pc.powers[PWR_OPERATE_SPAWN]) return;
        if (pc.powers[PWR_OPERATE_SPAWN].cooldown && pc.powers[PWR_OPERATE_SPAWN].cooldown > 0) return;
        if (ops < powerInfo.ops) return;

        const spawns = pc.room?.find(FIND_MY_SPAWNS, {
            filter: s => !s.spawning && !s.effects?.some(e => e.effect === PWR_OPERATE_SPAWN)
        });

        if (!spawns || spawns.length === 0) return;

        // Only use if spawn queue has items
        const spawnQueue = (pc.room?.memory as any)?.spawnQueue;
        if (!spawnQueue || spawnQueue.length === 0) return;

        const target = pc.pos.findClosestByRange(spawns);
        if (!target) return;

        if (pc.pos.inRangeTo(target, powerInfo.range)) {
            pc.usePower(PWR_OPERATE_SPAWN, target);
        } else {
            trafficManager.requestMove(pc, target);
        }
    }

    /**
     * Try to use OPERATE_EXTENSION
     */
    private tryOperateExtension(pc: PowerCreep, ops: number): void {
        const powerInfo = POWER_CONFIG[PWR_OPERATE_EXTENSION];
        if (!powerInfo) return;
        if (!pc.powers[PWR_OPERATE_EXTENSION]) return;
        if (pc.powers[PWR_OPERATE_EXTENSION].cooldown && pc.powers[PWR_OPERATE_EXTENSION].cooldown > 0) return;
        if (ops < powerInfo.ops) return;

        const storage = pc.room?.storage;
        if (!storage) return;
        if (storage.store.getUsedCapacity(RESOURCE_ENERGY) < 10000) return;

        // Check if extensions need filling
        const emptyExtensions = pc.room?.find(FIND_MY_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_EXTENSION &&
                        s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
        });

        if (!emptyExtensions || emptyExtensions.length < 10) return;

        if (pc.pos.inRangeTo(storage, powerInfo.range)) {
            pc.usePower(PWR_OPERATE_EXTENSION, storage);
        } else {
            trafficManager.requestMove(pc, storage);
        }
    }

    /**
     * Try to use REGEN_SOURCE
     */
    private tryRegenSource(pc: PowerCreep): void {
        const powerInfo = POWER_CONFIG[PWR_REGEN_SOURCE];
        if (!powerInfo) return;
        if (!pc.powers[PWR_REGEN_SOURCE]) return;
        if (pc.powers[PWR_REGEN_SOURCE].cooldown && pc.powers[PWR_REGEN_SOURCE].cooldown > 0) return;

        const sources = pc.room?.find(FIND_SOURCES, {
            filter: s => !s.effects?.some(e => e.effect === PWR_REGEN_SOURCE)
        });

        if (!sources || sources.length === 0) return;

        const target = pc.pos.findClosestByRange(sources);
        if (!target) return;

        if (pc.pos.inRangeTo(target, powerInfo.range)) {
            pc.usePower(PWR_REGEN_SOURCE, target);
        } else {
            trafficManager.requestMove(pc, target);
        }
    }

    /**
     * Try to use OPERATE_FACTORY
     */
    private tryOperateFactory(pc: PowerCreep, ops: number): void {
        const powerInfo = POWER_CONFIG[PWR_OPERATE_FACTORY];
        if (!powerInfo) return;
        if (!pc.powers[PWR_OPERATE_FACTORY]) return;
        if (pc.powers[PWR_OPERATE_FACTORY].cooldown && pc.powers[PWR_OPERATE_FACTORY].cooldown > 0) return;
        if (ops < powerInfo.ops) return;

        const factory = pc.room?.find(FIND_MY_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_FACTORY &&
                        !s.effects?.some(e => e.effect === PWR_OPERATE_FACTORY)
        })[0] as StructureFactory | undefined;

        if (!factory) return;

        if (pc.pos.inRangeTo(factory, powerInfo.range)) {
            pc.usePower(PWR_OPERATE_FACTORY, factory);
        } else {
            trafficManager.requestMove(pc, factory);
        }
    }

    /**
     * Try to use REGEN_MINERAL
     */
    private tryRegenMineral(pc: PowerCreep): void {
        const powerInfo = POWER_CONFIG[PWR_REGEN_MINERAL];
        if (!powerInfo) return;
        if (!pc.powers[PWR_REGEN_MINERAL]) return;
        if (pc.powers[PWR_REGEN_MINERAL].cooldown && pc.powers[PWR_REGEN_MINERAL].cooldown > 0) return;

        const minerals = pc.room?.find(FIND_MINERALS, {
            filter: m => m.mineralAmount > 0 && !m.effects?.some(e => e.effect === PWR_REGEN_MINERAL)
        });

        if (!minerals || minerals.length === 0) return;

        const target = minerals[0];

        if (pc.pos.inRangeTo(target, powerInfo.range)) {
            pc.usePower(PWR_REGEN_MINERAL, target);
        } else {
            trafficManager.requestMove(pc, target);
        }
    }

    /**
     * Find a room with PowerSpawn
     */
    private findPowerSpawnRoom(_pc: PowerCreep): string | null {
        for (const room of Object.values(Game.rooms)) {
            if (!room.controller?.my) continue;

            const powerSpawn = room.find(FIND_MY_STRUCTURES, {
                filter: s => s.structureType === STRUCTURE_POWER_SPAWN
            })[0];

            if (powerSpawn) return room.name;
        }
        return null;
    }

    /**
     * Update power creep assignments
     */
    private updateAssignments(): void {
        for (const name in Game.powerCreeps) {
            const pc = Game.powerCreeps[name];

            if (!this.assignments.has(name)) {
                this.assignments.set(name, {
                    creepName: name,
                    roomName: pc.room?.name ?? "",
                    lastRenewal: Game.time,
                    powersUsed: {}
                });
            } else if (pc.room) {
                const assignment = this.assignments.get(name)!;
                assignment.roomName = pc.room.name;
            }
        }
    }

    /**
     * Upgrade a power for a power creep
     */
    upgradePower(creepName: string, power: PowerConstant): boolean {
        const pc = Game.powerCreeps[creepName];
        if (!pc) return false;

        // Check if power can be upgraded
        const currentLevel = pc.powers[power]?.level ?? 0;
        if (currentLevel >= 5) return false;

        const result = pc.upgrade(power);
        if (result === OK) {
            log.info("PowerCreepManager", `Upgraded ${creepName}'s ${power} to level ${currentLevel + 1}`);
            return true;
        }

        return false;
    }

    /**
     * Get recommended power upgrades
     */
    getRecommendedUpgrades(creepName: string): PowerConstant[] {
        const pc = Game.powerCreeps[creepName];
        if (!pc) return [];

        const upgrades: PowerConstant[] = [];

        // Prioritize economy powers
        for (const power of ECONOMY_POWERS) {
            const currentLevel = pc.powers[power]?.level ?? 0;
            if (currentLevel < 5) {
                upgrades.push(power);
            }
        }

        return upgrades;
    }

    /**
     * Get stats for dashboard
     */
    getStats(): {
        gplLevel: number;
        powerCreeps: number;
        totalOps: number;
    } {
        let totalOps = 0;
        for (const name in Game.powerCreeps) {
            const pc = Game.powerCreeps[name];
            if (pc.room) {
                totalOps += pc.store.getUsedCapacity(RESOURCE_OPS);
            }
        }

        return {
            gplLevel: Game.gpl.level,
            powerCreeps: Object.keys(Game.powerCreeps).length,
            totalOps
        };
    }
}

// Singleton instance
const powerCreepManagerInstance = new PowerCreepManager();

export const powerCreepManagerModule = () => {
    // Only run every 3 ticks
    if (Game.time % 3 !== 0) return;
    powerCreepManagerInstance.manage();
};

export const powerCreepManager = powerCreepManagerInstance;
