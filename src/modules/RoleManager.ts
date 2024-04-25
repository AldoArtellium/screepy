import Harvester from './roles/Harvester';
import Builder from './roles/Builder';
import Upgrader from './roles/Upgrader';
import Defender from './roles/Defender';
import Hauler from './roles/Hauler';
import Claimer from './roles/Claimer';
import Miner from './roles/Miner';

export const roleManagerModule = () => {
    _.forEach(Game.creeps, (creep) => {
        if (creep.spawning) return;

        switch (creep.memory.role) {
            case 'harvester': Harvester.run(creep); break;
            case 'builder': Builder.run(creep); break;
            case 'upgrader': Upgrader.run(creep); break;
            case 'defender': Defender.run(creep); break;
            case 'hauler': Hauler.run(creep); break;
            case 'claimer': Claimer.run(creep); break;
            case 'miner': Miner.run(creep); break;
            default: console.error('Unhandled role:', creep.memory.role);
        }
    });
}
