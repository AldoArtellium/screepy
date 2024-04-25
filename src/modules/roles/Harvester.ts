type CreepAction = 'withdraw' | 'transfer' | 'pickup' | 'harvest';

class Harvester {
    static run(creep: Creep) {
        if (creep.store.getFreeCapacity() === 0) {
            creep.memory.state = 'working';
        } else if (creep.store.getUsedCapacity() === 0) {
            creep.memory.state = 'idle';
        }

        if (creep.memory.state !== 'working') {
            this.harvestEnergy(creep);
        } else {
            this.deliverEnergy(creep);
        }
    }

    static harvestEnergy(creep: Creep) {
        // Attempt to withdraw from containers
        const container = creep.pos.findClosestByPath(FIND_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_CONTAINER &&
                         s.store.getUsedCapacity(RESOURCE_ENERGY) > 200
        });
        if (container) {
            this.moveToAndInteract(creep, container, 'withdraw', RESOURCE_ENERGY);
            return;
        }

        // Attempt to pick up dropped resources
        const droppedResource = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
            filter: r => r.resourceType === RESOURCE_ENERGY
        });
        if (droppedResource) {
            this.moveToAndInteract(creep, droppedResource, 'pickup');
            return;
        }

        // Harvest from the most energy-rich source
        const source = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE);
        if (source) {
            this.moveToAndInteract(creep, source, 'harvest');
        }
    }

    static deliverEnergy(creep: Creep) {
        // Deliver to closest needy structure
        const target = creep.pos.findClosestByPath(FIND_STRUCTURES, {
            filter: s => (s.structureType === STRUCTURE_SPAWN ||
                          s.structureType === STRUCTURE_EXTENSION ||
                          s.structureType === STRUCTURE_TOWER ||
                          s.structureType === STRUCTURE_STORAGE) &&
                         s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
        });
        if (target) {
            this.moveToAndInteract(creep, target, 'transfer', RESOURCE_ENERGY);
            return;
        }

        // No valid target found, set to idle
        creep.memory.state = 'idle';
    }

    static moveToAndInteract(creep: Creep, target: Structure | Resource | Source, action: CreepAction, resourceType: ResourceConstant = RESOURCE_ENERGY) {
        let actionResult: ScreepsReturnCode;

        switch (action) {
            case 'withdraw':
            case 'transfer':
                actionResult = creep[action](target as Structure<StructureConstant>, resourceType);
                break;
            case 'pickup':
            case 'harvest':
                actionResult = creep[action](target as any);
                break;
            default:
                throw new Error(`Invalid action: ${action}`);
        }

        if (actionResult === ERR_NOT_IN_RANGE) {
            creep.memory.state = 'moving';
            creep.moveTo(target, { visualizePathStyle: { stroke: '#ffaa00' } });
        } else if (actionResult === OK) {
            creep.memory.state = 'working';
        } else {
            creep.memory.state = 'error'; // Handle unexpected results
        }
    }
}

export default Harvester;
