/**
 * Phase configuration for each room phase.
 * Defines desired creep counts, priorities, and build orders.
 */

export interface PhaseConfig {
    name: string;
    spawnPriorities: { [role: string]: number };
    buildPriorities: StructureConstant[];
    bodyScaling: {
        [role: string]: {
            minEnergy: number;
            maxParts?: number;
        };
    };
}

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
 * Phase configurations indexed by RoomPhase enum value
 */
export const PHASE_CONFIGS: { [phase: number]: PhaseConfig } = {
    // Phase 0: EMERGENCY - Spawn basic harvesters to survive
    0: {
        name: "EMERGENCY",
        spawnPriorities: {
            harvester: 0,
            miner: 1,
            hauler: 2,
            builder: 3,
            upgrader: 4,
            defender: 0  // Defenders still high priority if needed
        },
        buildPriorities: [],
        bodyScaling: {
            harvester: { minEnergy: 200, maxParts: 4 },
            miner: { minEnergy: 200, maxParts: 3 },
            hauler: { minEnergy: 150, maxParts: 4 },
            builder: { minEnergy: 200, maxParts: 3 },
            upgrader: { minEnergy: 200, maxParts: 3 },
            defender: { minEnergy: 200, maxParts: 4 }
        }
    },

    // Phase 1: BOOTSTRAP - Spawn miners, build source containers
    1: {
        name: "BOOTSTRAP",
        spawnPriorities: {
            miner: 0,
            hauler: 1,
            harvester: 2,
            builder: 3,
            upgrader: 4,
            defender: 0
        },
        buildPriorities: [STRUCTURE_CONTAINER],
        bodyScaling: {
            harvester: { minEnergy: 200, maxParts: 4 },
            miner: { minEnergy: 300, maxParts: 5 },
            hauler: { minEnergy: 200, maxParts: 6 },
            builder: { minEnergy: 300, maxParts: 4 },
            upgrader: { minEnergy: 300, maxParts: 4 },
            defender: { minEnergy: 260, maxParts: 6 }
        }
    },

    // Phase 2: FOUNDATION - Build extensions, optimize economy
    2: {
        name: "FOUNDATION",
        spawnPriorities: {
            miner: 0,
            hauler: 1,
            builder: 2,
            upgrader: 3,
            harvester: 4,
            defender: 0
        },
        buildPriorities: [STRUCTURE_EXTENSION, STRUCTURE_CONTAINER, STRUCTURE_ROAD],
        bodyScaling: {
            harvester: { minEnergy: 200, maxParts: 4 },
            miner: { minEnergy: 400, maxParts: 5 },
            hauler: { minEnergy: 300, maxParts: 8 },
            builder: { minEnergy: 400, maxParts: 5 },
            upgrader: { minEnergy: 400, maxParts: 5 },
            defender: { minEnergy: 330, maxParts: 8 }
        }
    },

    // Phase 3: EXPANSION - Maximize upgrading, build roads
    3: {
        name: "EXPANSION",
        spawnPriorities: {
            miner: 0,
            hauler: 1,
            upgrader: 2,
            builder: 3,
            harvester: 4,
            defender: 0
        },
        buildPriorities: [STRUCTURE_EXTENSION, STRUCTURE_ROAD, STRUCTURE_TOWER],
        bodyScaling: {
            harvester: { minEnergy: 200, maxParts: 4 },
            miner: { minEnergy: 550, maxParts: 5 },
            hauler: { minEnergy: 400, maxParts: 10 },
            builder: { minEnergy: 500, maxParts: 5 },
            upgrader: { minEnergy: 600, maxParts: 6 },
            defender: { minEnergy: 400, maxParts: 10 }
        }
    },

    // Phase 4: ESTABLISHED - Storage logistics, tower defense
    4: {
        name: "ESTABLISHED",
        spawnPriorities: {
            miner: 0,
            hauler: 1,
            upgrader: 2,
            builder: 3,
            harvester: 4,
            defender: 0
        },
        buildPriorities: [STRUCTURE_STORAGE, STRUCTURE_TOWER, STRUCTURE_EXTENSION, STRUCTURE_ROAD],
        bodyScaling: {
            harvester: { minEnergy: 200, maxParts: 4 },
            miner: { minEnergy: 550, maxParts: 5 },
            hauler: { minEnergy: 500, maxParts: 10 },
            builder: { minEnergy: 600, maxParts: 5 },
            upgrader: { minEnergy: 800, maxParts: 8 },
            defender: { minEnergy: 500, maxParts: 12 }
        }
    },

    // Phase 5: ADVANCED - Market, remote mining
    5: {
        name: "ADVANCED",
        spawnPriorities: {
            miner: 0,
            hauler: 1,
            upgrader: 2,
            builder: 3,
            harvester: 4,
            defender: 0,
            claimer: 5
        },
        buildPriorities: [STRUCTURE_TERMINAL, STRUCTURE_LAB, STRUCTURE_EXTENSION, STRUCTURE_ROAD],
        bodyScaling: {
            harvester: { minEnergy: 200, maxParts: 4 },
            miner: { minEnergy: 550, maxParts: 5 },
            hauler: { minEnergy: 600, maxParts: 16 },
            builder: { minEnergy: 700, maxParts: 6 },
            upgrader: { minEnergy: 1000, maxParts: 10 },
            defender: { minEnergy: 600, maxParts: 15 },
            claimer: { minEnergy: 650, maxParts: 2 }
        }
    },

    // Phase 6: DOMINANT - Maximum efficiency, expansion
    6: {
        name: "DOMINANT",
        spawnPriorities: {
            miner: 0,
            hauler: 1,
            upgrader: 2,
            builder: 3,
            harvester: 4,
            defender: 0,
            claimer: 5
        },
        buildPriorities: [STRUCTURE_SPAWN, STRUCTURE_EXTENSION, STRUCTURE_ROAD, STRUCTURE_LINK],
        bodyScaling: {
            harvester: { minEnergy: 200, maxParts: 4 },
            miner: { minEnergy: 550, maxParts: 5 },
            hauler: { minEnergy: 800, maxParts: 20 },
            builder: { minEnergy: 800, maxParts: 8 },
            upgrader: { minEnergy: 1200, maxParts: 15 },
            defender: { minEnergy: 800, maxParts: 20 },
            claimer: { minEnergy: 650, maxParts: 2 }
        }
    }
};

/**
 * Hysteresis configuration for phase transitions
 */
export const PHASE_TRANSITION = {
    // Ticks condition must be true to transition UP
    UP_THRESHOLD: 50,
    // Ticks condition must be true to transition DOWN
    DOWN_THRESHOLD: 20,
    // Evaluation interval in ticks
    EVAL_INTERVAL: 10
};

/**
 * Defense mode configuration
 */
export const DEFENSE_CONFIG = {
    // Ticks after last hostile seen before deactivating defense mode
    DEACTIVATION_DELAY: 300,
    // Defender counts based on threat level
    DEFENDER_SCALING: [
        { maxThreat: 1000, defenders: 2 },
        { maxThreat: 5000, defenders: 3 },
        { maxThreat: Infinity, defenders: 4 }
    ]
};

/**
 * Get the phase name for display/logging
 */
export function getPhaseName(phase: number): string {
    return PHASE_CONFIGS[phase]?.name ?? "UNKNOWN";
}
