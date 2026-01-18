import { ENERGY_THRESHOLDS } from "./creepUtils";

export function findCreepsByRole(room: Room, role: string) {
    return room.find(FIND_MY_CREEPS, {
        filter: (creep) => {
            return creep.memory.role == role;
        }
    });
}

export function findStructures(room: Room, types: StructureConstant[]) {
    return room.find(FIND_STRUCTURES, {
        filter: (structure) => {
            return types.includes(structure.structureType);
        }
    });
}

/**
 * Get the first spawn in a room
 */
export function getSpawn(room: Room): StructureSpawn | undefined {
    return room.find(FIND_MY_SPAWNS)[0];
}

/**
 * Find containers with energy above a minimum threshold
 */
export function findEnergyContainers(
    room: Room,
    minEnergy = ENERGY_THRESHOLDS.CONTAINER_MIN
): StructureContainer[] {
    return room.find(FIND_STRUCTURES, {
        filter: (s): s is StructureContainer =>
            s.structureType === STRUCTURE_CONTAINER &&
            s.store.getUsedCapacity(RESOURCE_ENERGY) > minEnergy
    });
}

/**
 * Find dropped energy resources above a minimum amount
 */
export function findDroppedEnergy(
    room: Room,
    minAmount = ENERGY_THRESHOLDS.DROPPED_MIN
): Resource<RESOURCE_ENERGY>[] {
    return room.find(FIND_DROPPED_RESOURCES, {
        filter: (r): r is Resource<RESOURCE_ENERGY> =>
            r.resourceType === RESOURCE_ENERGY && r.amount > minAmount
    });
}

/**
 * Find structures that need energy (spawns, extensions, towers)
 */
export function findStructuresNeedingEnergy(room: Room): AnyOwnedStructure[] {
    return room.find(FIND_MY_STRUCTURES, {
        filter: (s): s is StructureSpawn | StructureExtension | StructureTower =>
            (s.structureType === STRUCTURE_SPAWN ||
             s.structureType === STRUCTURE_EXTENSION ||
             s.structureType === STRUCTURE_TOWER) &&
            s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
    });
}

/**
 * Find a container adjacent to a source
 */
export function findSourceContainer(source: Source): StructureContainer | undefined {
    return source.pos.findInRange(FIND_STRUCTURES, 1, {
        filter: (s): s is StructureContainer => s.structureType === STRUCTURE_CONTAINER
    })[0];
}

/**
 * Find a container construction site adjacent to a source
 */
export function findSourceContainerSite(source: Source): ConstructionSite | undefined {
    return source.pos.findInRange(FIND_CONSTRUCTION_SITES, 1, {
        filter: (s): s is ConstructionSite => s.structureType === STRUCTURE_CONTAINER
    })[0];
}

/**
 * Ensure room memory is properly initialized
 */
export function ensureRoomMemory(roomName: string): RoomMemory {
    if (!Memory.rooms) {
        Memory.rooms = {};
    }
    if (!Memory.rooms[roomName]) {
        Memory.rooms[roomName] = {
            sources: {},
            constructionSites: {}
        };
    }
    // Ensure sources object exists even if room memory was created elsewhere
    if (!Memory.rooms[roomName].sources) {
        Memory.rooms[roomName].sources = {};
    }
    return Memory.rooms[roomName];
}
