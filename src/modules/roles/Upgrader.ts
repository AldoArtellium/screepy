class Upgrader {
    public static run(creep: Creep) {
        if (creep.memory.state === 'loading') {
            if (creep.store.getFreeCapacity() > 0) {
                // if there is Memory.rooms[creep.room].sources[all].miners else mine
                
                const miners = _.filter(Game.creeps, (creep) => creep.memory.role === 'miner');

                if (miners.length > 0) {
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
                    const source = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE);
                    if (source) {
                        if (creep.harvest(source) === ERR_NOT_IN_RANGE) {
                            creep.moveTo(source);
                        }
                    }
                }
            } else {
                creep.memory.state = 'unloading';
            }
        } else if (creep.memory.state === 'unloading') {
            if (creep.store.getUsedCapacity() === 0) {
                creep.memory.state = 'loading';
            } else {
                const controller = creep.room.controller;
                if (controller) {
                    if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
                        creep.moveTo(controller);
                    }

                    if (creep.store.getUsedCapacity() === 0) {
                        creep.memory.state = 'loading';
                    }
                }
            }
        } else {
            creep.memory.state = 'loading';
        }
    }
}

export default Upgrader;
