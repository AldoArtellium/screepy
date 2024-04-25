class Miner {
    public static run(creep: Creep) {
        if (!creep.memory.targetId) {
            const roomMemory = Memory.rooms[creep.room.name] || {};
            const sources = roomMemory.sources || {} as { [id: Id<Source>]: { miners: string[] } };
            const sourceIds = Object.keys(sources) as Id<Source>[];
            let targetId: Id<Source> | undefined;
            let minMiners = Infinity;

            for (const sourceId of sourceIds) {
                const miners = sources[sourceId].miners || [];
                if (miners.length < minMiners) {
                    minMiners = miners.length;
                    targetId = sourceId;
                }
            }

            if (targetId) {
                sources[targetId].miners.push(creep.name);
                creep.memory.targetId = targetId;
            }

        } else if (creep.memory.targetId) {
            const source = Game.getObjectById(creep.memory.targetId) as Source;

            if (source) {
                const container = source.pos.findInRange(FIND_STRUCTURES, 1, {
                    filter: (structure) => structure.structureType === STRUCTURE_CONTAINER
                })[0];

                if (container) {
                    if (creep.pos.isEqualTo(container.pos)) {
                        if (creep.harvest(source) === ERR_NOT_IN_RANGE) {
                            creep.moveTo(source);
                        }
                    } else {
                        creep.moveTo(container);
                    }
                } else {
                    if (creep.harvest(source) === ERR_NOT_IN_RANGE) {
                        creep.moveTo(source);
                    }
                }
            }
        }
    }
}

export default Miner;
