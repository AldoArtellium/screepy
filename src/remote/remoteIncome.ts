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

/**
 * One CLAIM + MOVE reserver kept on the controller: 650 energy per (600 - distance) ticks. Under CPU
 * pressure (`cpuPressure`) its official CPU is priced too, at the energy per CPU of a neutral remote
 * source at that distance (`neutralEnergyPerCpu`): a room whose reservation doesn't pay per CPU is
 * not reserved then (remoteSpawnRole `reservationPays`), and the CPU-priced reserver brings the
 * reserved score of such a room down to about its unreserved income (sourceNet at 5 energy per tick).
 */
export function reserverCost(distance: number, pressure = cpuPressure()): number {
    const energy = (BODYPART_COST[CLAIM] + BODYPART_COST[MOVE]) / Math.max(1, CREEP_CLAIM_LIFE_TIME - distance);
    if (!pressure) return energy;
    return energy + reserverCpu(1, distance) * neutralEnergyPerCpu(distance);
}

// ------------------------------------------------------------------ reservations under CPU pressure

/** Official CPU of an intent */
export const INTENT_CPU = 0.2;
/** Code CPU of a remote creep per tick (shard0: remote haulers 0.069; mockup: reservers 0.03-0.05) */
export const CREEP_CODE_CPU = 0.06;
/** Share of the CPU limit above which the reservations are judged per CPU (or while the remote budget is capped) */
export const RESERVE_CPU_PRESSURE = 0.85;

/** CPU is the binding constraint: the remote budget is capped, or the CPU average is above 85% of the limit */
export function cpuPressure(): boolean {
    if (typeof Memory === "undefined" || typeof Game === "undefined") return false;
    if (Memory.remoteMining?.maxRooms !== undefined) return true;
    return (Memory.stats?.cpuAvg ?? 0) > Game.cpu.limit * RESERVE_CPU_PRESSURE;
}

/** CLAIM parts of the reservers a home of `capacity` energy spawns (remoteSpawnRole reserverBody) */
export function reserverClaimParts(capacity: number): number {
    const unit = BODYPART_COST[CLAIM] + BODYPART_COST[MOVE];
    return Math.min(Math.floor(CONTROLLER_RESERVE_MAX / CREEP_CLAIM_LIFE_TIME), Math.floor(capacity / unit));
}

/**
 * Ticks one reserver keeps a reservation up: on station it adds `claimParts` per tick against a decay
 * of 1, so a 2-CLAIM reserver holds the room for twice its time on station (when it is not sent before
 * the reservation needs it, see remoteSpawnRole reserverOption).
 */
export function reserverPeriod(claimParts: number, distance: number): number {
    return Math.max(1, claimParts) * Math.max(1, CREEP_CLAIM_LIFE_TIME - distance);
}

/** Official CPU per tick of keeping a room reserved: code over the reserver's life, a move per tile, a reserve per tick on station */
export function reserverCpu(claimParts: number, distance: number): number {
    return (CREEP_CLAIM_LIFE_TIME * (CREEP_CODE_CPU + INTENT_CPU)) / reserverPeriod(claimParts, distance);
}

/** CARRY per remote hauler a home of `capacity` energy builds (remoteSpawnRole haulerSize upper bound) */
export function haulerCarryParts(capacity: number, roads: boolean): number {
    return Math.max(
        1,
        Math.min(
            Math.floor(MAX_CREEP_SIZE / (roads ? 1.5 : 2)),
            Math.floor((0.9 * CONTAINER_CAPACITY) / CARRY_CAPACITY),
            Math.floor(capacity / (BODYPART_COST[CARRY] + BODYPART_COST[MOVE] / (roads ? 2 : 1)))
        )
    );
}

/**
 * Official CPU per tick of mining a remote source: the harvester (code, a move per tile on its way, a
 * harvest per tick while the source has energy: its WORK drain it faster than it regenerates) and the
 * haulers (code, a move per tile both ways and a withdraw + a transfer per trip of `haulerCarry` CARRY).
 * Remote builders left out (storage era, the same with or without a reservation).
 */
export function sourceCpu(source: SourceEconomy, haulerCarry: number): number {
    const { generation, distance } = source;
    const lifetime = Math.max(1, CREEP_LIFE_TIME - distance);
    const work = Math.ceil(generation / HARVEST_POWER) + 1;
    const harvests = generation / (work * HARVEST_POWER);
    const harvester = (CREEP_LIFE_TIME * CREEP_CODE_CPU + distance * INTENT_CPU) / lifetime + harvests * INTENT_CPU;
    const trips = generation / (Math.max(1, haulerCarry) * CARRY_CAPACITY);
    const haulers = trips * (2 * distance * (CREEP_CODE_CPU + INTENT_CPU) + 2 * INTENT_CPU);
    return harvester + haulers;
}

/** Energy per official CPU of a neutral (5 energy per tick) remote source at `distance`, plains bodies */
export function neutralEnergyPerCpu(distance: number, capacity = 1300): number {
    const neutral: SourceEconomy = {
        generation: SOURCE_ENERGY_NEUTRAL_CAPACITY / ENERGY_REGEN_TIME,
        distance,
        roads: false,
        maintenanceWork: 0
    };
    return Math.max(0, sourceNet(neutral)) / sourceCpu(neutral, haulerCarryParts(capacity, false));
}

export interface ReservationValue {
    /** Energy per tick the reservation adds: the sources at 10 instead of 5, minus their bigger crews and the reservers */
    energy: number;
    /** Official CPU per tick it adds: reservers, and the haulers' extra trips */
    cpu: number;
    /** energy / cpu */
    perCpu: number;
    /** Energy per CPU of a neutral source at the same distance: what the CPU would mine elsewhere */
    alternative: number;
    pays: boolean;
}

/**
 * Whether reserving a remote room pays per official CPU (not in Hivemind, which reserves every room
 * it can): the energy the reservation adds over the CPU it adds, against the energy per CPU of a
 * neutral source, which the remote budget would mine with that CPU instead. `source` describes the
 * room's average source (its `generation` is ignored), `sources` the sources mined there.
 * A one-source room doesn't pay, with 1-CLAIM (650-1299 capacity, 3.8 vs 5.3 at 50 tiles) or 2-CLAIM reservers
 * (7.6 vs 8.4): close margins, so the decision follows CREEP_CODE_CPU; two-source rooms pay (5.7, 11.2).
 */
export function reservationValue(source: SourceEconomy, sources: number, capacity: number): ReservationValue {
    const claimParts = Math.max(1, reserverClaimParts(capacity));
    const haulerCarry = haulerCarryParts(capacity, source.roads);
    const reserved = { ...source, generation: SOURCE_ENERGY_CAPACITY / ENERGY_REGEN_TIME };
    const neutral = { ...source, generation: SOURCE_ENERGY_NEUTRAL_CAPACITY / ENERGY_REGEN_TIME };
    const period = reserverPeriod(claimParts, source.distance);
    const reserverEnergy = (claimParts * (BODYPART_COST[CLAIM] + BODYPART_COST[MOVE])) / period;
    const energy = sources * (sourceNet(reserved) - sourceNet(neutral)) - reserverEnergy;
    const haulCpu = sourceCpu(reserved, haulerCarry) - sourceCpu(neutral, haulerCarry);
    const cpu = sources * haulCpu + reserverCpu(claimParts, source.distance);
    const perCpu = cpu > 0 ? energy / cpu : 0;
    const alternative = Math.max(0, sourceNet(neutral)) / sourceCpu(neutral, haulerCarry);
    return { energy, cpu, perCpu, alternative, pays: energy > 0 && perCpu >= alternative };
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

/**
 * Above this share of the CPU limit the remote budget drops a room, unless the bucket holds
 * BUDGET_FULL_BUCKET (the bucket is the margin: it only falls above the limit); above the limit
 * or below 5000 bucket it always drops one
 */
export const BUDGET_HIGH = 0.95;
/** Below this share (bucket > 9000) it allows one more */
export const BUDGET_LOW = 0.75;
/**
 * Bucket counted as full, and how long it must stay full to allow a room while above BUDGET_LOW
 * (9900 before 2026-10-25: shard0's bucket dipped to 8964-9867 in every window of 1000 ticks from the
 * periodic modules' spikes, so it never counted as full and ~1.5 of 20 CPU went unused)
 */
export const BUDGET_FULL_BUCKET = 9000;
export const BUDGET_FULL_TICKS = 1000;
/**
 * One more room only when the average plus that room's CPU stays under this share of the limit:
 * a margin, so the room added is not dropped again (shard0 at ~90% of 20 CPU: 7 -> 8 -> 7 rooms in
 * 5 of 6 windows of 1000 ticks, the bucket falling, while a room's CPU was counted without its moves)
 */
export const BUDGET_FIT = 0.9;
/** The same share once the bucket stayed full for BUDGET_FULL_TICKS: CPU left over is lost */
export const BUDGET_FIT_FULL = 0.98;
/**
 * Least CPU per tick counted for one remote room. 1.2 while the measure left out the moves; with
 * them shard0 measured 0.86 (2026-10-25, 7 rooms: 0.48 code and intents, 0.38 moves)
 */
export const BUDGET_ROOM_CPU_MIN = 0.8;
/** No room added for this many ticks after a drop: the dropped room's creeps die out, the average settles */
export const BUDGET_RAISE_HOLD = 5000;
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
    /** Measured CPU per tick of one remote room (its remote creeps; undefined: not measured yet) */
    roomCpu?: number;
    /** Ticks since the cap last went down (undefined: never) */
    ticksSinceDrop?: number;
}

/** Remote rooms from which an expansion may use the whole CPU limit (Hivemind getCpuStats) */
export const EXPANSION_REMOTE_ROOMS = 5;
/** Share of the CPU limit an expansion needs below EXPANSION_REMOTE_ROOMS remote rooms */
export const EXPANSION_CPU_SHARE = 0.8;

/**
 * CPU gate of an expansion (Hivemind expand.ts getCpuStats): below 80% of the limit with fewer than 5
 * remote rooms, below the limit from 5 on, where the remote budget drops remote rooms (BUDGET_HIGH)
 * to make room for the new one. The 80% used to apply as soon as we owned 2 rooms: shard0 (8 remote
 * rooms, 17-19 of 20 CPU, the budget filling up to 95%) never expanded.
 */
export function expansionCpuFits(cpuAvg: number | undefined, limit: number, remoteRooms: number): boolean {
    if (cpuAvg === undefined) return false;
    return cpuAvg < limit * (remoteRooms < EXPANSION_REMOTE_ROOMS ? EXPANSION_CPU_SHARE : 1);
}

/** CPU counted for one more remote room: the measurement, at least BUDGET_ROOM_CPU_MIN */
export function budgetRoomCpu(measured: number | undefined): number {
    return Math.max(BUDGET_ROOM_CPU_MIN, measured ?? 0);
}

/** Next cap on remote rooms (undefined: none); the caller limits the changes to one per 1000 ticks */
export function budgetRooms(state: BudgetState): number | undefined {
    const { cpuAvg, limit, bucket, maxRooms } = state;
    const high = cpuAvg > limit || (cpuAvg > limit * BUDGET_HIGH && bucket < BUDGET_FULL_BUCKET);
    if (high || bucket < 5000) return Math.max(0, state.currentRooms - 1);
    if (maxRooms === undefined) return undefined;
    if (state.ticksSinceDrop !== undefined && state.ticksSinceDrop < BUDGET_RAISE_HOLD) return maxRooms;
    const spare = cpuAvg < limit * BUDGET_LOW && bucket > 9000;
    // A bucket full for long: the CPU left over is spent on nothing (shard0 W27N5 at 15/20 stayed capped)
    const unused = state.fullBucketTicks >= BUDGET_FULL_TICKS;
    if (!spare && !unused) return maxRooms;
    const fits = cpuAvg + budgetRoomCpu(state.roomCpu) <= limit * (unused ? BUDGET_FIT_FULL : BUDGET_FIT);
    if (!fits) return maxRooms;
    return maxRooms >= state.possibleRooms ? undefined : maxRooms + 1;
}
