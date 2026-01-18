/**
 * TowerManager - Tower defense and maintenance
 * Defense mode behavior:
 * - Focus on attack only (skip repairs to maximize damage)
 * Normal mode:
 * - Attack > Heal > Repair priority
 */
class TowerManager {
    static run(room: Room) {
        const towers = room.find(FIND_MY_STRUCTURES, {
            filter: { structureType: STRUCTURE_TOWER }
        }) as StructureTower[];

        if (towers.length === 0) return;

        const defenseMode = room.memory.defenseMode ?? false;
        const hostiles = room.find(FIND_HOSTILE_CREEPS);

        // Attack hostiles (highest priority in any mode)
        if (hostiles.length > 0) {
            const priorityTarget = this.findPriorityTarget(hostiles);
            for (const tower of towers) {
                if (tower.store.getUsedCapacity(RESOURCE_ENERGY) > 10) {
                    tower.attack(priorityTarget);
                }
            }
            return;
        }

        // In defense mode, only attack - skip healing and repairs
        if (defenseMode) return;

        // Heal damaged creeps
        const damagedCreeps = room.find(FIND_MY_CREEPS, {
            filter: c => c.hits < c.hitsMax
        });

        if (damagedCreeps.length > 0) {
            // Heal most damaged creep
            const mostDamaged = damagedCreeps.sort((a, b) => a.hits - b.hits)[0];
            for (const tower of towers) {
                if (tower.store.getUsedCapacity(RESOURCE_ENERGY) > 100) {
                    tower.heal(mostDamaged);
                }
            }
            return;
        }

        // Repair structures (only if energy is high)
        const criticalStructures = room.find(FIND_STRUCTURES, {
            filter: s => {
                // Don't repair walls/ramparts with towers (too expensive)
                if (s.structureType === STRUCTURE_WALL || s.structureType === STRUCTURE_RAMPART) {
                    return false;
                }
                // Repair containers and roads that are < 50% health
                if (s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_ROAD) {
                    return s.hits < s.hitsMax * 0.5;
                }
                // Repair other structures at < 80%
                return s.hits < s.hitsMax * 0.8;
            }
        });

        if (criticalStructures.length > 0) {
            // Repair most damaged structure
            const mostDamaged = criticalStructures.sort((a, b) => a.hits / a.hitsMax - b.hits / b.hitsMax)[0];
            for (const tower of towers) {
                // Only use towers with plenty of energy for repairs
                if (tower.store.getUsedCapacity(RESOURCE_ENERGY) > 500) {
                    tower.repair(mostDamaged);
                }
            }
        }
    }

    static findPriorityTarget(hostiles: Creep[]): Creep {
        // Prioritize targets: healers > ranged attackers > melee attackers > others
        return hostiles.sort((a, b) => {
            const aPoints = this.evaluateThreatLevel(a);
            const bPoints = this.evaluateThreatLevel(b);
            // If threat levels are equal, prioritize lower health targets
            if (aPoints === bPoints) {
                return a.hits - b.hits;
            }
            return bPoints - aPoints;
        })[0];
    }

    static evaluateThreatLevel(creep: Creep): number {
        let threatLevel = 0;
        for (const part of creep.body) {
            switch (part.type) {
                case HEAL:
                    threatLevel += 12; // Healers are highest priority
                    break;
                case RANGED_ATTACK:
                    threatLevel += 8; // Ranged attackers can hit from safety
                    break;
                case ATTACK:
                    threatLevel += 5; // Melee attackers
                    break;
                case WORK:
                    threatLevel += 3; // Can dismantle structures
                    break;
                case CLAIM:
                    threatLevel += 15; // Can attack controller
                    break;
                case TOUGH:
                    threatLevel += 1; // Indicates well-designed creep
                    break;
            }
        }
        return threatLevel;
    }
}

export const towerManagerModule = () => {
    for (const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if (room.controller?.my) {
            TowerManager.run(room);
        }
    }
};
