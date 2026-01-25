/**
 * Shared utilities for creep roles
 */

/** Standard energy thresholds used across roles */
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
 * Check if creep has lost parts critical to its body type
 * Returns true if the creep can no longer perform its intended role
 */
export function hasLostCriticalParts(creep: Creep): boolean {
    const bodyType = creep.memory.bodyType;

    // Count active parts (parts with hits > 0)
    const activeParts = (part: BodyPartConstant) =>
        creep.body.filter(p => p.type === part && p.hits > 0).length;

    switch (bodyType) {
        case "worker":
            // Worker needs both WORK and CARRY to function
            return activeParts(WORK) === 0 || activeParts(CARRY) === 0;
        case "transport":
            // Transport needs CARRY to haul
            return activeParts(CARRY) === 0;
        case "combat":
            // Combat needs ATTACK to fight
            return activeParts(ATTACK) === 0;
        default:
            // Generic check - no useful work parts left
            return activeParts(WORK) === 0 &&
                   activeParts(CARRY) === 0 &&
                   activeParts(ATTACK) === 0;
    }
}

/**
 * Check if a creep should be recycled
 * Recycle when:
 * - Critical parts are lost (can't perform role)
 * - Below 50% health and no healing available
 */
export function shouldRecycleCreep(creep: Creep, canHeal: boolean): boolean {
    // Never recycle spawning creeps
    if (creep.spawning) return false;

    // Don't recycle healthy creeps
    if (creep.hits === creep.hitsMax) return false;

    // Always recycle if critical parts are lost (can't work)
    if (hasLostCriticalParts(creep)) return true;

    // Recycle if below 50% health and no healing available
    if (!canHeal && creep.hits < creep.hitsMax * 0.5) return true;

    return false;
}
