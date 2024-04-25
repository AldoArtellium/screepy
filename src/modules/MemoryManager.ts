
class MemoryManager {
    public init(): void {
        this.initializeMemory();
    }

    private initializeMemory(): void {
        if (!Memory.rooms) {
            Memory.rooms = {};
            console.log('Initializing memory.rooms');
        }
        if (!Memory.creeps) {
            Memory.creeps = {};
            console.log('Initializing memory.creeps');
        }
        if (!Memory.spawn || !Memory.spawn.desiredCounts) {
            Memory.spawn = { desiredCounts: {
                miner: 2,
                hauler: 4,
                harvester: 0,
                builder: 1,
                upgrader: 4,
                defender: 0
            }};
            console.log('Initializing memory.spawn');
        }
        if (!Memory.init) {
            this.initializeRooms();
            console.log('Memory structure set up completed');
            Memory.init = true;
        }
    }

    private initializeRooms(): void {
        for (const roomName in Game.rooms) {
            console.log(`Checking initialization for room ${roomName}`);
            const room = Game.rooms[roomName];
            if (room) {
                this.initRoom(room);
            } else if (Memory.rooms[roomName]) {
                console.log(`Deleting memory for non-existent room: ${roomName}`);
                delete Memory.rooms[roomName];
            }
        }
    }

    private initRoom(room: Room): void {
        Memory.rooms[room.name] = {
            sources: {},
            constructionSites: {},
            threatLevel: 0,
            threatLevelLastTick: 0
        };
    }

    public refresh(): void {
        if (!Memory.init) {
            console.log('Memory not initialized, skipping refresh');
            return;
        }
        Object.keys(Game.rooms).forEach(roomName => this.refreshRoom(roomName));
        Object.keys(Game.creeps).forEach(creepName => this.refreshCreep(creepName));
    }

    private refreshCreep(creepName: string): void {
        if (!Game.creeps[creepName]) {
            console.log(`Deleting memory for non-existent creep: ${creepName}`);
            delete Memory.creeps[creepName];
        }
    }

    private refreshRoom(roomName: string): void {
        const room = Game.rooms[roomName];
        if (!room) {
            console.log(`Deleting memory for non-existent room: ${roomName}`);
            delete Memory.rooms[roomName];
            return;
        }

        this.handleSources(room);
        this.handleHostiles(room);
        this.manageConstructionSites(room);
    }

    private handleSources(room: Room): void {
        room.find(FIND_SOURCES).forEach(source => {
            const sourceMemory = Memory.rooms[room.name].sources[source.id] || {
                distance: 0,
                miners: []
            };
            sourceMemory.miners = sourceMemory.miners.filter(miner => !!Game.creeps[miner]);
            Memory.rooms[room.name].sources[source.id] = sourceMemory;
        });
    }

    private handleHostiles(room: Room): void {
        const hostiles = room.find(FIND_HOSTILE_CREEPS);
        const threatLevel = hostiles.reduce((acc, hostile) => acc + hostile.hits, 0);
        if (hostiles.length > 0) {
            Memory.rooms[room.name].threatLevel = threatLevel;
            Memory.rooms[room.name].threatLevelLastTick = Game.time;
        }
    }

    private manageConstructionSites(room: Room): void {
        const constructionSites = room.find(FIND_CONSTRUCTION_SITES);
        constructionSites.forEach(site => {
            Memory.rooms[room.name].constructionSites[site.id] = true;
        });

        Object.keys(Memory.rooms[room.name].constructionSites).forEach(siteId => {
            if (!constructionSites.some(site => site.id === siteId)) {
                delete Memory.rooms[room.name].constructionSites[siteId as Id<ConstructionSite>];
            }
        });
    }
}

export const memoryManagerModule = {
    init: () => {
        const memoryManager = new MemoryManager();
        memoryManager.init();
    },
    refresh: () => {
        const memoryManager = new MemoryManager();
        memoryManager.refresh();
    },
}