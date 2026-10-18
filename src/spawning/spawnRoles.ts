/**
 * Spawn roles: each one tells what it wants spawned in a room, as options (priority, weight).
 * Rules ported from Hivemind (MIT), src/spawn-role/{harvester,harvester.minerals,transporter,builder,upgrader,room-defense}.ts.
 * See docs/hivemind/hivemind-spawning.md for the exact rules and their sources.
 */

import { buildBody, MoveMode } from "../core/bodyBuilder";
import { Option } from "../core/options";
import {
    activeParts,
    controllerContainer,
    controllerLink,
    controllerRefillPathLength,
    creepsByRole,
    effectiveEnergy,
    harvestSpots,
    hasEnemies,
    mineralContainer,
    linkNetwork,
    mySpawns,
    sourceContainer,
    sourceLink,
    storageLocation
} from "../core/roomState";
import { roomPlanner } from "../planner/RoomPlanner";
import {
    DefenseOption,
    REMOTE_DEFENDER,
    remoteDefenderBody,
    remoteDefenderMemory,
    remoteDefenseOptions
} from "../remote/remoteDefense";
import { reclaimSpawnRole, squadSpawnRole } from "../expansion/squadSpawnRole";
import { militarySpawnRole } from "../military/military";
import { remoteSpawnRole } from "../remote/remoteSpawnRole";
import { ENEMY_STRENGTH_NORMAL, enemyStrength } from "../defense/RoomDefense";
import { GUARDIAN } from "../roles/guardian";
import { isFullOn } from "../core/resources";
import { boostLabs, boostsFor } from "../labs/boosts";
import { HELPER } from "../roles/helper";
import { jitter } from "../utils/jitter";

export interface SpawnOption extends Option {
    role: string;
    /** Spawn next to this position when a spawn is close (harvesters) */
    preferClosestSpawn?: RoomPosition;
    source?: Id<Source>;
    mineral?: Id<Mineral>;
    size?: number;
    force?: boolean;
    mini?: boolean;
    /** External requests carry their own body and memory */
    body?: BodyPartConstant[];
    memory?: Partial<CreepMemory>;
    requestId?: string;
}

export interface SpawnRole {
    readonly id: string;
    /** Ticks a room is not asked again after an empty answer */
    readonly emptyTimeout: number;
    options(room: Room): SpawnOption[];
    body(room: Room, option: SpawnOption): BodyPartConstant[];
    memory(room: Room, option: SpawnOption): Partial<CreepMemory>;
    /** Compound per body part type to boost the new creep with (Hivemind getCreepBoosts) */
    boosts?(room: Room, option: SpawnOption, body: BodyPartConstant[]): Partial<Record<BodyPartConstant, ResourceConstant>>;
}

/**
 * Rooms whose energy stopped rising while waiting for a body they can't pay (set by the SpawnManager).
 * Not in Hivemind: its "force" sizing only kicks in with no harvester at all, and W9N5 (swamps, far
 * source) deadlocked with spawn full and extensions empty until the controller downgraded.
 */
export const starvedRooms: Set<string> = new Set();

/** Energy used to size a body: max(minimum, available), never above capacity */
function energyLimit(room: Room, minimum: number): number {
    if (starvedRooms.has(room.name)) return Math.max(room.energyAvailable, SPAWN_ENERGY_CAPACITY / 2);
    return Math.min(room.energyCapacityAvailable, Math.max(minimum, room.energyAvailable));
}

function isEarlyGame(room: Room): boolean {
    return !room.storage && !room.terminal;
}

function spawnDistance(room: Room, pos: RoomPosition): number {
    const spawns = mySpawns(room);
    if (spawns.length === 0) return 0;
    return _.min(spawns.map(s => s.pos.getRangeTo(pos)));
}

// ------------------------------------------------------------------ harvester

/** Room has no harvester left (and no storage, or a nearly empty one) */
function isSmallHarvesterNeeded(room: Room): boolean {
    if (creepsByRole(room.name, "harvester").length > 0) return false;
    if (!room.storage) return true;
    return effectiveEnergy(room) < 5000;
}

/** 5 WORK drain a 3000-energy source in 300 ticks */
function maxWorkParts(source: Source): number {
    return source.energyCapacity / ENERGY_REGEN_TIME / 2;
}

function sourceHarvesters(room: Room, source: Source): Creep[] {
    return creepsByRole(room.name, "harvester").filter(c => c.memory.fixedSource === source.id);
}

const harvester: SpawnRole = {
    id: "harvester",
    emptyTimeout: 10,

    options(room) {
        const options: SpawnOption[] = [];
        for (const source of room.find(FIND_SOURCES)) {
            const distance = spawnDistance(room, source.pos);
            const harvesters = sourceHarvesters(room, source);
            const maxWork = maxWorkParts(source);

            // Replacement: a harvester about to die no longer counts
            const active = harvesters.filter(c => c.spawning || (c.ticksToLive ?? 0) > c.body.length * CREEP_SPAWN_TIME + distance);
            if (active.length === 0) {
                const force = isSmallHarvesterNeeded(room);
                options.push({
                    role: this.id,
                    priority: force ? 6 : isEarlyGame(room) ? 5 : 4,
                    weight: (50 - distance) / 50,
                    source: source.id,
                    preferClosestSpawn: source.pos,
                    size: maxWork,
                    force
                });
            }

            // Up to RCL 3, more small harvesters until the source has 5 WORK
            if ((room.controller?.level ?? 0) > 3) continue;
            if (harvesters.length >= harvestSpots(source)) continue;
            const work = activeParts(harvesters, WORK);
            if (work < maxWork) {
                options.push({
                    role: this.id,
                    priority: isEarlyGame(room) ? 5 : 4,
                    weight: 1 - work / maxWork / 2 - (50 - distance) / 100,
                    source: source.id,
                    preferClosestSpawn: source.pos,
                    size: maxWork,
                    force: false
                });
            }
        }
        return options;
    },

    body(room, option) {
        const source = Game.getObjectById(option.source!);
        const hasSpawnAtSource = !!source && mySpawns(room).some(s => s.pos.inRangeTo(source, 2));
        const fewExtensions = room.energyCapacityAvailable < SPAWN_ENERGY_CAPACITY * 2;
        return buildBody({
            weights: { [WORK]: 4, [CARRY]: 1 },
            partLimits: { [WORK]: option.size },
            moveMode: hasSpawnAtSource || fewExtensions ? MoveMode.MINIMAL : MoveMode.ROAD,
            carryContentLevel: 0,
            energyLimit: energyLimit(room, option.force ? 300 : room.energyCapacityAvailable)
        });
    },

    memory(room, option) {
        return { role: this.id, room: room.name, fixedSource: option.source };
    }
};

// ------------------------------------------------------------------ mineral harvester

/**
 * One harvester per mineral with an active extractor, a container and minerals left, once the room has
 * 5000 effective energy and is not full on minerals (Hivemind spawn-role/harvester.minerals.ts)
 */
const mineralHarvester: SpawnRole = {
    id: "mineralHarvester",
    emptyTimeout: 50,

    options(room) {
        if (effectiveEnergy(room) < 5000) return [];
        const options: SpawnOption[] = [];
        for (const mineral of room.find(FIND_MINERALS)) {
            if (mineral.mineralAmount <= 0) continue;
            const extractor = mineral.pos.lookFor(LOOK_STRUCTURES).find(s => s.structureType === STRUCTURE_EXTRACTOR) as
                | StructureExtractor
                | undefined;
            if (!extractor?.my || !extractor.isActive()) continue;
            if (!mineralContainer(mineral)) continue;
            if (isFullOn(room, mineral.mineralType)) return [];
            const harvesters = creepsByRole(room.name, this.id).filter(
                c => c.memory.fixedMineralSource === mineral.id && (c.spawning || (c.ticksToLive ?? 0) > c.body.length * CREEP_SPAWN_TIME)
            );
            if (harvesters.length >= 1) continue;
            options.push({ role: this.id, priority: 3, weight: 0.2, preferClosestSpawn: mineral.pos, mineral: mineral.id });
        }
        return options;
    },

    body(room) {
        return buildBody({
            weights: { [CARRY]: 1, [WORK]: 10 },
            moveMode: MoveMode.ROAD,
            carryContentLevel: 0,
            energyLimit: Math.min(room.energyCapacityAvailable, Math.max(room.energyCapacityAvailable * 0.9, room.energyAvailable))
        });
    },

    memory(room, option) {
        return { role: this.id, room: room.name, fixedMineralSource: option.mineral };
    }
};

// ------------------------------------------------------------------ transporter

/** Enough CARRY to fill a spawn and 6 extensions in one trip */
function transporterSize(room: Room): number {
    const rcl = room.controller?.level ?? 1;
    const extension = EXTENSION_ENERGY_CAPACITY[rcl] ?? 50;
    return Math.ceil((Math.max(SPAWN_ENERGY_CAPACITY, extension) + 6 * extension) / CARRY_CAPACITY);
}

function transporterBaseAmount(room: Room): number {
    const rcl = room.controller?.level ?? 0;
    if (rcl < 3) return 1;
    if (rcl < 4) return 2;
    if (!room.storage && !room.terminal) return effectiveEnergy(room) > 1000 ? 2 : 1;
    const sources = room.find(FIND_SOURCES);
    let amount = 2 + 2 * sources.length;
    // Links beam energy around: fewer transporters
    if (controllerLink(room)) amount -= 1 + sources.filter(s => sourceLink(s)).length;
    if (rcl === 5) amount++;
    if (rcl === 6) amount++;
    return amount;
}

/** Upgrader energy consumed while a delivery walks from the storage location */
function extraUpgraderTransporters(room: Room, size: number): number {
    const work = activeParts(creepsByRole(room.name, "upgrader"), WORK);
    if (work === 0) return 0;
    const energy = work * UPGRADE_CONTROLLER_POWER * controllerRefillPathLength(room) * 1.8;
    return Math.floor(energy / CARRY_CAPACITY / size);
}

/**
 * Transporters needed to carry every source's output to the storage location, from the loaded round
 * trip time (plain 2, swamp 10 ticks per tile with 1 MOVE per 2 CARRY). Not in Hivemind (its
 * estimateNeededCarryParts is a TODO): its fixed 3 transporters left most of W9N5's energy rotting
 * by far swampy sources.
 */
const haulTrips: Map<string, { until: number; roundTrips: { [source: string]: number }; swampShare: number }> = new Map();
function haulPaths(room: Room): { roundTrips: { [source: string]: number }; swampShare: number } {
    let cached = haulTrips.get(room.name);
    if (!cached || cached.until < Game.time) {
        const from = storageLocation(room);
        const roundTrips: { [source: string]: number } = {};
        let tiles = 0;
        let swamps = 0;
        const terrain = room.getTerrain();
        if (from) {
            for (const source of room.find(FIND_SOURCES)) {
                const result = PathFinder.search(from, { pos: source.pos, range: 1 }, {
                    maxRooms: 1,
                    plainCost: 2,
                    swampCost: 10
                });
                if (result.incomplete) continue;
                roundTrips[source.id] = result.cost + result.path.length;
                tiles += result.path.length;
                swamps += result.path.filter(p => terrain.get(p.x, p.y) === TERRAIN_MASK_SWAMP).length;
            }
        }
        cached = { until: Game.time + jitter(CREEP_LIFE_TIME), roundTrips, swampShare: tiles ? swamps / tiles : 0 };
        haulTrips.set(room.name, cached);
    }
    return cached;
}

/**
 * Bodies sized for roads crawl through swamps (10 ticks per tile loaded). Not in Hivemind: while the
 * room has few roads and its haul paths are mostly swamp, size movers for plains instead.
 */
const SWAMPY_SHARE = 0.3;
function moverMode(room: Room): MoveMode {
    if (haulPaths(room).swampShare < SWAMPY_SHARE) return MoveMode.ROAD;
    const roads = room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_ROAD }).length;
    return roads >= 20 ? MoveMode.ROAD : MoveMode.PLAINS;
}

/**
 * Source output the links carry instead of transporters (Hivemind's TODO: exclude sources with links
 * once the controller link exists): all of it with a neutral (storage) link to absorb the surplus,
 * else what the upgraders draw from the controller link, farthest linked sources first.
 */
function linkedShares(room: Room, energyPerTick: number): Map<string, number> {
    const shares: Map<string, number> = new Map();
    const network = linkNetwork(room);
    if (!network || !controllerLink(room)) return shares;
    let capacity = network.neutral.length > 0 ? Infinity : activeParts(creepsByRole(room.name, "upgrader"), WORK) * UPGRADE_CONTROLLER_POWER;
    const controller = room.controller!.pos;
    const linked = _.sortBy(room.find(FIND_SOURCES).filter(s => sourceLink(s)), s => -s.pos.getRangeTo(controller));
    for (const source of linked) {
        const covered = Math.min(energyPerTick, capacity);
        shares.set(source.id, covered / energyPerTick);
        capacity -= covered;
    }
    return shares;
}

function haulTransporters(room: Room, size: number): number {
    const cached = haulPaths(room);
    const carry = transporter.body(room, { role: "transporter", priority: 0, weight: 0, size }).filter(p => p === CARRY).length;
    if (carry === 0) return 0;
    const energyPerTick = SOURCE_ENERGY_CAPACITY / ENERGY_REGEN_TIME;
    const linked = linkedShares(room, energyPerTick);
    const roundTrip = _.sum(Object.keys(cached.roundTrips), id => cached.roundTrips[id] * (1 - (linked.get(id) ?? 0)));
    return (energyPerTick * roundTrip) / (carry * CARRY_CAPACITY);
}

function transporterAmount(room: Room, size: number): number {
    const rcl = room.controller?.level ?? 0;
    let amount = Math.max((transporterBaseAmount(room) * 2) / 3 / size, rcl > 6 ? 2 : 3, haulTransporters(room, size));
    if (rcl < 4) {
        for (const source of room.find(FIND_SOURCES)) {
            const container = sourceContainer(source);
            if (container && container.store.getFreeCapacity() < container.store.getCapacity() / 4) amount++;
        }
    }
    return amount + extraUpgraderTransporters(room, size);
}

const transporter: SpawnRole = {
    id: "transporter",
    emptyTimeout: 10,

    options(room) {
        const size = transporterSize(room);
        const max = transporterAmount(room, size);
        const count = creepsByRole(room.name, "transporter").length;
        if (count >= max) return [];

        const hasStorage = !!(room.storage || room.terminal);
        const option: SpawnOption = { role: this.id, priority: hasStorage ? 6 : 5, weight: 0.5, force: false, size };
        const hasExtensions = room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_EXTENSION }).length > 0;
        const hasWorkers = creepsByRole(room.name, "builder").length + creepsByRole(room.name, "upgrader").length > 0;
        if (count >= max / 2) {
            option.priority -= 2;
        } else if (count >= 1) {
            option.priority -= 1;
            // Hivemind: weight 0, below builders (4 / 0.5). Not in Hivemind: with too few transporters
            // energy rots by the sources while it still counts in the builder quota, so builders kept
            // winning and the room choked (W9N5)
            option.weight = 0.6;
        } else if (hasStorage || hasExtensions) {
            option.force = true;
            option.weight = 1;
        } else if (!hasWorkers) {
            const distance = _.min(room.find(FIND_SOURCES).map(s => spawnDistance(room, s.pos)));
            if (distance < 5) {
                option.priority -= 1;
                option.weight = 0;
            }
        }
        return [option];
    },

    body(room, option) {
        return buildBody({
            weights: { [CARRY]: 1 },
            partLimits: { [CARRY]: option.size ?? 8 },
            moveMode: moverMode(room),
            energyLimit: energyLimit(room, option.force ? 250 : room.energyCapacityAvailable * 0.9)
        });
    },

    memory(room) {
        return { role: this.id, room: room.name };
    }
};

// ------------------------------------------------------------------ builder

function neededBuilderWork(room: Room): number {
    const sites = room.find(FIND_MY_CONSTRUCTION_SITES).length;
    const hasStorage = !!(room.storage || room.terminal);
    const noBuilderNeeded = room.memory.noBuilderNeeded;
    if (sites === 0 && noBuilderNeeded && Game.time - noBuilderNeeded < 1500 && hasStorage) return 0;
    const energy = effectiveEnergy(room);
    if (hasStorage && energy < 5000) return 0;
    if (!roomPlanner.getPlan(room.name)) return 0;
    if (hasStorage && energy < 10000) return 1;
    const harvesters = creepsByRole(room.name, "harvester").length;
    if (energy < 10000 && harvesters <= 1 && harvesters < room.find(FIND_SOURCES).length) return 1;

    const rcl = room.controller?.level ?? 0;
    let work = 5;
    if (rcl > 2) work += 5;
    if (!hasStorage) work *= 1 + energy / 3000;
    else if (energy > 400000) work *= 2;
    else if (energy > 200000) work *= 1.5;
    if (rcl > 3) work += sites / 2;
    return work;
}

const builder: SpawnRole = {
    id: "builder",
    emptyTimeout: 50,

    options(room) {
        const maxWork = neededBuilderWork(room);
        if (activeParts(creepsByRole(room.name, "builder"), WORK) >= maxWork) return [];
        const hasSites = room.find(FIND_MY_CONSTRUCTION_SITES).length > 0;
        return [{ role: this.id, priority: hasSites ? 4 : 3, weight: 0.5 }];
    },

    body(room) {
        return buildBody({
            weights: { [WORK]: 4, [CARRY]: 3 },
            moveMode: moverMode(room),
            energyLimit: energyLimit(room, room.energyCapacityAvailable * 0.9)
        });
    },

    memory(room) {
        return { role: this.id, room: room.name };
    }
};

// ------------------------------------------------------------------ upgrader

function isCloseToDowngrade(room: Room): boolean {
    const controller = room.controller!;
    return controller.ticksToDowngrade < CONTROLLER_DOWNGRADE[controller.level] * 0.1;
}

/**
 * Not in Hivemind (0 upgraders before the storage, builders upgrade once construction is done): when
 * construction never ends (W9N5, swamp roads) the controller never progressed. One upgrader from RCL 2.
 */
const EARLY_UPGRADERS = 1;

function baseUpgraderAmount(room: Room): number {
    if (!room.storage && !room.terminal) return (room.controller?.level ?? 0) >= 2 ? EARLY_UPGRADERS : 0;
    const rcl = room.controller?.level ?? 0;
    const reserve: { [rcl: number]: number } = { 5: 10000, 6: 25000, 7: 50000, 8: 100000 };
    const energy = effectiveEnergy(room) - (reserve[rcl] ?? 0);
    const bucket = Game.cpu.bucket;
    if (energy < (rcl === 7 ? 25000 : 10000)) return 0;
    if (energy < (rcl === 7 ? 75000 : 50000)) return 1;
    if (energy < 100000 && bucket > 5000) return 2;
    if (energy < 150000 && bucket > 7000) return 3;
    if (energy < 200000 && bucket > 8000) return 4;
    if (energy < 250000 && bucket > 9000) return 5;
    return 6;
}

function upgraderAmount(room: Room): number {
    const base = baseUpgraderAmount(room);
    if (base > 0) return base;
    const controller = room.controller!;
    if (isCloseToDowngrade(room)) return 1;
    if (controller.ticksToDowngrade < CONTROLLER_DOWNGRADE[controller.level] * 0.5 && effectiveEnergy(room) > 5000) return 1;
    return 0;
}

const upgrader: SpawnRole = {
    id: "upgrader",
    emptyTimeout: 100,

    options(room) {
        const controller = room.controller;
        if (!controller?.my) return [];
        const max = upgraderAmount(room);
        const count = creepsByRole(room.name, "upgrader").filter(
            c => !c.ticksToLive || c.ticksToLive > c.body.length * CREEP_SPAWN_TIME
        ).length;
        const priority = isCloseToDowngrade(room) ? 5 : 3;
        const options: SpawnOption[] = [];
        // The early upgrader must not lose to builders (priority 4) while construction drags on
        const early = !room.storage && !room.terminal && max > 0;
        if (count < max) options.push({ role: this.id, priority: early ? Math.max(priority, 4) : priority, weight: 1 });
        // Unlock the next level when nobody upgrades
        if (max === 0 && count === 0 && controller.progress > controller.progressTotal) {
            options.push({ role: this.id, priority, weight: 1, mini: true });
        }
        return options;
    },

    body(room, option) {
        const easy = !!controllerContainer(room) || !!controllerLink(room);
        return buildBody({
            weights: { [CARRY]: 1, [WORK]: easy ? 10 : 1 },
            partLimits: { [WORK]: option.mini ? 2 : room.controller?.level === 8 ? 15 : 50 },
            moveMode: easy ? MoveMode.SLOW : MoveMode.ROAD,
            carryContentLevel: 0,
            energyLimit: energyLimit(room, room.energyCapacityAvailable * 0.9)
        });
    },

    memory(room) {
        return { role: this.id, room: room.name };
    }
};

// ------------------------------------------------------------------ helper

/** One helper while the room has a boost lab (Hivemind spawn-role/helper.ts) */
const helper: SpawnRole = {
    id: HELPER,
    emptyTimeout: 10,

    options(room) {
        if (creepsByRole(room.name, HELPER).length >= 1 || boostLabs(room).length === 0) return [];
        return [{ role: HELPER, priority: 5, weight: 1.1 }];
    },

    body(room) {
        return buildBody({
            weights: { [CARRY]: 1 },
            partLimits: { [CARRY]: 12 },
            moveMode: MoveMode.ROAD,
            energyLimit: Math.min(room.energyCapacityAvailable, Math.max(room.energyCapacityAvailable * 0.9, room.energyAvailable))
        });
    },

    memory(room) {
        return { role: HELPER, room: room.name };
    }
};

// ------------------------------------------------------------------ defense

/** Remote defense (Hivemind spawn role "brawler", remote part) */
const remoteDefense: SpawnRole = {
    id: "brawler",
    emptyTimeout: 10,

    options(room) {
        return remoteDefenseOptions(room);
    },

    body(room, option) {
        return remoteDefenderBody(room, option as DefenseOption);
    },

    memory(room, option) {
        return remoteDefenderMemory(room, option as DefenseOption);
    }
};

/** Guardians: melee, one ranged for every 4 guardians */
function guardianIsRanged(room: Room): boolean {
    const guardians = creepsByRole(room.name, GUARDIAN);
    const ranged = guardians.filter(c => c.getActiveBodyparts(RANGED_ATTACK) > 0).length;
    return ranged < Math.floor(guardians.length / 4);
}

/**
 * Owned room defense (Hivemind spawn role "room-defense"): a brawler below RCL 4, also during a safe
 * mode (Hivemind waits for its last 500 ticks, but the first room's 20000-tick safe mode let an early
 * invader live its whole life: our attacks still work in safe mode); from RCL 4, while
 * enemies are at least NORMAL, up to 5 guardians, and up to 5 builders to keep the ramparts up when
 * 10000 energy is available.
 */
const roomDefense: SpawnRole = {
    id: "roomDefense",
    emptyTimeout: 10,

    options(room) {
        const options: SpawnOption[] = [];
        const controller = room.controller!;
        if (
            controller.level < 4 &&
            hasEnemies(room) &&
            creepsByRole(room.name, "brawler").length < 2
        ) {
            options.push({ role: "brawler", priority: 5, weight: 1 });
        }
        if (controller.level < 4) return options;
        // Weak enemies get no guardian: towers handle them (Hivemind: no defense response below NORMAL,
        // which also cancels the "safe mode ends within 300 ticks" trigger)
        if (enemyStrength(room) < ENEMY_STRENGTH_NORMAL) return options;
        if (creepsByRole(room.name, GUARDIAN).length < 5) {
            options.push({ role: GUARDIAN, priority: 5, weight: 1 });
        }
        if (hasEnemies(room) && effectiveEnergy(room) >= 10000 && creepsByRole(room.name, "builder").length < 5) {
            options.push({ role: "builder", priority: 4, weight: 1 });
        }
        return options;
    },

    body(room, option) {
        const energy = energyLimit(room, room.energyCapacityAvailable * 0.9);
        if (option.role === "builder") {
            return buildBody({ weights: { [WORK]: 1, [CARRY]: 1 }, moveMode: MoveMode.ROAD, energyLimit: energy });
        }
        const ranged = option.role === GUARDIAN && guardianIsRanged(room);
        return buildBody({
            weights: ranged ? { [RANGED_ATTACK]: 1 } : { [ATTACK]: 1 },
            moveMode: MoveMode.ROAD,
            moveBufferRatio: 0.8,
            energyLimit: energy
        });
    },

    memory(room, option) {
        return { role: option.role, room: room.name };
    },

    /**
     * Hivemind room-defense getCreepBoosts: emergency builders WORK (repair), guardians ATTACK or
     * RANGED_ATTACK, no stronger tier than the enemies' boosts (none: any tier)
     */
    boosts(room, option, body) {
        const maxTier = maxEnemyBoostTier(room);
        if (option.role === "builder") return boostsFor(room, body, [[WORK, "repair"]], maxTier);
        if (option.role !== GUARDIAN) return {};
        return body.includes(ATTACK)
            ? boostsFor(room, body, [[ATTACK, "attack"]], maxTier)
            : boostsFor(room, body, [[RANGED_ATTACK, "rangedAttack"]], maxTier);
    }
};

/** Highest boost tier (compound name length) on the enemies, 0 up to NORMAL (Hivemind getMaxEnemyBoostLevel) */
function maxEnemyBoostTier(room: Room): number {
    if (enemyStrength(room) <= ENEMY_STRENGTH_NORMAL) return 0;
    let highest = 0;
    for (const creep of room.find(FIND_HOSTILE_CREEPS)) {
        for (const part of creep.body) if (typeof part.boost === "string") highest = Math.max(highest, part.boost.length);
    }
    return highest;
}

/** Hivemind registration order (alphabetical): it breaks priority/weight ties */
export const ECONOMY_SPAWN_ROLES: SpawnRole[] = [
    remoteDefense,
    builder,
    harvester,
    helper,
    mineralHarvester,
    militarySpawnRole,
    reclaimSpawnRole,
    remoteSpawnRole,
    roomDefense,
    squadSpawnRole,
    transporter,
    upgrader
];
