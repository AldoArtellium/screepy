/**
 * DemandCalculator - Calculates part demands based on room needs
 * Instead of "spawn 2 harvesters", we ask "how many WORK parts do we need?"
 */

import { countParts } from "../config/bodyTypes";
import { PartDemand } from "../types/TaskTypes";
import { log } from "../utils/logger";

/**
 * Demand scaling by phase
 */
const UPGRADE_WORK_BY_PHASE: Record<number, number> = {
    0: 2,   // Emergency - minimal upgrading
    1: 4,   // Bootstrap
    2: 6,   // Foundation
    3: 10,  // Expansion
    4: 15,  // Established
    5: 20,  // Advanced
    6: 25   // Dominant
};

/**
 * Minimum creep counts by phase for stability
 */
const MIN_CREEPS_BY_PHASE: Record<number, number> = {
    0: 3,  // Emergency
    1: 4,  // Bootstrap
    2: 6,  // Foundation
    3: 8,  // Expansion
    4: 10, // Established
    5: 12, // Advanced
    6: 15  // Dominant
};

class DemandCalculator {
    /**
     * Calculate part demands for a room
     */
    calculateDemand(room: Room): PartDemand {
        const demand: PartDemand = {};
        const phase = room.memory.phase ?? 0;
        const defenseMode = room.memory.defenseMode ?? false;

        // Calculate WORK part demand
        const harvestWork = this.calculateHarvestDemand(room);
        const buildWork = this.calculateBuildDemand(room);
        const repairWork = this.calculateRepairDemand(room);
        const upgradeWork = this.calculateUpgradeDemand(room, phase);

        const totalWork = harvestWork + buildWork + repairWork + upgradeWork;
        const suppliedWork = this.countSuppliedParts(room, WORK);

        demand[WORK] = {
            total: totalWork,
            supplied: suppliedWork,
            deficit: Math.max(0, totalWork - suppliedWork)
        };

        // Calculate CARRY part demand
        const haulCarry = this.calculateHaulDemand(room);
        const suppliedCarry = this.countSuppliedParts(room, CARRY);

        demand[CARRY] = {
            total: haulCarry,
            supplied: suppliedCarry,
            deficit: Math.max(0, haulCarry - suppliedCarry)
        };

        // Calculate ATTACK part demand (defense mode)
        const combatAttack = this.calculateCombatDemand(room, defenseMode);
        const suppliedAttack = this.countSuppliedParts(room, ATTACK);

        demand[ATTACK] = {
            total: combatAttack,
            supplied: suppliedAttack,
            deficit: Math.max(0, combatAttack - suppliedAttack)
        };

        // Store in room memory
        room.memory.partDemand = demand;

        return demand;
    }

    /**
     * Calculate WORK parts needed for harvesting
     * 5 WORK parts per source to fully drain at 10 energy/tick
     */
    private calculateHarvestDemand(room: Room): number {
        const sources = room.find(FIND_SOURCES);
        return sources.length * 5;
    }

    /**
     * Calculate WORK parts needed for building
     * Based on construction site work remaining
     */
    private calculateBuildDemand(room: Room): number {
        const sites = room.find(FIND_MY_CONSTRUCTION_SITES);
        if (sites.length === 0) return 0;

        // Total work remaining across all sites
        const totalWork = sites.reduce((sum, site) => {
            return sum + (site.progressTotal - site.progress);
        }, 0);

        // Target to complete sites in ~300 ticks
        // Each WORK part builds 5 per tick
        const targetTicks = 300;
        const workNeeded = Math.ceil(totalWork / (targetTicks * 5));

        // Cap at reasonable maximum
        return Math.min(workNeeded, 10);
    }

    /**
     * Calculate WORK parts needed for repairs
     */
    private calculateRepairDemand(room: Room): number {
        const damagedStructures = room.find(FIND_STRUCTURES, {
            filter: s => {
                // Skip walls/ramparts - they're handled differently
                if (s.structureType === STRUCTURE_WALL ||
                    s.structureType === STRUCTURE_RAMPART) {
                    return false;
                }
                return s.hits < s.hitsMax * 0.8;
            }
        });

        if (damagedStructures.length === 0) return 0;

        // 2-4 WORK parts based on damage count
        return Math.min(2 + Math.floor(damagedStructures.length / 3), 4);
    }

    /**
     * Calculate WORK parts needed for upgrading
     * Scales with room phase
     */
    private calculateUpgradeDemand(room: Room, phase: number): number {
        if (!room.controller?.my) return 0;
        return UPGRADE_WORK_BY_PHASE[phase] ?? 4;
    }

    /**
     * Calculate CARRY parts needed for hauling
     * Formula: (energyPerTick * avgRoundTripDistance) / 50
     */
    private calculateHaulDemand(room: Room): number {
        const sources = room.find(FIND_SOURCES);
        const spawn = room.find(FIND_MY_SPAWNS)[0];
        const phase = room.memory.phase ?? 0;

        if (sources.length === 0 || !spawn) return 4; // Minimum

        // Energy throughput: sources * 10 e/tick (with full miners)
        const energyPerTick = sources.length * 10;

        // Calculate average distance to sources using cached paths
        let totalDistance = 0;
        for (const source of sources) {
            // Check for container near source
            const container = source.pos.findInRange(FIND_STRUCTURES, 1, {
                filter: s => s.structureType === STRUCTURE_CONTAINER
            })[0];

            const targetPos = container ? container.pos : source.pos;
            const path = room.findPath(spawn.pos, targetPos, { ignoreCreeps: true });
            totalDistance += path.length;
        }
        const avgDistance = totalDistance / sources.length;

        // Round trip distance
        const roundTripDistance = avgDistance * 2;

        // Account for road speed bonus (2 CARRY per MOVE on roads)
        const hasRoads = room.find(FIND_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_ROAD
        }).length > 5;
        const speedFactor = hasRoads ? 0.75 : 1.0;

        // CARRY parts needed: (energy/tick * trip time) / 50
        // Trip time = roundTripDistance / speed
        let carryNeeded = Math.ceil((energyPerTick * roundTripDistance * speedFactor) / 50);

        // Add extra capacity for phase 4+ (storage operations)
        if (phase >= 4 && room.storage) {
            // Additional hauling for storage distribution
            carryNeeded = Math.ceil(carryNeeded * 1.3);
        }

        // Minimum 4, scale with phase
        const minCarry = phase >= 3 ? 8 : 4;
        return Math.max(minCarry, Math.min(carryNeeded, 40));
    }

    /**
     * Calculate ATTACK parts needed for combat
     */
    private calculateCombatDemand(room: Room, defenseMode: boolean): number {
        if (!defenseMode) return 0;

        const threatLevel = room.memory.threatLevel ?? 0;
        if (threatLevel === 0) return 0;

        // Scale attack parts with threat level
        const attackNeeded = Math.ceil(threatLevel / 100);

        // Cap at reasonable maximum
        return Math.min(attackNeeded, 20);
    }

    /**
     * Count supplied parts from all creeps in a room
     */
    private countSuppliedParts(room: Room, partType: BodyPartConstant): number {
        const creeps = room.find(FIND_MY_CREEPS);
        let total = 0;

        for (const creep of creeps) {
            total += countParts(creep, partType);
        }

        return total;
    }

    /**
     * Get demand summary for display
     */
    getDemandSummary(room: Room): string[] {
        const demand = room.memory.partDemand;
        if (!demand) return ["No demand data"];

        const lines: string[] = [];

        if (demand[WORK]) {
            lines.push(`WORK: ${demand[WORK].supplied}/${demand[WORK].total} (${demand[WORK].deficit > 0 ? `-${demand[WORK].deficit}` : "OK"})`);
        }
        if (demand[CARRY]) {
            lines.push(`CARRY: ${demand[CARRY].supplied}/${demand[CARRY].total} (${demand[CARRY].deficit > 0 ? `-${demand[CARRY].deficit}` : "OK"})`);
        }
        if (demand[ATTACK] && demand[ATTACK].total > 0) {
            lines.push(`ATTACK: ${demand[ATTACK].supplied}/${demand[ATTACK].total} (${demand[ATTACK].deficit > 0 ? `-${demand[ATTACK].deficit}` : "OK"})`);
        }

        return lines;
    }
}

// Singleton instance
const demandCalculatorInstance = new DemandCalculator();

export const demandCalculatorModule = () => {
    for (const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if (!room.controller?.my) continue;

        demandCalculatorInstance.calculateDemand(room);
    }
};

export const demandCalculator = demandCalculatorInstance;
