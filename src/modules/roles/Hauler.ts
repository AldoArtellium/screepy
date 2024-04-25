class Hauler {
    public static run(creep: Creep) {
        if (creep.store.getUsedCapacity() === 0) {
            const containers = creep.room.find(FIND_STRUCTURES, {
                filter: s => s.structureType === STRUCTURE_CONTAINER &&
                            s.store.getUsedCapacity(RESOURCE_ENERGY) > 200
            });
            if (containers.length > 0 && creep.withdraw(containers[0], RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                creep.moveTo(containers[0]);
            } else {
                const droppedResources = creep.room.find(FIND_DROPPED_RESOURCES, {
                    filter: r => r.resourceType === RESOURCE_ENERGY
                });
                if (droppedResources.length > 0 && creep.pickup(droppedResources[0]) === ERR_NOT_IN_RANGE) {
                    creep.moveTo(droppedResources[0]);
                }
            }
        } else {
            const targets = creep.room.find(FIND_MY_STRUCTURES, {
                filter: s => (s.structureType === STRUCTURE_EXTENSION ||
                             s.structureType === STRUCTURE_SPAWN ||
                             s.structureType === STRUCTURE_TOWER) &&
                            s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
            });
            if (targets.length > 0 && creep.transfer(targets[0], RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                creep.moveTo(targets[0], { visualizePathStyle: { stroke: '#ffffff' } });
            } else {
                // Move near the spawn
                const spawn = creep.room.find(FIND_MY_SPAWNS)[0];
                if (spawn) {
                    if (!creep.pos.inRangeTo(spawn, 3)) {
                        creep.moveTo(spawn);
                    }
                    if (creep.pos.isNearTo(spawn)) {
                        const directions = [TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT];
                        const direction = directions[Math.floor(Math.random() * directions.length)];
                        creep.move(direction);
                    }
                }
            }
        }
    }
}

export default Hauler;