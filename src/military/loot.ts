/**
 * Looting after a successful attack: the stores a squad leaves behind (stronghold containers and the
 * core's ruin, ruins of a player's storage or terminal, tombstones, piles) are hauled home by looters.
 *
 * - A mission that succeeded (military.ts finish) starts a loot mission for its room from the squad's
 *   spawn room, while that room has a storage: `Memory.military.loot[room] = { home, since, until, ... }`.
 * - Stores under a hostile rampart can't be withdrawn from (the engine refuses it): those ramparts are
 *   squad targets (duo.ts pickTarget) and the attack is not over while they stand (isNeutralized), so
 *   the stronghold's container (bunker1: a rampart on the core and on the container) gets opened.
 * - Looters: CARRY / MOVE (plains), priority 3, weight 0 like the dismantler; as many as the loot needs
 *   for the round trips over a creep's life (Overmind DirectiveHaul: amount x 2 x distance / (1500 x
 *   capacity)), at most MAX_LOOTERS. They take every resource and deliver through the destination
 *   dispatcher (storage / terminal), then recycle once nothing is left.
 * - The mission ends when the room is seen empty, after MISSION_TICKS, or when the home lost its storage.
 * Not in Hivemind (its 3.0.0 `gatherer` scavenged abandoned rooms, removed since), Overmind dev
 * DirectiveStronghold "looting" (placed by hand), TooAngel and The International have none. Our design.
 */

import { buildBody, MoveMode } from "../core/bodyBuilder";
import { whenInRange } from "../core/movement";
import { clearOrder, creepsByRole, effectiveEnergy } from "../core/roomState";
import { ENEMY_STRENGTH_NORMAL, enemyStrength } from "../defense/RoomDefense";
import { isRoomUnderAttack } from "../modules/RoomIntel";
import { trafficManager } from "../modules/TrafficManager";
import { fleeIfThreatened } from "../roles/flee";
import { performRecycle } from "../roles/recycle";
import { registerRole } from "../roles/registry";
import { performDeliver } from "../roles/transporter";
import type { SpawnOption, SpawnRole } from "../spawning/spawnRoles";
import { log } from "../utils/logger";
import { countStat } from "../utils/stats";
import { militaryMemory } from "./intel";

export const LOOTER = "looter";

/** Smallest amount worth a withdraw (The International logisticsProcs: 50) */
const MIN_LOOT = 50;
const MAX_LOOTERS = 3;
/** A loot mission is given up after this long (stronghold ruins last until the collapse) */
const MISSION_TICKS = 20000;
/** Looters wait for this much energy at home */
const MIN_ENERGY = 5000;
/** Tiles per room on the way (route length x 50) */
const TILES_PER_ROOM = 50;

export interface LootMission {
    home: string;
    since: number;
    until: number;
    /** Route length in rooms from home */
    rooms: number;
    /** Loot left the last time the room was seen */
    amount: number;
    /** Units brought home so far */
    looted: number;
}

declare global {
    interface CreepMemory {
        /** Looter: the room it loots */
        loot?: string;
    }
}

type LootStore = Ruin | Tombstone | StructureContainer | StructureStorage | StructureTerminal;

function lootMissions(): { [room: string]: LootMission } {
    const memory = militaryMemory();
    memory.loot = memory.loot ?? {};
    return memory.loot;
}

/** A hostile, non-public rampart on the tile (withdraw is refused there) */
function hostileRampartAt(pos: RoomPosition): StructureRampart | undefined {
    return pos
        .lookFor(LOOK_STRUCTURES)
        .find((s): s is StructureRampart => s.structureType === STRUCTURE_RAMPART && !(s as StructureRampart).my && !(s as StructureRampart).isPublic);
}

/** Stores of the room that are not ours and hold loot, open or under a hostile rampart */
function lootStores(room: Room): LootStore[] {
    const stores: LootStore[] = [...room.find(FIND_RUINS), ...room.find(FIND_TOMBSTONES)];
    for (const s of room.find(FIND_STRUCTURES)) {
        if (s.structureType === STRUCTURE_CONTAINER) stores.push(s);
        else if ((s.structureType === STRUCTURE_STORAGE || s.structureType === STRUCTURE_TERMINAL) && !s.my) stores.push(s);
    }
    return stores.filter(s => s.store.getUsedCapacity() >= MIN_LOOT);
}

/** Hostile ramparts over loot: the squad breaks them before the mission ends */
export function lootRamparts(room: Room): StructureRampart[] {
    if (room.controller?.my) return [];
    const ramparts: StructureRampart[] = [];
    for (const store of lootStores(room)) {
        const rampart = hostileRampartAt(store.pos);
        if (rampart && !ramparts.includes(rampart)) ramparts.push(rampart);
    }
    return ramparts;
}

/** Loot a looter can take now: open stores and piles */
function openLoot(room: Room): (LootStore | Resource)[] {
    const open: (LootStore | Resource)[] = lootStores(room).filter(s => !hostileRampartAt(s.pos));
    return open.concat(room.find(FIND_DROPPED_RESOURCES).filter(r => r.amount >= MIN_LOOT));
}

function lootAmount(room: Room): number {
    return _.sum(openLoot(room), l => ("store" in l ? l.store.getUsedCapacity() : l.amount));
}

/** After a successful attack: loot the room from the squad's spawn room (needs its storage) */
export function startLooting(roomName: string, home: string): void {
    const homeRoom = Game.rooms[home];
    if (!homeRoom?.storage?.my) return;
    const route = Game.map.findRoute(home, roomName);
    if (route === ERR_NO_PATH) return;
    const room = Game.rooms[roomName];
    const amount = room ? lootAmount(room) : 0;
    if (room && amount === 0) return;
    lootMissions()[roomName] = { home, since: Game.time, until: Game.time + MISSION_TICKS, rooms: route.length, amount, looted: 0 };
    log.info("Military", `Looting ${roomName} from ${home}: ${amount} units in sight`);
}

/** Every tick: refresh the loot left in sight, end the missions that are done */
export function updateLootMissions(): void {
    const missions = lootMissions();
    for (const [roomName, mission] of Object.entries(missions)) {
        const room = Game.rooms[roomName];
        if (room) mission.amount = lootAmount(room);
        const reason =
            Game.time > mission.until
                ? "timeout"
                : !Game.rooms[mission.home]?.storage?.my
                  ? "home lost its storage"
                  : room && mission.amount === 0
                    ? "empty"
                    : null;
        if (!reason) continue;
        delete missions[roomName];
        countStat("loot:missions");
        log.info("Military", `Looting ${roomName} over (${reason}): ${mission.looted} units brought home in ${Game.time - mission.since} ticks`);
    }
}

function travelTicks(mission: LootMission): number {
    return Math.max(1, mission.rooms) * TILES_PER_ROOM;
}

/** Looters a mission needs: round trips of the loot over a creep's life, at least one while loot is left */
function lootersNeeded(mission: LootMission, capacity: number): number {
    if (mission.amount <= 0 || capacity <= 0) return 0;
    const trips = (mission.amount * 2 * travelTicks(mission)) / (CREEP_LIFE_TIME * capacity);
    return Math.min(MAX_LOOTERS, Math.max(1, Math.ceil(trips)));
}

function looterBody(home: Room): BodyPartConstant[] {
    return buildBody({
        weights: { [CARRY]: 1 },
        moveMode: MoveMode.PLAINS,
        energyLimit: Math.min(home.energyCapacityAvailable, Math.max(home.energyCapacityAvailable * 0.9, home.energyAvailable))
    });
}

export const looterSpawnRole: SpawnRole = {
    id: LOOTER,
    emptyTimeout: 50,

    options(home: Room): SpawnOption[] {
        if (!home.storage?.my || effectiveEnergy(home) < MIN_ENERGY) return [];
        if (enemyStrength(home) >= ENEMY_STRENGTH_NORMAL) return [];
        const looters = creepsByRole(home.name, LOOTER);
        const capacity = looterBody(home).filter(p => p === CARRY).length * CARRY_CAPACITY;
        for (const [roomName, mission] of Object.entries(lootMissions())) {
            if (mission.home !== home.name || isRoomUnderAttack(roomName)) continue;
            const have = looters.filter(c => c.memory.loot === roomName).length;
            if (have < lootersNeeded(mission, capacity))
                return [{ role: LOOTER, priority: 3, weight: 0, memory: { loot: roomName }, reason: `loot ${roomName} ${mission.amount}` } as SpawnOption];
        }
        return [];
    },

    body(home: Room): BodyPartConstant[] {
        return looterBody(home);
    },

    memory(home: Room, option: SpawnOption): Partial<CreepMemory> {
        return { role: LOOTER, room: home.name, loot: option.memory?.loot };
    }
};

function runLooter(creep: Creep): void {
    const home = creep.memory.room ?? creep.room.name;
    const mission = creep.memory.loot ? lootMissions()[creep.memory.loot] : undefined;
    const used = creep.store.getUsedCapacity();
    const ttl = creep.ticksToLive ?? CREEP_LIFE_TIME;
    const travel = mission ? travelTicks(mission) : 0;

    if (creep.memory.delivering && used === 0) {
        creep.memory.delivering = false;
        clearOrder(creep);
    }
    const leave = used >= creep.store.getCapacity() * 0.9 || !mission || mission.amount === 0 || ttl < travel * 1.1;
    if (!creep.memory.delivering && used > 0 && leave) {
        creep.memory.delivering = true;
        clearOrder(creep);
    }

    if (creep.memory.delivering) {
        if (fleeIfThreatened(creep)) return;
        if (creep.room.name !== home) {
            trafficManager.moveToRoom(creep, home);
            return;
        }
        performDeliver(creep);
        // performDeliver clears `delivering` when the creep has nothing left to deliver to
        creep.memory.delivering = true;
        return;
    }

    // Nothing left to fetch, or no time for another round trip
    if (!mission || mission.amount === 0 || ttl < travel * 2.2) {
        performRecycle(creep);
        return;
    }
    if (fleeIfThreatened(creep, new RoomPosition(25, 25, home))) return;
    const roomName = creep.memory.loot!;
    if (creep.room.name !== roomName) {
        trafficManager.moveToRoom(creep, roomName);
        return;
    }
    const target = creep.pos.findClosestByRange(openLoot(creep.room));
    if (!target) {
        mission.amount = 0;
        return;
    }
    whenInRange(creep, 1, target, () => {
        let resourceType: ResourceConstant;
        let result: ScreepsReturnCode;
        let amount: number;
        if ("store" in target) {
            resourceType = _.max(Object.keys(target.store) as ResourceConstant[], r => target.store[r]);
            amount = Math.min(target.store[resourceType], creep.store.getFreeCapacity());
            result = creep.withdraw(target, resourceType);
        } else {
            resourceType = target.resourceType;
            amount = Math.min(target.amount, creep.store.getFreeCapacity());
            result = creep.pickup(target);
        }
        if (result !== OK) return;
        mission.looted += amount;
        countStat(`loot:${resourceType}`, amount);
    });
}

registerRole(LOOTER, runLooter);
