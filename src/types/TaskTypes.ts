/**
 * Task system types and enums
 * Defines task categories, types, priorities, and interfaces
 */

/**
 * Task categories for grouping related tasks
 */
export enum TaskCategory {
    HARVEST = "harvest",
    TRANSPORT = "transport",
    BUILD = "build",
    REPAIR = "repair",
    UPGRADE = "upgrade",
    ATTACK = "attack",
    CLAIM = "claim",
    LIFECYCLE = "lifecycle"
}

/**
 * Specific task types with their base priorities
 */
export enum TaskType {
    // Combat (highest priority)
    ATTACK_HOSTILE = "attack_hostile",
    DEFEND_RAMPART = "defend_rampart",

    // Transport - spawn infrastructure
    FILL_SPAWN = "fill_spawn",
    FILL_EXTENSION = "fill_extension",
    FILL_TOWER = "fill_tower",

    // Transport - energy collection
    PICKUP_RESOURCE = "pickup_resource",
    WITHDRAW_CONTAINER = "withdraw_container",
    WITHDRAW_STORAGE = "withdraw_storage",

    // Work
    HARVEST_SOURCE = "harvest_source",
    BUILD_STRUCTURE = "build_structure",
    REPAIR_STRUCTURE = "repair_structure",
    UPGRADE_CONTROLLER = "upgrade_controller",

    // Storage
    FILL_STORAGE = "fill_storage",

    // Defense repairs
    REPAIR_RAMPART = "repair_rampart",
    REPAIR_WALL = "repair_wall",

    // Expansion
    CLAIM_ROOM = "claim_room",
    RESERVE_ROOM = "reserve_room",

    // Lifecycle
    RECYCLE_CREEP = "recycle_creep"
}

/**
 * Task status
 */
export enum TaskStatus {
    PENDING = "pending",
    ASSIGNED = "assigned",
    IN_PROGRESS = "in_progress",
    COMPLETED = "completed",
    FAILED = "failed"
}

/**
 * Base priorities for each task type (lower = higher priority)
 */
export const TASK_PRIORITIES: Record<TaskType, number> = {
    [TaskType.ATTACK_HOSTILE]: 5,
    [TaskType.DEFEND_RAMPART]: 8,
    [TaskType.FILL_SPAWN]: 10,
    [TaskType.FILL_EXTENSION]: 15,
    [TaskType.FILL_TOWER]: 25,
    [TaskType.PICKUP_RESOURCE]: 30,
    [TaskType.WITHDRAW_CONTAINER]: 35,
    [TaskType.WITHDRAW_STORAGE]: 42,
    [TaskType.HARVEST_SOURCE]: 40,
    [TaskType.BUILD_STRUCTURE]: 45,
    [TaskType.REPAIR_STRUCTURE]: 50,
    [TaskType.UPGRADE_CONTROLLER]: 55,
    [TaskType.FILL_STORAGE]: 60,
    [TaskType.REPAIR_RAMPART]: 65,
    [TaskType.REPAIR_WALL]: 70,
    [TaskType.CLAIM_ROOM]: 20,
    [TaskType.RESERVE_ROOM]: 35,
    [TaskType.RECYCLE_CREEP]: 85
};

/**
 * Defense mode priority boosts (negative = higher priority)
 */
export const DEFENSE_PRIORITY_BOOSTS: Partial<Record<TaskType, number>> = {
    [TaskType.FILL_TOWER]: -20,
    [TaskType.REPAIR_RAMPART]: -30
};

/**
 * Priority boost for upgrading in early phases (1-3) to ensure RCL progression
 * Without this, upgrade tasks (priority 55) never get assigned because
 * spawn filling and building always take precedence
 */
export const EARLY_PHASE_UPGRADE_BOOST = -25;

/**
 * Task category mapping
 */
export const TASK_CATEGORIES: Record<TaskType, TaskCategory> = {
    [TaskType.ATTACK_HOSTILE]: TaskCategory.ATTACK,
    [TaskType.DEFEND_RAMPART]: TaskCategory.ATTACK,
    [TaskType.FILL_SPAWN]: TaskCategory.TRANSPORT,
    [TaskType.FILL_EXTENSION]: TaskCategory.TRANSPORT,
    [TaskType.FILL_TOWER]: TaskCategory.TRANSPORT,
    [TaskType.PICKUP_RESOURCE]: TaskCategory.TRANSPORT,
    [TaskType.WITHDRAW_CONTAINER]: TaskCategory.TRANSPORT,
    [TaskType.WITHDRAW_STORAGE]: TaskCategory.TRANSPORT,
    [TaskType.HARVEST_SOURCE]: TaskCategory.HARVEST,
    [TaskType.BUILD_STRUCTURE]: TaskCategory.BUILD,
    [TaskType.REPAIR_STRUCTURE]: TaskCategory.REPAIR,
    [TaskType.UPGRADE_CONTROLLER]: TaskCategory.UPGRADE,
    [TaskType.FILL_STORAGE]: TaskCategory.TRANSPORT,
    [TaskType.REPAIR_RAMPART]: TaskCategory.REPAIR,
    [TaskType.REPAIR_WALL]: TaskCategory.REPAIR,
    [TaskType.CLAIM_ROOM]: TaskCategory.CLAIM,
    [TaskType.RESERVE_ROOM]: TaskCategory.CLAIM,
    [TaskType.RECYCLE_CREEP]: TaskCategory.LIFECYCLE
};

/**
 * Part requirements for each task category
 */
export const TASK_PART_REQUIREMENTS: Record<TaskCategory, Partial<Record<BodyPartConstant, number>>> = {
    [TaskCategory.HARVEST]: { [WORK]: 1 },
    [TaskCategory.TRANSPORT]: { [CARRY]: 1 },
    [TaskCategory.BUILD]: { [WORK]: 1, [CARRY]: 1 },
    [TaskCategory.REPAIR]: { [WORK]: 1, [CARRY]: 1 },
    [TaskCategory.UPGRADE]: { [WORK]: 1, [CARRY]: 1 },
    [TaskCategory.ATTACK]: { [ATTACK]: 1 },
    [TaskCategory.CLAIM]: { [CLAIM]: 1 },
    [TaskCategory.LIFECYCLE]: {}  // No part requirements - any creep can recycle
};

/**
 * Task interface
 */
export interface Task {
    id: string;
    type: TaskType;
    category: TaskCategory;
    targetId: string;
    roomName: string;
    priority: number;
    status: TaskStatus;
    assignedTo?: string;
    createdAt: number;
    expiresAt?: number;
    data?: {
        amount?: number;
        targetPos?: { x: number; y: number };
        structureType?: StructureConstant;
        creepId?: string;
    };
}

/**
 * Creep task state for tracking current task progress
 */
export interface CreepTaskState {
    taskId: string;
    type: TaskType;
    targetId: string;
    state: "acquiring" | "executing" | "returning";
    startedAt: number;
    /** Last position for stuck detection */
    lastPos?: { x: number; y: number };
    /** Ticks spent at same position */
    stuckTicks?: number;
    /** Number of times this task has been retried */
    retryCount?: number;
}

/**
 * Part demand tracking
 */
export interface PartDemand {
    [WORK]?: { total: number; supplied: number; deficit: number };
    [CARRY]?: { total: number; supplied: number; deficit: number };
    [ATTACK]?: { total: number; supplied: number; deficit: number };
    [CLAIM]?: { total: number; supplied: number; deficit: number };
    [MOVE]?: { total: number; supplied: number; deficit: number };
}

/**
 * Helper functions
 */

/**
 * Generate a unique task ID
 */
export function generateTaskId(type: TaskType, targetId: string): string {
    return `${type}-${targetId}-${Game.time}`;
}

/**
 * Get effective priority considering defense mode
 */
export function getEffectivePriority(type: TaskType, defenseMode: boolean): number {
    let priority = TASK_PRIORITIES[type];
    if (defenseMode && DEFENSE_PRIORITY_BOOSTS[type]) {
        priority += DEFENSE_PRIORITY_BOOSTS[type]!;
    }
    return priority;
}

/**
 * Check if a task type requires energy acquisition
 */
export function requiresEnergy(type: TaskType): boolean {
    const category = TASK_CATEGORIES[type];
    return category === TaskCategory.BUILD ||
           category === TaskCategory.REPAIR ||
           category === TaskCategory.UPGRADE ||
           type === TaskType.FILL_SPAWN ||
           type === TaskType.FILL_EXTENSION ||
           type === TaskType.FILL_TOWER ||
           type === TaskType.FILL_STORAGE;
}

/**
 * Get the category for a task type
 */
export function getTaskCategory(type: TaskType): TaskCategory {
    return TASK_CATEGORIES[type];
}
