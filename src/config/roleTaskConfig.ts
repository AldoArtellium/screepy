/**
 * Role-Task Configuration
 * Defines how each role interacts with the task system.
 */

import { TaskCategory } from "../types/TaskTypes";

/**
 * Role flexibility levels:
 * - "strict": Never accepts tasks, always follows role logic (miner, defender, claimer)
 * - "task-driven": All work comes from task queue, no fallback (hauler)
 * - "flexible": Accepts tasks when idle, falls back to role behavior (harvester, builder, upgrader)
 */
export type RoleFlexibility = "strict" | "task-driven" | "flexible";

/**
 * Configuration for how a role interacts with the task system
 */
export interface RoleTaskConfig {
    /** Primary task categories this role can perform efficiently */
    primaryCategories: TaskCategory[];
    /** Secondary task categories this role can perform when primary tasks unavailable */
    secondaryCategories: TaskCategory[];
    /** How the role interacts with the task system */
    flexibility: RoleFlexibility;
    /** Per-category priority modifiers (negative = preferred, positive = avoid) */
    categoryModifiers: { [category: number]: number };
    /** Required body parts to execute tasks */
    requiredParts: BodyPartConstant[];
}

/**
 * Role-task configurations for all creep roles
 */
export const ROLE_TASK_CONFIGS: { [role: string]: RoleTaskConfig } = {
    // Strict roles: Never accept tasks, always follow role logic
    miner: {
        flexibility: "strict",
        primaryCategories: [TaskCategory.HARVEST],
        secondaryCategories: [],
        categoryModifiers: {},
        requiredParts: [WORK]
    },

    defender: {
        flexibility: "strict",
        primaryCategories: [TaskCategory.ATTACK],
        secondaryCategories: [],
        categoryModifiers: {},
        requiredParts: [ATTACK]
    },

    claimer: {
        flexibility: "strict",
        primaryCategories: [TaskCategory.CLAIM],
        secondaryCategories: [],
        categoryModifiers: {},
        requiredParts: [CLAIM]
    },

    // Task-driven roles: All work comes from task queue
    hauler: {
        flexibility: "task-driven",
        primaryCategories: [TaskCategory.TRANSPORT],
        secondaryCategories: [],
        categoryModifiers: {
            [TaskCategory.TRANSPORT]: -10 // Haulers strongly preferred for transport
        },
        requiredParts: [CARRY]
    },

    // Flexible roles: Accept tasks when idle, fallback to role behavior
    builder: {
        flexibility: "flexible",
        primaryCategories: [TaskCategory.BUILD, TaskCategory.REPAIR],
        secondaryCategories: [TaskCategory.TRANSPORT],
        categoryModifiers: {
            [TaskCategory.BUILD]: -10,   // Prefer building
            [TaskCategory.REPAIR]: -5,   // Also prefer repair
            [TaskCategory.TRANSPORT]: 10 // Avoid transport when possible
        },
        requiredParts: [WORK, CARRY]
    },

    upgrader: {
        flexibility: "flexible",
        primaryCategories: [TaskCategory.UPGRADE],
        secondaryCategories: [TaskCategory.TRANSPORT],
        categoryModifiers: {
            [TaskCategory.UPGRADE]: -20,   // Strongly prefer upgrading
            [TaskCategory.TRANSPORT]: 15   // Avoid transport
        },
        requiredParts: [WORK, CARRY]
    },

    harvester: {
        flexibility: "flexible",
        primaryCategories: [TaskCategory.HARVEST, TaskCategory.TRANSPORT],
        secondaryCategories: [TaskCategory.BUILD],
        categoryModifiers: {
            [TaskCategory.TRANSPORT]: -5, // Slight transport preference
            [TaskCategory.BUILD]: 10      // Avoid building
        },
        requiredParts: [WORK, CARRY]
    }
};

/**
 * Check if a creep has the required body parts for a task category
 */
export function canPerformCategory(creep: Creep, category: TaskCategory): boolean {
    switch (category) {
        case TaskCategory.HARVEST:
            return creep.getActiveBodyparts(WORK) > 0;
        case TaskCategory.BUILD:
        case TaskCategory.REPAIR:
        case TaskCategory.UPGRADE:
            return creep.getActiveBodyparts(WORK) > 0 && creep.getActiveBodyparts(CARRY) > 0;
        case TaskCategory.TRANSPORT:
            return creep.getActiveBodyparts(CARRY) > 0;
        case TaskCategory.ATTACK:
            return creep.getActiveBodyparts(ATTACK) > 0 || creep.getActiveBodyparts(RANGED_ATTACK) > 0;
        case TaskCategory.CLAIM:
            return creep.getActiveBodyparts(CLAIM) > 0;
        default:
            return false;
    }
}

/**
 * Calculate how suitable a creep is for a task category (higher = better)
 */
export function getCategorySuitability(creep: Creep, category: TaskCategory): number {
    const role = creep.memory.role || "harvester";
    const config = ROLE_TASK_CONFIGS[role];

    if (!config) return 0;
    if (!canPerformCategory(creep, category)) return 0;

    let suitability = 10; // Base suitability

    // Bonus for primary category
    if (config.primaryCategories.includes(category)) {
        suitability += 20;
    } else if (config.secondaryCategories.includes(category)) {
        // Smaller bonus for secondary category
        suitability += 5;
    } else {
        // Penalty if not in any category
        suitability -= 10;
    }

    // Add body part bonuses
    switch (category) {
        case TaskCategory.TRANSPORT:
            suitability += creep.store.getCapacity() / 50;
            break;
        case TaskCategory.BUILD:
        case TaskCategory.REPAIR:
        case TaskCategory.UPGRADE:
            suitability += creep.getActiveBodyparts(WORK) * 2;
            break;
        case TaskCategory.HARVEST:
            suitability += creep.getActiveBodyparts(WORK) * 3;
            break;
    }

    return suitability;
}

/**
 * Get the role configuration, defaulting to harvester if unknown
 */
export function getRoleConfig(role: string): RoleTaskConfig {
    return ROLE_TASK_CONFIGS[role] ?? ROLE_TASK_CONFIGS.harvester;
}
