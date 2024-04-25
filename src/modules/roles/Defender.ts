class Defender {
    public static run(creep: Creep) {
        const targets = creep.room.find(FIND_HOSTILE_CREEPS);
        if (targets.length > 0) {
            if (creep.attack(targets[0]) === ERR_NOT_IN_RANGE) {
                creep.moveTo(targets[0], { visualizePathStyle: { stroke: '#ff0000' } });
            }
        } else {
            // Recycle the creep
            if ((creep.room.memory.threatLevelLastTick ?? 0) > Game.time - 300) {
                const spawn = creep.room.find(FIND_MY_SPAWNS)[0];
                creep.say('Recycle');
                if (spawn.recycleCreep(creep) === ERR_NOT_IN_RANGE) {
                    creep.moveTo(spawn);
                }
            }
        }
    }
}

export default Defender;