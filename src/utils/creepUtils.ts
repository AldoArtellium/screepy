/**
 * Shared utilities for creep roles
 * Provides common constants, caching, and energy management functions
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

/** Standard reuse path value */
export const REUSE_PATH = 5;

/** Default cache duration in ticks */
export const TARGET_CACHE_TICKS = 10;

/**
 * Check if a cached target is still valid
 */
export function isCacheValid(creep: Creep, cacheTicks = TARGET_CACHE_TICKS): boolean {
    if (!creep.memory.targetTick) return false;
    return Game.time - creep.memory.targetTick < cacheTicks;
}

/**
 * Get a cached target or find a new one
 * Automatically manages target caching in creep memory
 */
export function getOrFindTarget<T extends _HasId>(
    creep: Creep,
    finder: () => T | null,
    validator?: (target: T) => boolean
): T | null {
    // Check cached target first
    if (creep.memory.targetId && isCacheValid(creep)) {
        const cached = Game.getObjectById(creep.memory.targetId as Id<T>);
        if (cached && (!validator || validator(cached))) {
            return cached;
        }
        // Cache is stale or invalid
        delete creep.memory.targetId;
        delete creep.memory.targetTick;
    }

    // Find new target
    const target = finder();
    if (target) {
        creep.memory.targetId = target.id;
        creep.memory.targetTick = Game.time;
    }
    return target;
}

/**
 * Clear cached target from creep memory
 */
export function clearTargetCache(creep: Creep): void {
    delete creep.memory.targetId;
    delete creep.memory.targetTick;
}

/**
 * Find an energy source for acquiring energy
 * Priority: containers > dropped resources > storage (phase 4+) > sources (emergency)
 */
export function findEnergySource(
    creep: Creep,
    options?: {
        includeStorage?: boolean;
        includeSources?: boolean;
        storageMinEnergy?: number;
    }
): Structure | Resource | Source | null {
    const room = creep.room;
    const phase = room.memory.phase ?? 0;
    const opts = {
        includeStorage: phase >= 4,
        includeSources: phase === 0,
        storageMinEnergy: ENERGY_THRESHOLDS.STORAGE_PULL,
        ...options
    };

    // Try containers first
    const container = creep.pos.findClosestByPath(FIND_STRUCTURES, {
        filter: (s): s is StructureContainer =>
            s.structureType === STRUCTURE_CONTAINER &&
            s.store.getUsedCapacity(RESOURCE_ENERGY) > ENERGY_THRESHOLDS.CONTAINER_MIN
    });
    if (container) return container;

    // Try dropped resources
    const dropped = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
        filter: r => r.resourceType === RESOURCE_ENERGY && r.amount > ENERGY_THRESHOLDS.DROPPED_MIN
    });
    if (dropped) return dropped;

    // Try storage if enabled
    if (opts.includeStorage && room.storage) {
        if (room.storage.store.getUsedCapacity(RESOURCE_ENERGY) > opts.storageMinEnergy) {
            return room.storage;
        }
    }

    // Try sources if enabled (emergency only)
    if (opts.includeSources) {
        const source = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE);
        if (source) return source;
    }

    return null;
}

/**
 * Find an energy delivery target
 * Priority varies by defense mode:
 * - Defense: towers > spawn/extensions > storage
 * - Normal: spawn/extensions > towers > storage
 */
export function findEnergyTarget(
    creep: Creep,
    options?: {
        defenseMode?: boolean;
        includeStorage?: boolean;
    }
): Structure | null {
    const room = creep.room;
    const phase = room.memory.phase ?? 0;
    const opts = {
        defenseMode: room.memory.defenseMode ?? false,
        includeStorage: phase >= 4,
        ...options
    };

    // Defense mode: towers first
    if (opts.defenseMode) {
        const tower = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
            filter: (s): s is StructureTower =>
                s.structureType === STRUCTURE_TOWER &&
                s.store.getFreeCapacity(RESOURCE_ENERGY) > 100
        });
        if (tower) return tower;
    }

    // Spawns and extensions (always highest priority in normal mode)
    const spawnOrExtension = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
        filter: (s): s is StructureSpawn | StructureExtension =>
            (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
            s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
    });
    if (spawnOrExtension) return spawnOrExtension;

    // Towers (lower priority in normal mode)
    if (!opts.defenseMode) {
        const tower = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
            filter: (s): s is StructureTower =>
                s.structureType === STRUCTURE_TOWER &&
                s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
        });
        if (tower) return tower;
    }

    // Storage
    if (opts.includeStorage && room.storage) {
        if (room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
            return room.storage;
        }
    }

    return null;
}

/**
 * Move creep to idle position near spawn
 */
export function idleNearSpawn(creep: Creep): void {
    const spawn = creep.room.find(FIND_MY_SPAWNS)[0];
    if (!spawn) return;

    if (!creep.pos.inRangeTo(spawn, 3)) {
        creep.moveTo(spawn, { reusePath: REUSE_PATH });
    } else if (creep.pos.isNearTo(spawn) && Game.time % 5 === 0) {
        // Occasionally move away from spawn to avoid blocking
        const directions: DirectionConstant[] = [
            TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT
        ];
        const direction = directions[Math.floor(Math.random() * directions.length)];
        creep.move(direction);
    }
}

/**
 * Update creep energy state using hysteresis
 * Returns the new state: "acquiring" or "executing"
 */
export function updateEnergyState(creep: Creep): "acquiring" | "executing" {
    const capacity = creep.store.getCapacity();
    const used = creep.store.getUsedCapacity();

    if (used >= capacity * ENERGY_THRESHOLDS.STATE_HIGH) {
        return "executing";
    } else if (used <= capacity * ENERGY_THRESHOLDS.STATE_LOW) {
        return "acquiring";
    }

    // Between thresholds: keep current state (hysteresis)
    if (creep.memory.state === "executing") {
        return "executing";
    }
    return "acquiring";
}

/**
 * Move to a target and perform an action
 * Returns true if action was attempted (whether successful or not)
 */
export function moveToAndAct(
    creep: Creep,
    target: RoomObject,
    action: () => ScreepsReturnCode,
    range = 1
): boolean {
    if (creep.pos.inRangeTo(target, range)) {
        action();
        return true;
    } else {
        creep.moveTo(target, { reusePath: REUSE_PATH });
        return false;
    }
}

/**
 * Withdraw energy from a structure or pickup dropped resource
 */
export function acquireEnergy(creep: Creep, target: Structure | Resource | Source): ScreepsReturnCode {
    if ("resourceType" in target) {
        // Dropped resource
        return creep.pickup(target);
    } else if ("energy" in target && "energyCapacity" in target) {
        // Source
        return creep.harvest(target);
    } else if ("store" in target) {
        // Structure with store
        return creep.withdraw(target, RESOURCE_ENERGY);
    }
    return ERR_INVALID_TARGET;
}
