import {
    DEFENSE_CONFIG,
    getPhaseName,
    PHASE_CONFIGS,
    PHASE_TRANSITION,
    RCL_EXTENSION_LIMITS,
} from "../config/phaseConfigs";
import { log } from "../utils/logger";

/**
 * PhaseManager - Evaluates and manages room phases for colony advancement
 */
class PhaseManager {
    /**
     * Main evaluation function - runs every EVAL_INTERVAL ticks
     */
    evaluate(): void {
        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];
            if (!room.controller?.my) continue;

            this.evaluateRoom(room);
            this.evaluateDefenseMode(room);
        }
    }

    /**
     * Evaluate and update the phase for a specific room
     */
    private evaluateRoom(room: Room): void {
        const memory = room.memory;
        if (!memory.phaseData) {
            memory.phaseData = { lastEvaluation: Game.time };
        }

        const currentPhase = memory.phase ?? 0;
        const calculatedPhase = this.calculatePhase(room);

        // Handle immediate EMERGENCY transition (any phase -> Phase 0)
        if (calculatedPhase === 0 && currentPhase !== 0) {
            this.transitionPhase(room, 0);
            return;
        }

        // Handle faster EMERGENCY EXIT (Phase 0 -> higher phase)
        // Use DOWN_THRESHOLD (20 ticks) instead of UP_THRESHOLD (50 ticks)
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

        // Check if we're tracking a potential transition
        if (memory.phaseData.targetPhase !== undefined) {
            if (memory.phaseData.targetPhase === calculatedPhase) {
                // Condition still holds, check if threshold reached
                const ticksSinceStart = Game.time - (memory.phaseData.transitionTick ?? Game.time);
                const threshold = calculatedPhase > currentPhase
                    ? PHASE_TRANSITION.UP_THRESHOLD
                    : PHASE_TRANSITION.DOWN_THRESHOLD;

                if (ticksSinceStart >= threshold) {
                    this.transitionPhase(room, calculatedPhase);
                }
            } else {
                // Condition no longer holds, reset tracking
                delete memory.phaseData.targetPhase;
                delete memory.phaseData.transitionTick;
            }
        } else if (calculatedPhase !== currentPhase) {
            // Start tracking a new potential transition
            memory.phaseData.targetPhase = calculatedPhase;
            memory.phaseData.transitionTick = Game.time;
        }

        memory.phaseData.lastEvaluation = Game.time;
    }

    /**
     * Calculate what phase a room should be in based on current conditions
     */
    private calculatePhase(room: Room): RoomPhase {
        const totalCreeps = this.getRoomCreepCount(room);
        const rcl = room.controller?.level ?? 0;
        const sources = Object.keys(room.memory.sources || {});
        const hasAllContainers = this.hasAllSourceContainers(room);
        const extensionRatio = this.getExtensionRatio(room);
        const hasStorage = this.hasStructure(room, STRUCTURE_STORAGE);
        const hasTerminal = this.hasStructure(room, STRUCTURE_TERMINAL);

        // Phase 0: EMERGENCY - totalCreeps <= 2
        if (totalCreeps <= 2) {
            return 0;
        }

        // Phase 1: BOOTSTRAP - creeps >= 3, no containers
        if (!hasAllContainers) {
            return 1;
        }

        // Phase 2: FOUNDATION - all sources have containers, RCL >= 2
        if (rcl < 3 || extensionRatio < 0.8) {
            return 2;
        }

        // Phase 3: EXPANSION - 80% extensions built, RCL >= 3
        if (!hasStorage || rcl < 4) {
            return 3;
        }

        // Phase 4: ESTABLISHED - has storage, RCL >= 4
        if (rcl < 6 || !hasTerminal) {
            return 4;
        }

        // Phase 5: ADVANCED - RCL >= 6, has terminal
        if (rcl < 8) {
            return 5;
        }

        // Phase 6: DOMINANT - RCL = 8
        return 6;
    }

    /**
     * Transition to a new phase
     */
    private transitionPhase(room: Room, newPhase: RoomPhase): void {
        const oldPhase = room.memory.phase ?? 0;
        room.memory.phase = newPhase;

        // Clear transition tracking
        if (room.memory.phaseData) {
            delete room.memory.phaseData.targetPhase;
            delete room.memory.phaseData.transitionTick;
        }

        log.info("PhaseManager", `${room.name}: ${getPhaseName(oldPhase)} -> ${getPhaseName(newPhase)}`);
    }

    /**
     * Evaluate and update defense mode for a room
     */
    private evaluateDefenseMode(room: Room): void {
        const memory = room.memory;
        const threatLevel = memory.threatLevel ?? 0;
        const lastThreatTick = memory.threatLevelLastTick ?? 0;
        const ticksSinceLastThreat = Game.time - lastThreatTick;

        if (threatLevel > 0 && ticksSinceLastThreat < DEFENSE_CONFIG.DEACTIVATION_DELAY) {
            if (!memory.defenseMode) {
                memory.defenseMode = true;
                log.info("PhaseManager", `${room.name}: DEFENSE MODE ACTIVATED (threat: ${threatLevel})`);
            }
        } else if (memory.defenseMode) {
            memory.defenseMode = false;
            log.info("PhaseManager", `${room.name}: Defense mode deactivated`);
        }
    }

    /**
     * Get the desired creep counts for a room based on its phase
     */
    getDesiredCreepCounts(room: Room): { [role: string]: number } {
        const phase = room.memory.phase ?? 0;
        const defenseMode = room.memory.defenseMode ?? false;
        const sources = Object.keys(room.memory.sources || {}).length;
        const minerCount = this.getRoleCount(room, "miner");

        const counts: { [role: string]: number } = {
            harvester: 0,
            miner: 0,
            hauler: 0,
            builder: 0,
            upgrader: 0,
            defender: 0,
            claimer: 0
        };

        switch (phase) {
            case 0: // EMERGENCY
                counts.harvester = 4;
                counts.miner = 0;
                counts.hauler = 0;
                counts.builder = 0;
                counts.upgrader = 0;
                break;

            case 1: // BOOTSTRAP
                counts.harvester = sources > minerCount ? Math.max(1, 2 - minerCount) : 0;
                counts.miner = sources;
                counts.hauler = minerCount * 2;
                counts.builder = 1;
                counts.upgrader = 2;
                break;

            case 2: // FOUNDATION
                counts.harvester = 0;
                counts.miner = sources;
                counts.hauler = minerCount * 2;
                counts.builder = 3;
                counts.upgrader = 3;
                break;

            case 3: // EXPANSION
                counts.harvester = 0;
                counts.miner = sources;
                counts.hauler = minerCount * 2;
                counts.builder = 2;
                counts.upgrader = 5;
                break;

            case 4: // ESTABLISHED
                counts.harvester = 0;
                counts.miner = sources;
                counts.hauler = minerCount * 2;
                counts.builder = 1;
                counts.upgrader = 5;
                break;

            case 5: // ADVANCED
            case 6: // DOMINANT
                counts.harvester = 0;
                counts.miner = sources;
                counts.hauler = minerCount * 2;
                counts.builder = 1;
                counts.upgrader = 6;
                break;
        }

        // Add defenders based on defense mode and threat level
        if (defenseMode || (room.memory.threatLevel ?? 0) > 0) {
            counts.defender = this.getDefenderCount(room);
        }

        return counts;
    }

    /**
     * Get spawn priorities for a room (lower = higher priority)
     */
    getSpawnPriorities(room: Room): { [role: string]: number } {
        const phase = room.memory.phase ?? 0;
        const defenseMode = room.memory.defenseMode ?? false;
        const priorities = { ...PHASE_CONFIGS[phase].spawnPriorities };

        // In defense mode, defenders get absolute priority
        if (defenseMode) {
            priorities.defender = -1; // Highest priority
        }

        return priorities;
    }

    /**
     * Get the number of defenders needed based on threat level
     */
    private getDefenderCount(room: Room): number {
        const threatLevel = room.memory.threatLevel ?? 0;

        for (const tier of DEFENSE_CONFIG.DEFENDER_SCALING) {
            if (threatLevel < tier.maxThreat) {
                return tier.defenders;
            }
        }

        return DEFENSE_CONFIG.DEFENDER_SCALING[DEFENSE_CONFIG.DEFENDER_SCALING.length - 1].defenders;
    }

    /**
     * Check if room is in defense mode
     */
    isDefenseMode(room: Room): boolean {
        return room.memory.defenseMode ?? false;
    }

    /**
     * Get the current phase of a room
     */
    getPhase(room: Room): RoomPhase {
        return room.memory.phase ?? 0;
    }

    /**
     * Get phase configuration for a room
     */
    getPhaseConfig(room: Room) {
        const phase = room.memory.phase ?? 0;
        return PHASE_CONFIGS[phase];
    }

    // Helper methods

    private getRoomCreepCount(room: Room): number {
        return room.find(FIND_MY_CREEPS).length;
    }

    private getRoleCount(room: Room, role: string): number {
        return room.find(FIND_MY_CREEPS, {
            filter: c => c.memory.role === role
        }).length;
    }

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
const phaseManagerInstance = new PhaseManager();

// Export module function for game loop
export const phaseManagerModule = () => {
    phaseManagerInstance.evaluate();
};

// Export instance for use by other modules
export const phaseManager = phaseManagerInstance;
