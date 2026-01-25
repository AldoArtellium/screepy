/**
 * TowerManager - Tower defense and maintenance
 *
 * Behavior modes:
 * - Defense mode: Focus on attack only, skip all repairs
 * - Normal mode: Attack > Heal > Repair priority
 *
 * Features:
 * - Smart target prioritization (healers > ranged > melee > tough)
 * - Energy reserve management for attacks
 * - RCL-scaled wall/rampart repair
 */

import { log } from "../utils/logger";

/** Tower energy thresholds */
const TOWER_ENERGY = {
    /** Minimum energy to attack */
    ATTACK_MIN: 10,
    /** Minimum energy for repairs (non-defense mode) */
    REPAIR_MIN: 500,
    /** Reserve energy for potential attacks */
    ATTACK_RESERVE: 200,
    /** Minimum energy for wall/rampart repairs */
    WALL_REPAIR_MIN: 700
};

/** Threat scoring for body parts */
const BODY_PART_THREAT: Partial<Record<BodyPartConstant, number>> = {
    [HEAL]: 15,          // Highest threat - sustains attackers
    [RANGED_ATTACK]: 10, // Can attack from distance
    [ATTACK]: 8,         // Melee damage
    [WORK]: 6,           // Can dismantle
    [CLAIM]: 20,         // Can attack controller
    [CARRY]: 1,          // Usually not a threat
    [MOVE]: 1,
    [TOUGH]: 2           // Indicates boosted creep
};

/** Wall/rampart hit targets by RCL */
const WALL_TARGETS: Record<number, number> = {
    1: 1000,
    2: 5000,
    3: 25000,
    4: 50000,
    5: 100000,
    6: 300000,
    7: 500000,
    8: 1000000
};

class TowerManager {
    /**
     * Run tower logic for a room
     */
    run(room: Room): void {
        const towers = room.find(FIND_MY_STRUCTURES, {
            filter: (s): s is StructureTower => s.structureType === STRUCTURE_TOWER
        });

        if (towers.length === 0) return;

        const defenseMode = room.memory.defenseMode ?? false;
        const hostiles = room.find(FIND_HOSTILE_CREEPS);

        // Attack hostiles (highest priority in any mode)
        if (hostiles.length > 0) {
            this.attackHostiles(towers, hostiles);
            return;
        }

        // In defense mode, only attack - skip healing and repairs to conserve energy
        if (defenseMode) return;

        // Heal damaged creeps
        if (this.healCreeps(towers, room)) return;

        // Repair structures (with energy threshold)
        this.repairStructures(towers, room);
    }

    /**
     * Attack hostile creeps with smart targeting
     */
    private attackHostiles(towers: StructureTower[], hostiles: Creep[]): void {
        const target = this.selectPriorityTarget(hostiles);

        for (const tower of towers) {
            if (tower.store.getUsedCapacity(RESOURCE_ENERGY) > TOWER_ENERGY.ATTACK_MIN) {
                tower.attack(target);
            }
        }
    }

    /**
     * Select the highest priority target based on threat assessment
     */
    private selectPriorityTarget(hostiles: Creep[]): Creep {
        return hostiles.sort((a, b) => {
            const aThreat = this.evaluateThreat(a);
            const bThreat = this.evaluateThreat(b);

            // Primary sort: threat level (higher first)
            if (aThreat !== bThreat) {
                return bThreat - aThreat;
            }

            // Secondary sort: lower health first (easier to kill)
            return a.hits - b.hits;
        })[0];
    }

    /**
     * Evaluate threat level of a hostile creep
     */
    private evaluateThreat(creep: Creep): number {
        let threat = 0;

        for (const part of creep.body) {
            // Only count active parts
            if (part.hits <= 0) continue;

            const baseThreat = BODY_PART_THREAT[part.type] ?? 1;

            // Boosted parts are more dangerous
            const boostMultiplier = part.boost ? 2.5 : 1;

            threat += baseThreat * boostMultiplier;
        }

        // Bonus threat for high health (harder to kill)
        threat += creep.hits / 500;

        return threat;
    }

    /**
     * Heal damaged friendly creeps
     */
    private healCreeps(towers: StructureTower[], room: Room): boolean {
        const damagedCreeps = room.find(FIND_MY_CREEPS, {
            filter: c => c.hits < c.hitsMax
        });

        if (damagedCreeps.length === 0) return false;

        // Heal most damaged creep first
        const target = damagedCreeps.sort((a, b) =>
            (a.hits / a.hitsMax) - (b.hits / b.hitsMax)
        )[0];

        let healed = false;
        for (const tower of towers) {
            // Keep some energy reserve for potential attacks
            if (tower.store.getUsedCapacity(RESOURCE_ENERGY) > TOWER_ENERGY.ATTACK_RESERVE) {
                tower.heal(target);
                healed = true;
            }
        }

        return healed;
    }

    /**
     * Repair damaged structures
     */
    private repairStructures(towers: StructureTower[], room: Room): void {
        const rcl = room.controller?.level ?? 1;

        // First priority: critical structures (not walls/ramparts)
        const criticalStructures = room.find(FIND_STRUCTURES, {
            filter: s => {
                if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) {
                    return false;
                }
                // Repair containers and roads at < 50%
                if (s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_ROAD) {
                    return s.hits < s.hitsMax * 0.5;
                }
                // Repair other structures at < 80%
                return s.hits < s.hitsMax * 0.8;
            }
        });

        if (criticalStructures.length > 0) {
            const target = this.selectRepairTarget(criticalStructures);
            this.repairWithTowers(towers, target, TOWER_ENERGY.REPAIR_MIN);
            return;
        }

        // Second priority: walls and ramparts (only if towers have plenty of energy)
        const wallTarget = WALL_TARGETS[rcl] ?? 10000;
        const fortifications = room.find(FIND_STRUCTURES, {
            filter: s => {
                if (s.structureType !== STRUCTURE_WALL && s.structureType !== STRUCTURE_RAMPART) {
                    return false;
                }
                return s.hits < wallTarget;
            }
        });

        if (fortifications.length > 0) {
            // Sort by hits ascending (repair lowest first for even distribution)
            const target = fortifications.sort((a, b) => a.hits - b.hits)[0];
            this.repairWithTowers(towers, target, TOWER_ENERGY.WALL_REPAIR_MIN);
        }
    }

    /**
     * Select the most critical structure to repair
     */
    private selectRepairTarget(structures: Structure[]): Structure {
        return structures.sort((a, b) => {
            // Sort by health percentage (lowest first)
            return (a.hits / a.hitsMax) - (b.hits / b.hitsMax);
        })[0];
    }

    /**
     * Repair a structure with towers that meet energy threshold
     */
    private repairWithTowers(towers: StructureTower[], target: Structure, energyThreshold: number): void {
        for (const tower of towers) {
            if (tower.store.getUsedCapacity(RESOURCE_ENERGY) > energyThreshold) {
                tower.repair(target);
            }
        }
    }

    /**
     * Calculate total tower damage potential at a position
     */
    getTowerDamageAtPos(room: Room, pos: RoomPosition): number {
        const towers = room.find(FIND_MY_STRUCTURES, {
            filter: (s): s is StructureTower =>
                s.structureType === STRUCTURE_TOWER &&
                s.store.getUsedCapacity(RESOURCE_ENERGY) > TOWER_ENERGY.ATTACK_MIN
        });

        let totalDamage = 0;
        for (const tower of towers) {
            const range = tower.pos.getRangeTo(pos);
            // Tower damage formula: 600 at range ≤5, decreasing to 150 at range ≥20
            if (range <= 5) {
                totalDamage += 600;
            } else if (range >= 20) {
                totalDamage += 150;
            } else {
                totalDamage += 600 - (range - 5) * 30;
            }
        }

        return totalDamage;
    }
}

// Singleton instance
const towerManagerInstance = new TowerManager();

export const towerManagerModule = () => {
    for (const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if (room.controller?.my) {
            towerManagerInstance.run(room);
        }
    }
};

export const towerManager = towerManagerInstance;
