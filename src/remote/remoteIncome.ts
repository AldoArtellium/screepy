/**
 * Remote economics: net energy per tick of a remote source, once its creeps are paid for. From
 * Harabi, "Optimizing Early Game Part One: Selecting Remotes"
 * (https://sy-harabi.github.io/Optimizing-Early-Game-Part-One-Selecting-Remotes/), with the bodies
 * our spawn role actually builds (remoteSpawnRole.ts). Not in Hivemind (3000 / path length).
 * Harabi's spawn-time budget (500 parts per spawn and 1500 ticks, minus the home's creeps) was
 * measured and dropped twice: see CLAUDE.md. sourceParts only ranks sources (RemoteMining.ts).
 * Also the CPU budget's average and cap decision (pure, checked by tests/remoteIncome/run.mjs).
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

/** MOVE parts for `count` other parts (plains 1:1, roads 1:2) */
function moveParts(count: number, roads: boolean): number {
    return roads ? Math.ceil(count / 2) : count;
}

/** Cost of `count` parts of `type` with their MOVE parts (plains 1:1, roads 1:2) */
function costWithMove(count: number, type: BodyPartConstant, roads: boolean): number {
    return count * BODYPART_COST[type] + moveParts(count, roads) * BODYPART_COST[MOVE];
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

/**
 * Body parts a remote source keeps its home spawning per CREEP_LIFE_TIME ticks: its harvester
 * (replaced `distance` ticks early), haulers and remote builders, with the bodies sourceNet prices.
 */
export function sourceParts(source: SourceEconomy): number {
    const { generation, distance, roads } = source;
    const lifetime = Math.max(1, CREEP_LIFE_TIME - distance);
    const work = Math.ceil(generation / HARVEST_POWER) + 1;
    const harvester = ((work + 1 + moveParts(work + 1, roads)) * CREEP_LIFE_TIME) / lifetime;
    const carry = (2 * distance * generation) / CARRY_CAPACITY;
    const haulers = carry + moveParts(carry, roads);
    const builderWork = source.maintenanceWork;
    const builderCarry = Math.ceil(builderWork * 2.5);
    const builders = builderWork + builderCarry + Math.ceil((builderWork + builderCarry) / 2);
    return harvester + haulers + builders;
}

export interface SourceCrew {
    harvesters: number;
    haulers: number;
    builders: number;
    /** Creeps alive at once (harvester replacements included) */
    creeps: number;
    /** Share of the generation the harvesters fit on the free tiles can extract */
    harvested: number;
}

/**
 * Creeps a remote source keeps alive with the bodies a home of `capacity` energy can spawn (bodies of
 * remoteSpawnRole.ts). The official CPU goes with creeps (code and intents), not body parts: a home at
 * 450 capacity mines a source with 2 harvesters of 2 WORK and haulers of 4 CARRY, ~3x the creeps of a
 * home at 1800 for the same energy (shard0 W28N7 next to W29N7).
 */
export function sourceCreeps(source: SourceEconomy, capacity: number, free: number): SourceCrew {
    const { generation, distance, roads } = source;

    const workNeeded = generation / HARVEST_POWER;
    const harvesterParts = Math.floor((MAX_CREEP_SIZE - 2) / (roads ? 1.5 : 2));
    const carryCost = BODYPART_COST[CARRY] + BODYPART_COST[MOVE];
    const workCost = BODYPART_COST[WORK] + BODYPART_COST[MOVE] / (roads ? 2 : 1);
    const workPerHarvester = Math.min(harvesterParts, Math.floor((capacity - carryCost) / workCost));
    if (workPerHarvester <= 0) return { harvesters: 0, haulers: 0, builders: 0, creeps: 0, harvested: 0 };
    const count = Math.min(Math.max(1, free), Math.ceil(workNeeded / workPerHarvester));
    const harvested = Math.min(1, (count * workPerHarvester) / workNeeded);
    const harvesters = (count * CREEP_LIFE_TIME) / Math.max(1, CREEP_LIFE_TIME - distance);

    // Haulers are pooled per home: fractions count
    const carry = (2 * distance * generation * harvested) / CARRY_CAPACITY;
    const carryPerHauler = Math.min(
        Math.floor(MAX_CREEP_SIZE / (roads ? 1.5 : 2)),
        Math.floor((0.9 * CONTAINER_CAPACITY) / CARRY_CAPACITY),
        Math.floor(capacity / (BODYPART_COST[CARRY] + BODYPART_COST[MOVE] / (roads ? 2 : 1)))
    );
    const haulers = carryPerHauler > 0 ? carry / carryPerHauler : 0;

    // Remote builders: CARRY 5 : WORK 2 on road bodies
    const builderUnit = 2 * BODYPART_COST[WORK] + 5 * BODYPART_COST[CARRY] + 4 * BODYPART_COST[MOVE];
    const units = Math.min(Math.floor(MAX_CREEP_SIZE / 11), Math.floor(capacity / builderUnit));
    const workPerBuilder = Math.max(1, 2 * units);
    const builders = source.maintenanceWork / workPerBuilder;

    return { harvesters, haulers, builders, creeps: harvesters + haulers + builders, harvested };
}

/**
 * Net energy per creep of a remote room: the share of each source's net income its harvesters reach,
 * minus the reserver, over the creeps of its sources and its reservers. The CPU budget keeps the rooms
 * that pay the most per creep.
 */
export function roomEnergyPerCreep(
    sources: { net: number; crew: SourceCrew }[],
    reserverEnergy: number,
    reservers: number
): number {
    let net = -reserverEnergy;
    let creeps = reservers;
    for (const { net: sourceIncome, crew } of sources) {
        net += sourceIncome * crew.harvested;
        creeps += crew.creeps;
    }
    return creeps > 0 ? net / creeps : 0;
}

// ------------------------------------------------------------------ CPU budget (RemoteMining.ts updateBudget)

/** Above this share of the CPU limit (or below 5000 bucket) the remote budget drops a room */
export const BUDGET_HIGH = 0.95;
/** Below this share (bucket > 9000) it allows one more */
export const BUDGET_LOW = 0.75;
/** Bucket counted as full, and how long it must stay full to allow a room up to BUDGET_HIGH */
export const BUDGET_FULL_BUCKET = 9900;
export const BUDGET_FULL_TICKS = 1000;
/** Weight of one tick in the CPU average: ~400 ticks */
const CPU_AVG_DECAY = 1 / 400;

/** Slow average of the tick CPU after `count` more ticks summing `sum` CPU; each tick weighs 1/400 */
export function cpuAverage(previous: number | undefined, sum: number, count: number): number | undefined {
    if (count === 0) return previous;
    const window = sum / count;
    if (previous === undefined) return window;
    const alpha = 1 - Math.pow(1 - CPU_AVG_DECAY, count);
    return previous * (1 - alpha) + window * alpha;
}

export interface BudgetState {
    cpuAvg: number;
    limit: number;
    bucket: number;
    /** Ticks the bucket has stayed at BUDGET_FULL_BUCKET or more */
    fullBucketTicks: number;
    /** Current cap (undefined: none) */
    maxRooms: number | undefined;
    /** Remote rooms mined now, and rooms the homes would mine without a cap */
    currentRooms: number;
    possibleRooms: number;
}

/** Next cap on remote rooms (undefined: none); the caller limits the changes to one per 1000 ticks */
export function budgetRooms(state: BudgetState): number | undefined {
    const { cpuAvg, limit, bucket, maxRooms } = state;
    if (cpuAvg > limit * BUDGET_HIGH || bucket < 5000) return Math.max(0, state.currentRooms - 1);
    if (maxRooms === undefined) return undefined;
    const spare = cpuAvg < limit * BUDGET_LOW && bucket > 9000;
    // A bucket full for long: the CPU left over is spent on nothing (shard0 W27N5 at 15/20 stayed capped)
    const unused = state.fullBucketTicks >= BUDGET_FULL_TICKS;
    if (!spare && !unused) return maxRooms;
    return maxRooms >= state.possibleRooms ? undefined : maxRooms + 1;
}
