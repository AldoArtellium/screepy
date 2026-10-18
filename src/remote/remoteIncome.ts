/**
 * Remote economics: net energy per tick of a remote source, once its creeps are paid for. From
 * Harabi, "Optimizing Early Game Part One: Selecting Remotes"
 * (https://sy-harabi.github.io/Optimizing-Early-Game-Part-One-Selecting-Remotes/), with the bodies
 * our spawn role actually builds (remoteSpawnRole.ts). Not in Hivemind (3000 / path length).
 * Harabi's spawn-time budget (500 parts per spawn and 1500 ticks, minus the home's creeps, rooms
 * chosen by a knapsack) was measured and dropped: see CLAUDE.md.
 */

export interface SourceEconomy {
    /** Energy per tick the source yields (10 reserved, 5 neutral) */
    generation: number;
    /** Path length source -> home storage */
    distance: number;
    /** Roads (storage era): haulers and harvesters get road bodies */
    roads: boolean;
    /** WORK of the remote builders keeping its container and roads up (0 before the storage) */
    maintenanceWork: number;
}

/** Container decay outside owned rooms: 5000 hits per 100 ticks, repaired at 100 hits per energy */
const CONTAINER_UPKEEP = CONTAINER_DECAY / CONTAINER_DECAY_TIME / REPAIR_POWER;

/** Cost of `count` parts of `type` with their MOVE parts (plains 1:1, roads 1:2) */
function costWithMove(count: number, type: BodyPartConstant, roads: boolean): number {
    const moves = roads ? Math.ceil(count / 2) : count;
    return count * BODYPART_COST[type] + moves * BODYPART_COST[MOVE];
}

/** Net energy per tick of a remote source: its generation minus its harvester, haulers, builders and container */
export function sourceNet(source: SourceEconomy): number {
    const { generation, distance, roads } = source;
    const lifetime = Math.max(1, CREEP_LIFE_TIME - distance);

    // Harvester: the spawn role asks for one WORK more than the source needs, plus a CARRY
    const work = Math.ceil(generation / HARVEST_POWER) + 1;
    const harvesterCost = (costWithMove(work + 1, WORK, roads) - BODYPART_COST[WORK] + BODYPART_COST[CARRY]) / lifetime;

    // Haulers: CARRY = 2 x distance x energy per tick / 50 (remoteSpawnRole requiredCarry)
    const carry = (2 * distance * generation) / CARRY_CAPACITY;
    const haulerCost = costWithMove(carry, CARRY, roads) / CREEP_LIFE_TIME;

    // Remote builders (storage era): CARRY 5 : WORK 2 on road bodies
    const builderWork = source.maintenanceWork;
    const builderCarry = Math.ceil(builderWork * 2.5);
    const builderMoves = Math.ceil((builderWork + builderCarry) / 2);
    const builderCost =
        (builderWork * BODYPART_COST[WORK] + builderCarry * BODYPART_COST[CARRY] + builderMoves * BODYPART_COST[MOVE]) /
        CREEP_LIFE_TIME;

    return generation - harvesterCost - haulerCost - builderCost - CONTAINER_UPKEEP;
}

/** One CLAIM + MOVE reserver kept on the controller: 650 energy per (600 - distance) ticks */
export function reserverCost(distance: number): number {
    return (BODYPART_COST[CLAIM] + BODYPART_COST[MOVE]) / Math.max(1, CREEP_CLAIM_LIFE_TIME - distance);
}
