/**
 * RoomManager - Unified room management module
 * Handles memory initialization, phase evaluation, and defense mode.
 */

import { log, LogLevel } from "../utils/logger";

/**
 * RCL-based extension limits from Screeps documentation
 */
export const RCL_EXTENSION_LIMITS: { [rcl: number]: number } = {
    0: 0,
    1: 0,
    2: 5,
    3: 10,
    4: 20,
    5: 30,
    6: 40,
    7: 50,
    8: 60
};

/**
 * Phase transition thresholds
 */
const PHASE_TRANSITION = {
    UP_THRESHOLD: 50,
    DOWN_THRESHOLD: 20,
    EVAL_INTERVAL: 10
};

/**
 * Defense mode configuration
 */
const DEFENSE_CONFIG = {
    DEACTIVATION_DELAY: 300
};

/**
 * Get phase name for display
 */
export function getPhaseName(phase: number): string {
    const names: Record<number, string> = {
        0: "EMERGENCY",
        1: "BOOTSTRAP",
        2: "FOUNDATION",
        3: "EXPANSION",
        4: "ESTABLISHED",
        5: "ADVANCED",
        6: "DOMINANT"
    };
    return names[phase] ?? "UNKNOWN";
}

class RoomManager {
    /**
     * Initialize global memory structure (runs once)
     */
    init(): void {
        if (Memory.logLevel === undefined) {
            Memory.logLevel = LogLevel.DEBUG;
        }
        if (!Memory.rooms) {
            Memory.rooms = {};
            log.debug("RoomManager", "Initializing memory.rooms");
        }
        if (!Memory.creeps) {
            Memory.creeps = {};
            log.debug("RoomManager", "Initializing memory.creeps");
        }
        if (!Memory.spawn) {
            Memory.spawn = {};
            log.debug("RoomManager", "Initializing memory.spawn");
        }
        if (!Memory.init) {
            this.initializeRooms();
            log.debug("RoomManager", "Memory structure set up completed");
            Memory.init = true;
        }
    }

    private initializeRooms(): void {
        for (const roomName in Game.rooms) {
            log.debug("RoomManager", `Checking initialization for room ${roomName}`);
            const room = Game.rooms[roomName];
            if (room) {
                this.initRoom(room);
            } else if (Memory.rooms[roomName]) {
                log.debug("RoomManager", `Deleting memory for non-existent room: ${roomName}`);
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
            phase: 0,
            defenseMode: false,
            phaseData: {
                lastEvaluation: Game.time,
                extensionsPlanned: false,
                roadsPlanned: false
            },
            taskQueue: [],
            partDemand: {}
        };
    }

    /**
     * Main room management loop - runs every few ticks
     * Handles memory refresh, phase evaluation, and defense mode
     */
    run(): void {
        if (!Memory.init) {
            log.debug("RoomManager", "Memory not initialized, skipping run");
            return;
        }

        // Clean up dead creep memory
        for (const name in Memory.creeps) {
            if (!Game.creeps[name]) {
                log.debug("RoomManager", `Deleting memory for dead creep: ${name}`);
                delete Memory.creeps[name];
            }
        }

        // Process each room
        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];
            if (!room) {
                delete Memory.rooms[roomName];
                continue;
            }

            // Ensure room memory exists
            this.ensureRoomMemory(room);

            // Update room data
            this.updateSources(room);
            this.updateHostiles(room);
            this.updateConstructionSites(room);

            // For owned rooms, evaluate phase and defense
            if (room.controller?.my) {
                this.evaluatePhase(room);
                this.evaluateDefenseMode(room);
            }
        }
    }

    private ensureRoomMemory(room: Room): void {
        if (!Memory.rooms[room.name]) {
            this.initRoom(room);
            return;
        }

        const mem = Memory.rooms[room.name];
        if (mem.phase === undefined) mem.phase = 0;
        if (mem.defenseMode === undefined) mem.defenseMode = false;
        if (!mem.phaseData) {
            mem.phaseData = {
                lastEvaluation: Game.time,
                extensionsPlanned: false,
                roadsPlanned: false
            };
        }
        if (!mem.sources) mem.sources = {};
        if (!mem.taskQueue) mem.taskQueue = [];
        if (!mem.partDemand) mem.partDemand = {};
    }

    private updateSources(room: Room): void {
        if (!Memory.rooms[room.name].sources) {
            Memory.rooms[room.name].sources = {};
        }

        room.find(FIND_SOURCES).forEach(source => {
            const sourceMemory = Memory.rooms[room.name].sources[source.id] || {
                distance: 0,
                miners: []
            };
            sourceMemory.miners = sourceMemory.miners.filter(miner => !!Game.creeps[miner]);

            // Validate container reference
            if (sourceMemory.container) {
                const container = Game.getObjectById(sourceMemory.container);
                if (!container) {
                    delete sourceMemory.container;
                }
            }

            // Check if containerSite completed
            if (sourceMemory.containerSite) {
                const site = Game.getObjectById(sourceMemory.containerSite);
                if (!site) {
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

    private updateHostiles(room: Room): void {
        const isSimServer = !Game.shard || Game.shard.name === "sim";
        const hostiles = room.find(FIND_HOSTILE_CREEPS, {
            filter: (creep) => {
                if (isSimServer && creep.owner.username === "Source Keeper") {
                    return false;
                }
                // Ignore Invader NPC in early rooms (they're manageable)
                // Only if we have towers
                return true;
            }
        });

        if (hostiles.length > 0) {
            // Calculate threat level based on body composition, not just hits
            const threatLevel = this.calculateThreatLevel(hostiles);
            Memory.rooms[room.name].threatLevel = threatLevel;
            Memory.rooms[room.name].threatLevelLastTick = Game.time;

            // Check for safe mode trigger
            this.checkSafeModeTrigger(room, hostiles, threatLevel);
        }
    }

    /**
     * Calculate threat level based on hostile body composition
     */
    private calculateThreatLevel(hostiles: Creep[]): number {
        let threat = 0;

        const partThreat: Partial<Record<BodyPartConstant, number>> = {
            [HEAL]: 50,          // Healers are dangerous
            [RANGED_ATTACK]: 30, // Ranged damage
            [ATTACK]: 25,        // Melee damage
            [WORK]: 20,          // Can dismantle
            [CLAIM]: 100,        // Controller attack
            [TOUGH]: 5,          // Indicates boosted creep
            [CARRY]: 1,
            [MOVE]: 2
        };

        for (const hostile of hostiles) {
            let creepThreat = 0;

            for (const part of hostile.body) {
                if (part.hits <= 0) continue;

                const baseThreat = partThreat[part.type] ?? 1;
                // Boosted parts are 2.5x more dangerous
                const multiplier = part.boost ? 2.5 : 1;
                creepThreat += baseThreat * multiplier;
            }

            // Add bonus for high health
            creepThreat += hostile.hits / 50;

            threat += creepThreat;
        }

        return Math.floor(threat);
    }

    /**
     * Check if safe mode should be triggered
     */
    private checkSafeModeTrigger(room: Room, hostiles: Creep[], threatLevel: number): void {
        // Only check if we have safe mode available
        if (!room.controller || room.controller.safeMode || room.controller.safeModeAvailable === 0) {
            return;
        }

        // Check if spawn is at risk
        const spawns = room.find(FIND_MY_SPAWNS);
        if (spawns.length === 0) return;

        for (const spawn of spawns) {
            // Check spawn health
            if (spawn.hits < spawn.hitsMax * 0.3) {
                log.warn("RoomManager", `${room.name}: Spawn ${spawn.name} at ${Math.floor(spawn.hits / spawn.hitsMax * 100)}% - considering safe mode`);

                // Check if hostiles are near spawn
                const nearbyHostiles = spawn.pos.findInRange(hostiles, 3);
                if (nearbyHostiles.length > 0) {
                    // Calculate if we can defend
                    const towers = room.find(FIND_MY_STRUCTURES, {
                        filter: s => s.structureType === STRUCTURE_TOWER
                    }) as StructureTower[];

                    const towerDamage = towers.reduce((sum, t) => {
                        if (t.store.getUsedCapacity(RESOURCE_ENERGY) < 10) return sum;
                        const range = t.pos.getRangeTo(spawn);
                        if (range <= 5) return sum + 600;
                        if (range >= 20) return sum + 150;
                        return sum + (600 - (range - 5) * 30);
                    }, 0);

                    // If tower damage is low and spawn is critical, trigger safe mode
                    if (towerDamage < 500 && spawn.hits < spawn.hitsMax * 0.2) {
                        log.warn("RoomManager", `${room.name}: ACTIVATING SAFE MODE - Spawn under attack!`);
                        room.controller.activateSafeMode();
                        return;
                    }
                }
            }
        }

        // Check if all our ramparts/walls are breached
        const ramparts = room.find(FIND_MY_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_RAMPART
        });

        if (ramparts.length > 0) {
            const criticalRamparts = ramparts.filter(r => r.hits < 1000);
            const hostileNearBreach = hostiles.some(h => {
                return criticalRamparts.some(r => h.pos.getRangeTo(r) <= 2);
            });

            if (hostileNearBreach && threatLevel > 5000) {
                log.warn("RoomManager", `${room.name}: Ramparts breached with high threat - considering safe mode`);
            }
        }
    }

    private updateConstructionSites(room: Room): void {
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

    // ==================== Phase Management ====================

    private evaluatePhase(room: Room): void {
        const memory = room.memory;
        if (!memory.phaseData) {
            memory.phaseData = { lastEvaluation: Game.time };
        }

        const currentPhase = memory.phase ?? 0;
        const calculatedPhase = this.calculatePhase(room);

        // Immediate EMERGENCY transition
        if (calculatedPhase === 0 && currentPhase !== 0) {
            this.transitionPhase(room, 0);
            return;
        }

        // Faster EMERGENCY EXIT
        if (currentPhase === 0 && calculatedPhase > 0) {
            if (memory.phaseData.targetPhase !== undefined) {
                if (memory.phaseData.targetPhase === calculatedPhase) {
                    const ticksSinceStart = Game.time - (memory.phaseData.transitionTick ?? Game.time);
                    if (ticksSinceStart >= PHASE_TRANSITION.DOWN_THRESHOLD) {
                        this.transitionPhase(room, calculatedPhase);
                    }
                } else {
                    delete memory.phaseData.targetPhase;
                    delete memory.phaseData.transitionTick;
                }
            } else {
                memory.phaseData.targetPhase = calculatedPhase;
                memory.phaseData.transitionTick = Game.time;
            }
            memory.phaseData.lastEvaluation = Game.time;
            return;
        }

        // Normal phase transition with hysteresis
        if (memory.phaseData.targetPhase !== undefined) {
            if (memory.phaseData.targetPhase === calculatedPhase) {
                const ticksSinceStart = Game.time - (memory.phaseData.transitionTick ?? Game.time);
                const threshold = calculatedPhase > currentPhase
                    ? PHASE_TRANSITION.UP_THRESHOLD
                    : PHASE_TRANSITION.DOWN_THRESHOLD;

                if (ticksSinceStart >= threshold) {
                    this.transitionPhase(room, calculatedPhase);
                }
            } else {
                delete memory.phaseData.targetPhase;
                delete memory.phaseData.transitionTick;
            }
        } else if (calculatedPhase !== currentPhase) {
            memory.phaseData.targetPhase = calculatedPhase;
            memory.phaseData.transitionTick = Game.time;
        }

        memory.phaseData.lastEvaluation = Game.time;
    }

    private calculatePhase(room: Room): RoomPhase {
        const totalCreeps = room.find(FIND_MY_CREEPS).length;
        const rcl = room.controller?.level ?? 0;
        const hasAllContainers = this.hasAllSourceContainers(room);
        const extensionRatio = this.getExtensionRatio(room);
        const hasStorage = this.hasStructure(room, STRUCTURE_STORAGE);
        const hasTerminal = this.hasStructure(room, STRUCTURE_TERMINAL);

        if (totalCreeps <= 2) return 0;
        if (!hasAllContainers) return 1;
        if (rcl < 3 || extensionRatio < 0.8) return 2;
        if (!hasStorage || rcl < 4) return 3;
        if (rcl < 6 || !hasTerminal) return 4;
        if (rcl < 8) return 5;
        return 6;
    }

    private transitionPhase(room: Room, newPhase: RoomPhase): void {
        const oldPhase = room.memory.phase ?? 0;
        room.memory.phase = newPhase;

        if (room.memory.phaseData) {
            delete room.memory.phaseData.targetPhase;
            delete room.memory.phaseData.transitionTick;
        }

        log.info("RoomManager", `${room.name}: ${getPhaseName(oldPhase)} -> ${getPhaseName(newPhase)}`);
    }

    private evaluateDefenseMode(room: Room): void {
        const memory = room.memory;
        const threatLevel = memory.threatLevel ?? 0;
        const lastThreatTick = memory.threatLevelLastTick ?? 0;
        const ticksSinceLastThreat = Game.time - lastThreatTick;

        if (threatLevel > 0 && ticksSinceLastThreat < DEFENSE_CONFIG.DEACTIVATION_DELAY) {
            if (!memory.defenseMode) {
                memory.defenseMode = true;
                log.info("RoomManager", `${room.name}: DEFENSE MODE ACTIVATED (threat: ${threatLevel})`);
            }
        } else if (memory.defenseMode) {
            memory.defenseMode = false;
            log.info("RoomManager", `${room.name}: Defense mode deactivated`);
        }
    }

    // ==================== Public API ====================

    getPhase(room: Room): RoomPhase {
        return room.memory.phase ?? 0;
    }

    isDefenseMode(room: Room): boolean {
        return room.memory.defenseMode ?? false;
    }

    // ==================== Multi-Room Coordination ====================

    /**
     * Get all owned rooms sorted by phase (highest first)
     */
    getOwnedRooms(): Room[] {
        return Object.values(Game.rooms)
            .filter(r => r.controller?.my)
            .sort((a, b) => (b.memory.phase ?? 0) - (a.memory.phase ?? 0));
    }

    /**
     * Get empire statistics across all rooms
     */
    getEmpireStats(): {
        totalRooms: number;
        totalCreeps: number;
        totalEnergy: number;
        avgPhase: number;
        roomsByPhase: { [phase: number]: string[] };
    } {
        const ownedRooms = this.getOwnedRooms();
        const roomsByPhase: { [phase: number]: string[] } = {};

        let totalCreeps = 0;
        let totalEnergy = 0;
        let phaseSum = 0;

        for (const room of ownedRooms) {
            const phase = room.memory.phase ?? 0;
            if (!roomsByPhase[phase]) roomsByPhase[phase] = [];
            roomsByPhase[phase].push(room.name);

            totalCreeps += room.find(FIND_MY_CREEPS).length;
            totalEnergy += room.energyAvailable;
            if (room.storage) {
                totalEnergy += room.storage.store.getUsedCapacity(RESOURCE_ENERGY);
            }
            phaseSum += phase;
        }

        return {
            totalRooms: ownedRooms.length,
            totalCreeps,
            totalEnergy,
            avgPhase: ownedRooms.length > 0 ? phaseSum / ownedRooms.length : 0,
            roomsByPhase
        };
    }

    /**
     * Find the best room to spawn support creeps for a target room
     * Prefers rooms with high phase and available energy
     */
    findSupportRoom(targetRoom: string, minPhase: number = 3): Room | null {
        const candidates = this.getOwnedRooms().filter(r =>
            r.name !== targetRoom &&
            (r.memory.phase ?? 0) >= minPhase &&
            r.energyAvailable > r.energyCapacityAvailable * 0.5
        );

        if (candidates.length === 0) return null;

        // Sort by phase and energy, with distance as tiebreaker
        // For now, just return highest phase room
        return candidates[0];
    }

    /**
     * Get rooms that need support (bootstrapping or under attack)
     */
    getRoomsNeedingSupport(): { room: Room; reason: string }[] {
        const results: { room: Room; reason: string }[] = [];

        for (const room of this.getOwnedRooms()) {
            const phase = room.memory.phase ?? 0;
            const spawns = room.find(FIND_MY_SPAWNS).length;

            if (spawns === 0) {
                results.push({ room, reason: "no_spawn" });
            } else if (phase === 0) {
                results.push({ room, reason: "emergency" });
            } else if (room.memory.defenseMode && (room.memory.threatLevel ?? 0) > 1000) {
                results.push({ room, reason: "under_attack" });
            }
        }

        return results;
    }

    // ==================== Helper Methods ====================

    private hasAllSourceContainers(room: Room): boolean {
        const sources = room.memory.sources || {};
        if (Object.keys(sources).length === 0) return false;

        for (const sourceId in sources) {
            const sourceMemory = sources[sourceId as Id<Source>];
            if (!sourceMemory.container && !sourceMemory.containerSite) {
                return false;
            }
        }
        return true;
    }

    private getExtensionRatio(room: Room): number {
        const rcl = room.controller?.level ?? 0;
        const maxExtensions = RCL_EXTENSION_LIMITS[rcl] ?? 0;
        if (maxExtensions === 0) return 1;

        const currentExtensions = room.find(FIND_MY_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_EXTENSION
        }).length;

        return currentExtensions / maxExtensions;
    }

    private hasStructure(room: Room, structureType: StructureConstant): boolean {
        return room.find(FIND_MY_STRUCTURES, {
            filter: s => s.structureType === structureType
        }).length > 0;
    }
}

// Singleton instance
const roomManagerInstance = new RoomManager();

// Export module functions for game loop
export const roomManagerModule = {
    init: () => roomManagerInstance.init(),
    run: () => roomManagerInstance.run()
};

// Export instance for use by other modules
export const roomManager = roomManagerInstance;
