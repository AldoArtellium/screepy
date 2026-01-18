import { log, LogLevel } from "../utils/logger";

class MemoryManager {
    init(): void {
        this.initializeMemory();
    }

    private initializeMemory(): void {
        if (Memory.logLevel === undefined) {
            Memory.logLevel = LogLevel.DEBUG;
        }
        if (!Memory.rooms) {
            Memory.rooms = {};
            log.debug("MemoryManager", "Initializing memory.rooms");
        }
        if (!Memory.creeps) {
            Memory.creeps = {};
            log.debug("MemoryManager", "Initializing memory.creeps");
        }
        if (!Memory.spawn || !Memory.spawn.desiredCounts) {
            Memory.spawn = {
                desiredCounts: {
                    miner: 2,
                    hauler: 4,
                    harvester: 0,
                    builder: 1,
                    upgrader: 4,
                    defender: 0
                },
                currentCounts: {
                    miner: 0,
                    hauler: 0,
                    harvester: 0,
                    builder: 0,
                    upgrader: 0,
                    defender: 0,
                    claimer: 0
                }
            };
            log.debug("MemoryManager", "Initializing memory.spawn");
        }
        if (!Memory.init) {
            this.initializeRooms();
            log.debug("MemoryManager", "Memory structure set up completed");
            Memory.init = true;
        }
    }

    private initializeRooms(): void {
        for (const roomName in Game.rooms) {
            log.debug("MemoryManager", `Checking initialization for room ${roomName}`);
            const room = Game.rooms[roomName];
            if (room) {
                this.initRoom(room);
            } else if (Memory.rooms[roomName]) {
                log.debug("MemoryManager", `Deleting memory for non-existent room: ${roomName}`);
                delete Memory.rooms[roomName];
            }
        }
    }

    private initRoom(room: Room): void {
        Memory.rooms[room.name] = {
            sources: {},
            constructionSites: {},
            threatLevel: 0,
            threatLevelLastTick: 0,
            phase: 0, // Start in EMERGENCY phase
            defenseMode: false,
            phaseData: {
                lastEvaluation: Game.time,
                extensionsPlanned: false,
                roadsPlanned: false
            },
            taskQueue: {
                tasks: {},
                byPriority: [],
                lastSort: Game.time,
                lastGeneration: 0
            }
        };
    }

    refresh(): void {
        if (!Memory.init) {
            log.debug("MemoryManager", "Memory not initialized, skipping refresh");
            return;
        }
        Object.keys(Game.rooms).forEach(roomName => this.refreshRoom(roomName));
        Object.keys(Memory.creeps).forEach(creepName => this.refreshCreep(creepName));
    }

    private refreshCreep(creepName: string): void {
        if (!Game.creeps[creepName]) {
            log.debug("MemoryManager", `Deleting memory for non-existent creep: ${creepName}`);
            delete Memory.creeps[creepName];
        }
    }

    private refreshRoom(roomName: string): void {
        const room = Game.rooms[roomName];
        if (!room) {
            log.debug("MemoryManager", `Deleting memory for non-existent room: ${roomName}`);
            delete Memory.rooms[roomName];
            return;
        }

        // Ensure phase memory exists (migration for existing rooms)
        this.ensurePhaseMemory(room);

        this.handleSources(room);
        this.handleHostiles(room);
        this.manageConstructionSites(room);
    }

    private ensurePhaseMemory(room: Room): void {
        if (room.memory.phase === undefined) {
            room.memory.phase = 0;
        }
        if (room.memory.defenseMode === undefined) {
            room.memory.defenseMode = false;
        }
        if (!room.memory.phaseData) {
            room.memory.phaseData = {
                lastEvaluation: Game.time,
                extensionsPlanned: false,
                roadsPlanned: false
            };
        }
        // Initialize task queue for migration
        if (!room.memory.taskQueue) {
            room.memory.taskQueue = {
                tasks: {},
                byPriority: [],
                lastSort: Game.time,
                lastGeneration: 0
            };
        }
        // Ensure sources object exists (migration for existing rooms)
        if (!room.memory.sources) {
            room.memory.sources = {};
        }
    }

    private handleSources(room: Room): void {
        room.find(FIND_SOURCES).forEach(source => {
            const sourceMemory = Memory.rooms[room.name].sources[source.id] || {
                distance: 0,
                miners: []
            };
            sourceMemory.miners = sourceMemory.miners.filter(miner => !!Game.creeps[miner]);

            // Validate container reference still exists
            if (sourceMemory.container) {
                const container = Game.getObjectById(sourceMemory.container);
                if (!container) {
                    delete sourceMemory.container;
                }
            }

            // Check if containerSite completed (site gone but container now exists)
            if (sourceMemory.containerSite) {
                const site = Game.getObjectById(sourceMemory.containerSite);
                if (!site) {
                    // Site is gone, check if container now exists
                    const container = source.pos.findInRange(FIND_STRUCTURES, 1, {
                        filter: (structure) => structure.structureType === STRUCTURE_CONTAINER
                    })[0] as StructureContainer | undefined;

                    if (container) {
                        sourceMemory.container = container.id;
                    }
                    delete sourceMemory.containerSite;
                }
            }

            Memory.rooms[room.name].sources[source.id] = sourceMemory;
        });
    }

    private handleHostiles(room: Room): void {
        const isSimServer = !Game.shard || Game.shard.name === "sim";
        const hostiles = room.find(FIND_HOSTILE_CREEPS, {
            filter: (creep) => {
                // Ignore Source Keepers on sim server only
                if (isSimServer && creep.owner.username === "Source Keeper") {
                    return false;
                }
                return true;
            }
        });
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

// Singleton instance for better performance
const memoryManagerInstance = new MemoryManager();

export const memoryManagerModule = {
    init: () => {
        memoryManagerInstance.init();
    },
    refresh: () => {
        memoryManagerInstance.refresh();
    },
};
