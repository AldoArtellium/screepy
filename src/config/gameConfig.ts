/**
 * Consolidated Game Configuration
 * Single source of truth for all game constants, thresholds, and settings.
 */

// Re-export from RoomManager for backwards compatibility
export { RCL_EXTENSION_LIMITS, getPhaseName } from "../modules/RoomManager";

/**
 * Module timing configuration
 */
export const MODULE_INTERVALS = {
    MEMORY_REFRESH: 5,
    ROOM_MANAGER: 5,
    SPAWN_MANAGER: 3,
    CONSTRUCTION_MANAGER: 20,
    DEMAND_CALCULATOR: 10,
    TASK_GENERATOR: 5
} as const;

/**
 * Energy thresholds used across roles
 */
export const ENERGY_THRESHOLDS = {
    /** Minimum energy in container to be worth withdrawing */
    CONTAINER_MIN: 200,
    /** Minimum dropped energy to be worth picking up */
    DROPPED_MIN: 50,
    /** Minimum storage energy before pulling from it */
    STORAGE_PULL: 5000,
    /** Higher storage threshold during defense mode */
    STORAGE_DEFENSE: 10000,
    /** Switch to delivering when at or above this capacity ratio */
    STATE_HIGH: 0.8,
    /** Switch to acquiring when at or below this capacity ratio */
    STATE_LOW: 0.2
} as const;

/**
 * Creep behavior configuration
 */
export const CREEP_CONFIG = {
    /** Standard reuse path value for moveTo */
    REUSE_PATH: 5,
    /** Default cache duration in ticks */
    TARGET_CACHE_TICKS: 10,
    /** Range to idle near spawn */
    IDLE_RANGE: 3
} as const;

/**
 * Construction thresholds
 */
export const CONSTRUCTION_CONFIG = {
    /** Wall/rampart target hit points by RCL */
    WALL_HITS: {
        1: 1000,
        2: 5000,
        3: 25000,
        4: 50000,
        5: 100000,
        6: 300000,
        7: 500000,
        8: 1000000
    } as Record<number, number>,
    /** Repair threshold (percentage of max hits) */
    REPAIR_THRESHOLD: 0.8,
    /** Critical repair threshold for ramparts in defense mode */
    RAMPART_CRITICAL: 10000
} as const;

/**
 * Tower configuration
 */
export const TOWER_CONFIG = {
    /** Energy threshold to start repair */
    REPAIR_ENERGY_MIN: 500,
    /** Don't repair walls/ramparts in defense mode unless critical */
    DEFENSE_REPAIR_THRESHOLD: 1000
} as const;

/**
 * Defense mode configuration
 */
export const DEFENSE_CONFIG = {
    /** Ticks after last hostile seen before deactivating defense mode */
    DEACTIVATION_DELAY: 300
} as const;

/**
 * Phase transition thresholds
 */
export const PHASE_TRANSITION = {
    /** Ticks condition must be true to transition UP */
    UP_THRESHOLD: 50,
    /** Ticks condition must be true to transition DOWN */
    DOWN_THRESHOLD: 20,
    /** Evaluation interval in ticks */
    EVAL_INTERVAL: 10
} as const;
