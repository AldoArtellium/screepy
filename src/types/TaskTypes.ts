/**
 * Task System Type Definitions
 * Defines task categories, types, statuses, and interfaces for the hybrid role-task system.
 */

/**
 * Task categories for matching creeps by body capabilities
 */
export const enum TaskCategory {
    HARVEST = 0,
    BUILD = 1,
    REPAIR = 2,
    UPGRADE = 3,
    TRANSPORT = 4,
    ATTACK = 5,
    CLAIM = 6
}

/**
 * Task execution status
 */
export const enum TaskStatus {
    PENDING = 0,
    ASSIGNED = 1,
    IN_PROGRESS = 2,
    COMPLETED = 3,
    FAILED = 4
}

/**
 * Specific task types for granular work assignment
 */
export const enum TaskType {
    // Transport tasks
    PICKUP_RESOURCE = 0,
    WITHDRAW_CONTAINER = 1,
    WITHDRAW_STORAGE = 2,
    FILL_SPAWN = 3,
    FILL_EXTENSION = 4,
    FILL_TOWER = 5,
    FILL_STORAGE = 6,

    // Build/Repair tasks
    BUILD_STRUCTURE = 10,
    REPAIR_STRUCTURE = 11,
    REPAIR_WALL = 12,
    REPAIR_RAMPART = 13,

    // Other tasks
    UPGRADE_CONTROLLER = 20,
    HARVEST_SOURCE = 21,
    ATTACK_HOSTILE = 30
}

/**
 * Maps TaskType to TaskCategory for capability matching
 */
export const TASK_TYPE_TO_CATEGORY: { [key: number]: TaskCategory } = {
    // Transport
    [TaskType.PICKUP_RESOURCE]: TaskCategory.TRANSPORT,
    [TaskType.WITHDRAW_CONTAINER]: TaskCategory.TRANSPORT,
    [TaskType.WITHDRAW_STORAGE]: TaskCategory.TRANSPORT,
    [TaskType.FILL_SPAWN]: TaskCategory.TRANSPORT,
    [TaskType.FILL_EXTENSION]: TaskCategory.TRANSPORT,
    [TaskType.FILL_TOWER]: TaskCategory.TRANSPORT,
    [TaskType.FILL_STORAGE]: TaskCategory.TRANSPORT,

    // Build
    [TaskType.BUILD_STRUCTURE]: TaskCategory.BUILD,

    // Repair
    [TaskType.REPAIR_STRUCTURE]: TaskCategory.REPAIR,
    [TaskType.REPAIR_WALL]: TaskCategory.REPAIR,
    [TaskType.REPAIR_RAMPART]: TaskCategory.REPAIR,

    // Upgrade
    [TaskType.UPGRADE_CONTROLLER]: TaskCategory.UPGRADE,

    // Harvest
    [TaskType.HARVEST_SOURCE]: TaskCategory.HARVEST,

    // Attack
    [TaskType.ATTACK_HOSTILE]: TaskCategory.ATTACK
};

/**
 * Base priority values for each task type (lower = higher priority)
 */
export const TASK_BASE_PRIORITIES: { [key: number]: number } = {
    [TaskType.FILL_SPAWN]: 10,
    [TaskType.FILL_EXTENSION]: 15,
    [TaskType.FILL_TOWER]: 25,
    [TaskType.PICKUP_RESOURCE]: 35,
    [TaskType.WITHDRAW_CONTAINER]: 40,
    [TaskType.WITHDRAW_STORAGE]: 42,
    [TaskType.BUILD_STRUCTURE]: 45,
    [TaskType.REPAIR_STRUCTURE]: 55,
    [TaskType.FILL_STORAGE]: 60,
    [TaskType.UPGRADE_CONTROLLER]: 65,
    [TaskType.REPAIR_WALL]: 70,
    [TaskType.REPAIR_RAMPART]: 68,
    [TaskType.HARVEST_SOURCE]: 50,
    [TaskType.ATTACK_HOSTILE]: 5
};

/**
 * Task definition interface
 */
export interface Task {
    id: string;
    type: TaskType;
    category: TaskCategory;
    targetId: Id<_HasId>;
    targetPos: { x: number; y: number; roomName: string };
    priority: number;
    status: TaskStatus;
    createdAt: number;
    assignedTo?: string;
    expiresAt?: number;
    amount?: number;
    resourceType?: ResourceConstant;
    /** Allow multiple creeps to work on this task simultaneously */
    shared?: boolean;
    /** Maximum number of concurrent workers for shared tasks */
    maxWorkers?: number;
    /** Current number of workers assigned to this task */
    workerCount?: number;
}

/**
 * Task queue structure stored in room memory
 */
export interface TaskQueue {
    tasks: { [id: string]: Task };
    byPriority: string[];
    lastSort: number;
}

/**
 * Creep task assignment stored in creep memory
 */
export interface CreepTask {
    id: string;
    startedAt: number;
    state: "acquiring" | "executing" | "returning";
}

/**
 * Generate unique task ID
 */
export function generateTaskId(type: TaskType, targetId: string): string {
    return `${type}-${targetId}-${Game.time}`;
}

/**
 * Create a new task
 */
export function createTask(
    type: TaskType,
    targetId: Id<_HasId>,
    targetPos: RoomPosition,
    options?: {
        priority?: number;
        expiresIn?: number;
        amount?: number;
        resourceType?: ResourceConstant;
        shared?: boolean;
        maxWorkers?: number;
    }
): Task {
    const category = TASK_TYPE_TO_CATEGORY[type];
    const basePriority = TASK_BASE_PRIORITIES[type] ?? 50;

    return {
        id: generateTaskId(type, targetId),
        type,
        category,
        targetId,
        targetPos: { x: targetPos.x, y: targetPos.y, roomName: targetPos.roomName },
        priority: options?.priority ?? basePriority,
        status: TaskStatus.PENDING,
        createdAt: Game.time,
        expiresAt: options?.expiresIn ? Game.time + options.expiresIn : undefined,
        amount: options?.amount,
        resourceType: options?.resourceType,
        shared: options?.shared,
        maxWorkers: options?.maxWorkers,
        workerCount: options?.shared ? 0 : undefined
    };
}
