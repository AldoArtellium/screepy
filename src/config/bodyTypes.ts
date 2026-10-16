/**
 * Body type configurations for generic creeps
 * Creeps are spawned as generic body types and dynamically assigned tasks
 */

export enum BodyType {
    WORKER = "worker",
    TRANSPORT = "transport",
    COMBAT = "combat",
    CLAIM = "claim",
    SCOUT = "scout",
    RESERVER = "reserver",
    /** Static harvester: no CARRY, harvests into the container it stands on (or drops) */
    MINER = "miner"
}

export interface BodyConfig {
    ratios: Partial<Record<BodyPartConstant, number>>;
    unitCost: number;
    minUnits: number;
    maxUnits: number;
}

/**
 * Body configurations for each type
 * - ratios: Part ratios per "unit" of body
 * - unitCost: Energy cost per unit
 * - minUnits/maxUnits: Scaling limits
 */
export const BODY_CONFIGS: Record<BodyType, BodyConfig> = {
    [BodyType.WORKER]: {
        // 1 WORK, 1 CARRY, 2 MOVE - balanced for all tasks
        ratios: { [WORK]: 1, [CARRY]: 1, [MOVE]: 2 },
        unitCost: 250,
        minUnits: 1,
        maxUnits: 12
    },
    [BodyType.TRANSPORT]: {
        // 2 CARRY, 1 MOVE - road-optimized hauling
        ratios: { [CARRY]: 2, [MOVE]: 1 },
        unitCost: 150,
        minUnits: 1,
        maxUnits: 16
    },
    [BodyType.COMBAT]: {
        // 2 ATTACK, 1 TOUGH, 2 MOVE - basic melee fighter
        ratios: { [ATTACK]: 2, [TOUGH]: 1, [MOVE]: 2 },
        unitCost: 240,
        minUnits: 1,
        maxUnits: 10
    },
    [BodyType.CLAIM]: {
        // 1 CLAIM, 1 MOVE - room claiming
        ratios: { [CLAIM]: 1, [MOVE]: 1 },
        unitCost: 650,
        minUnits: 1,
        maxUnits: 1
    },
    [BodyType.SCOUT]: {
        // 1 MOVE - fast scouting
        ratios: { [MOVE]: 1 },
        unitCost: 50,
        minUnits: 1,
        maxUnits: 1
    },
    [BodyType.MINER]: {
        // 2 WORK, 1 MOVE - up to 6 WORK (5 drain a source)
        ratios: { [WORK]: 2, [MOVE]: 1 },
        unitCost: 250,
        minUnits: 1,
        maxUnits: 3
    },
    [BodyType.RESERVER]: {
        // 2 CLAIM, 2 MOVE - room reservation
        ratios: { [CLAIM]: 2, [MOVE]: 2 },
        unitCost: 1400,
        minUnits: 1,
        maxUnits: 2
    }
};

/**
 * Generate body parts for a given type and available energy
 */
export function generateBody(
    bodyType: BodyType,
    energy: number,
    emergency = false
): BodyPartConstant[] {
    const config = BODY_CONFIGS[bodyType];
    const body: BodyPartConstant[] = [];

    // Calculate how many units we can afford
    let units = Math.floor(energy / config.unitCost);
    units = Math.max(config.minUnits, Math.min(units, config.maxUnits));

    // In emergency, use what we have (at least 1 unit)
    if (emergency && units < config.minUnits) {
        units = config.minUnits;
    }

    // Build body from ratios
    for (let i = 0; i < units; i++) {
        for (const [part, count] of Object.entries(config.ratios)) {
            for (let j = 0; j < count; j++) {
                body.push(part as BodyPartConstant);
            }
        }
    }

    // Ensure we don't exceed 50 parts
    if (body.length > 50) {
        body.length = 50;
    }

    // Sort body parts for optimal order: TOUGH first, MOVE last
    // This protects valuable parts and ensures movement even when damaged
    return sortBodyParts(body);
}

/**
 * Sort body parts for optimal damage resistance
 * Order: TOUGH > WORK/CARRY/ATTACK/RANGED_ATTACK/HEAL/CLAIM > MOVE
 */
function sortBodyParts(body: BodyPartConstant[]): BodyPartConstant[] {
    const order: Record<BodyPartConstant, number> = {
        [TOUGH]: 0,
        [WORK]: 1,
        [CARRY]: 2,
        [ATTACK]: 3,
        [RANGED_ATTACK]: 4,
        [HEAL]: 5,
        [CLAIM]: 6,
        [MOVE]: 7
    };

    return [...body].sort((a, b) => order[a] - order[b]);
}

/**
 * Generate an optimized body that uses as much energy as possible
 * Adds extra parts if there's leftover energy after standard units
 */
export function generateOptimalBody(
    bodyType: BodyType,
    energy: number
): BodyPartConstant[] {
    // Config is retrieved for potential future use in optimization
    BODY_CONFIGS[bodyType];
    const body = generateBody(bodyType, energy);

    // Calculate remaining energy
    const usedEnergy = getBodyCost(body);
    let remaining = energy - usedEnergy;

    // Try to add extra parts with remaining energy
    if (remaining >= 50 && body.length < 50) {
        const partsToAdd: BodyPartConstant[] = [];

        // For workers, add extra WORK if affordable
        if (bodyType === BodyType.WORKER && remaining >= 100 + 50) {
            partsToAdd.push(WORK, MOVE);
            remaining -= 150;
        }

        // For transports, add extra CARRY
        if (bodyType === BodyType.TRANSPORT && remaining >= 50 + 50) {
            partsToAdd.push(CARRY, MOVE);
            remaining -= 100;
        }

        // Add parts while respecting 50 part limit
        for (const part of partsToAdd) {
            if (body.length < 50) {
                body.push(part);
            }
        }
    }

    return sortBodyParts(body);
}

/**
 * Calculate the cost of a body
 */
export function getBodyCost(body: BodyPartConstant[]): number {
    return body.reduce((sum, part) => sum + BODYPART_COST[part], 0);
}

/**
 * Count specific parts in a creep
 */
export function countParts(creep: Creep, partType: BodyPartConstant): number {
    return creep.body.filter(p => p.type === partType && p.hits > 0).length;
}

/**
 * Check if a creep has enough parts for a task
 */
export function hasRequiredParts(
    creep: Creep,
    requirements: Partial<Record<BodyPartConstant, number>>
): boolean {
    for (const [part, minCount] of Object.entries(requirements)) {
        if (countParts(creep, part as BodyPartConstant) < minCount) {
            return false;
        }
    }
    return true;
}
