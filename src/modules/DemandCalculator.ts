/**
 * DemandCalculator - Calculates part demands based on room needs
 * Instead of "spawn 2 harvesters", we ask "how many WORK parts do we need?"
 */

import { BodyType, countParts } from "../config/bodyTypes";
import { countStat } from "../utils/stats";
import { PartDemand } from "../types/TaskTypes";

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
 * Minimum creep counts by phase for stability - reserved for future use
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const MIN_CREEPS_BY_PHASE: Record<number, number> = {
    0: 3,  // Emergency
    1: 4,  // Bootstrap
    2: 6,  // Foundation
    3: 8,  // Expansion
    4: 10, // Established
    5: 12, // Advanced
    6: 15  // Dominant
};

/** Stop adding WORK when this many workers are waiting for energy */
const STARVED_WORKERS_BRAKE = 2;

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

        // Static miners cover harvesting; generic workers only fill what they don't
        const minerWork = this.countSuppliedParts(room, WORK, true);
        const suppliedWork = this.countSuppliedParts(room, WORK);
        const wantedWork = Math.max(0, harvestWork - minerWork) + buildWork + repairWork + upgradeWork;
        // Off by default (Memory.config.demandLimits = true enables both limits below): on the
        // 3 benchmark rooms they cost up to 48% points (W9N5) and never helped by more than 2%
        const limits = Memory.config?.demandLimits === true;
        let totalWork = limits ? Math.min(wantedWork, this.maxSustainableWork(room)) : wantedWork;
        // Adaptive brake: workers already waiting for energy means income is the bottleneck,
        // more WORK would only add waiting creeps (W1N3: sources far, 21 creeps, -20% points)
        if (limits && this.starvedWorkers(room) >= STARVED_WORKERS_BRAKE) {
            totalWork = Math.min(totalWork, suppliedWork);
            countStat("demand:workBraked");
        }

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
     * Task workers waiting for energy with nothing to go to: no logistics reservation and no source
     * to harvest (or no task at all while not hauling)
     */
    private starvedWorkers(room: Room): number {
        return room.find(FIND_MY_CREEPS, {
            filter: c => {
                if (c.spawning || c.memory.role || c.memory.hauling) return false;
                if (c.memory.bodyType !== BodyType.WORKER) return false;
                const task = c.memory.currentTask;
                if (!task) return true;
                return task.state === "acquiring" && !c.memory.logistics && !task.energySourceId;
            }
        }).length;
    }

    /**
     * Without storage, workers harvest their own energy: each harvesting tile around a source
     * feeds about two workers (they spend roughly half their time harvesting). More WORK only adds
     * creeps waiting for energy (seen on W7N3: 26 creeps, 13 waiting, 8 idle). With storage the
     * economy runs on stored energy and static mining, so no cap.
     */
    private maxSustainableWork(room: Room): number {
        if (room.storage) return Infinity;
        const terrain = room.getTerrain();
        let slots = 0;
        for (const source of room.find(FIND_SOURCES)) {
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    if ((dx || dy) && terrain.get(source.pos.x + dx, source.pos.y + dy) !== TERRAIN_MASK_WALL) slots++;
                }
            }
        }
        return slots * 2;
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
     * Count supplied parts from the creeps working for a room, wherever they are.
     * Creeps sent to another room (targetRoom) count for that room instead, and
     * creeps about to die are ignored so their replacement is spawned in time.
     */
    private countSuppliedParts(room: Room, partType: BodyPartConstant, miners = false): number {
        let total = 0;

        for (const name in Game.creeps) {
            const creep = Game.creeps[name];
            if (creep.memory.role) continue; // module-driven creeps don't work for the task system
            if ((creep.memory.bodyType === BodyType.MINER) !== miners) continue;
            const workRoom = creep.memory.targetRoom ?? creep.memory.room ?? creep.room.name;
            if (workRoom !== room.name) continue;
            const replacementTime = creep.body.length * CREEP_SPAWN_TIME + 20;
            if (creep.ticksToLive !== undefined && creep.ticksToLive < replacementTime) continue;

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
