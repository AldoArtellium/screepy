class Builder {
    public static run(creep: Creep) {
        if (creep.memory?.state && creep.store[RESOURCE_ENERGY] === 0) {
            creep.memory.state = false;
        }
        if (!creep.memory.state && creep.store.getFreeCapacity() === 0) {
            creep.memory.state = true;
        }

        if (creep.memory.state) {
            const extensions = creep.room.find(FIND_CONSTRUCTION_SITES, {
                filter: (structure) => {
                    return structure.structureType === STRUCTURE_EXTENSION;
                }
            }) as ConstructionSite[];
            // sort Construction Sites by most progress
            extensions.sort((a) => a.progress);
            
            if (extensions.length) {
                if (creep.build(extensions[0]) === ERR_NOT_IN_RANGE) {
                    creep.moveTo(extensions[0], { visualizePathStyle: { stroke: '#ffffff' } });
                }
            } else {
                const targets = creep.room.find(FIND_CONSTRUCTION_SITES);
                // sort construction sites by progress
                targets.sort((a) => a.progress);
                if (targets.length) {
                    if (creep.build(targets[0]) === ERR_NOT_IN_RANGE) {
                        creep.moveTo(targets[0], { visualizePathStyle: { stroke: '#ffffff' } });
                    }
                } else {
                    // If there are no construction sites, start repairing
                    const structures = creep.room.find(FIND_STRUCTURES, {
                        filter: (structure) => {
                            return structure.hits < structure.hitsMax;
                        }
                    }) as Structure[];
                    // sort structures by least hits
                    structures.sort((a) => a.hits);
                    
                    if (structures.length) {
                        if (creep.repair(structures[0]) === ERR_NOT_IN_RANGE) {
                            creep.moveTo(structures[0], { visualizePathStyle: { stroke: '#ffffff' } });
                        }
                    }
                }
            }
        } else {
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
        }
    }
}

export default Builder;