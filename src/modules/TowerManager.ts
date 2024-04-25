class TowerManager {
    static run(room: Room) {
        const towers = room.find(FIND_MY_STRUCTURES, {
            filter: { structureType: STRUCTURE_TOWER }
        }) as StructureTower[];

        if (towers.length > 0) {
            const hostiles = room.find(FIND_HOSTILE_CREEPS);
            if (hostiles.length > 0) {
                const priorityTarget = this.findPriorityTarget(hostiles);
                towers.forEach(tower => {
                    if (tower.store.getUsedCapacity(RESOURCE_ENERGY) > 10) {
                        tower.attack(priorityTarget);
                    }
                });
            }
        }
    }

    static findPriorityTarget(hostiles: Creep[]): Creep {
        // Prioritize targets: healers > attackers > others
        const target = hostiles.sort((a, b) => {
            const aPoints = this.evaluateThreatLevel(a);
            const bPoints = this.evaluateThreatLevel(b);
            return bPoints - aPoints;
        })[0];
        return target;
    }

    static evaluateThreatLevel(creep: Creep): number {
        let threatLevel = 0;
        creep.body.forEach(part => {
            if (part.type === HEAL) {
                threatLevel += 10; // Healers are high priority
            }
            if (part.type === ATTACK || part.type === RANGED_ATTACK) {
                threatLevel += 5; // Attackers are medium priority
            }
        });
        return threatLevel;
    }
}

export const towerManagerModule = () => {
    const rooms = Game.rooms;
    for (const room in rooms) {
        TowerManager.run(rooms[room]);
    }
};