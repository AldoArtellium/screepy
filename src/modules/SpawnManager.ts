interface CreepSpawnInfo {
    role: string;
    body: BodyPartConstant[];
    memory: CreepMemory;
    priority: number;
}

class SpawnManager {
    private spawnQueue: CreepSpawnInfo[] = [];

    private getCreepPriority(role: string): number {
        const priorities: { [key: string]: number } = {
            harvester: 0,
            builder: 2,
            upgrader: 1,
            defender: 2,
            miner: 0,
            hauler: 1,
            claimer: 3,
        };

        return priorities[role] ?? 0;
    }

    private updateDesiredCounts() {
        const counts = _.countBy(Game.creeps, creep => creep.memory.role);
        const sourcesLength = _.sum(Game.rooms, room => Object.keys(room.memory.sources).length ?? 0);

        Memory.spawn.desiredCounts = {
            harvester: Object.keys(Game.creeps).length < 2 ? 1 : 0,
            builder: (counts.builder ?? 0) < 1 ? 2 - (counts.builder ?? 0) : 0,
            upgrader: (counts.upgrader ?? 0) < 5 ? 5 - (counts.upgrader ?? 0) : 0,
            defender: _.sum(Game.rooms, room => ((room.memory.threatLevel ?? 0) > 0 &&  Game.time - (room.memory.threatLevelLastTick ?? 0) < 300) ? 2 : 0),
            miner: (counts.miner ?? 0) < sourcesLength ? sourcesLength - (counts.miner ?? 0) : 0,
            hauler: (counts.hauler ?? 0) < (counts.miner ?? 0) ? (counts.miner ?? 0) - (counts.hauler ?? 0) : 0,
            claimer: 0,
        };
    }

    private determineBodyParts(role: string, energyAvailable: number, energyCapacityAvailable: number): BodyPartConstant[] {
        if (energyAvailable < 200) {
            return [WORK, CARRY, MOVE];
        } else {
            energyAvailable = Math.max(energyAvailable, energyCapacityAvailable);
        }

        const configurations: { [key: string]: (energy: number) => BodyPartConstant[] } = {
            harvester: energy => [WORK, CARRY, MOVE, MOVE],
            builder: energy => Array(Math.floor(energy / 200)).fill(WORK).concat([CARRY, MOVE]),
            upgrader: energy => Array(Math.floor(energy / 200)).fill(WORK).concat([CARRY, MOVE]),
            defender: energy => Array(Math.floor(energy / 200)).fill(TOUGH).concat([ATTACK, MOVE]),
            miner: energy => Array(Math.floor(energy / 200)).fill(WORK).concat([MOVE]),
            hauler: energy => Array(Math.floor(energy / 150)).fill(CARRY).concat([MOVE, MOVE]),
            claimer: energy => [CLAIM, MOVE],
        };
        
        return configurations[role] ? configurations[role](energyAvailable) : [WORK, CARRY, MOVE];
    }

    private populateSpawnQueue() {
        this.updateDesiredCounts();
        this.spawnQueue = [];
        _.forEach(Memory.spawn.desiredCounts, (count, role) => {
            if (count > 0) {
                role = role || '';
                if (role === '') {
                    console.error('Role is undefined');
                } else {
                    const room = _.max(Object.values(Game.rooms), 'energyAvailable');
                    const body = this.determineBodyParts(role, room.energyAvailable, room.energyCapacityAvailable);
                    const memory = { role: role, working: false };
                    this.spawnQueue.push({ role: role, body, memory, priority: this.getCreepPriority(role)});
                }
            }
        });

        this.spawnQueue.sort((a, b) => a.priority - b.priority);
    }

    private processSpawnQueue() {
        const spawn = _.find(Game.spawns, s => !s.spawning);
        if (spawn && this.spawnQueue.length > 0) {
            const { role, body, memory } = this.spawnQueue.shift()!;
            const newName = `${role}-${Game.time}`;
            const result = spawn.spawnCreep(body, newName, { memory });
            if (result === OK) {
                console.log(`Spawning new ${role}: ${newName}`);
            }
        }
    }

    public manageSpawns() {
        this.populateSpawnQueue();
        this.processSpawnQueue();
    }
}

export const spawnManagerModule = () => {
    const spawnManager = new SpawnManager();
    spawnManager.manageSpawns();
}
