

export function findCreepsByRole(room : Room, role : string) {
    return room.find(FIND_MY_CREEPS, {
        filter: (creep) => {
            return creep.memory.role == role;
        }
    });
}

export function findStructures(room : Room, types : string[]) {
    return room.find(FIND_STRUCTURES, {
        filter: (structure) => {
            for (const type in types) {
                return structure.structureType == types[type]
            }
        }
    });
}