/**
 * Looting: the stores a squad leaves behind (stronghold containers and the core's ruin, ruins of a
 * player's storage or terminal, tombstones, piles), and raids on rooms with loot and no defense.
 *
 * - A mission that succeeded (military.ts finish) starts a loot mission for its room from the squad's
 *   spawn room, while that room has a storage: `Memory.military.loot[room] = { home, since, until, ... }`.
 * - Stores under a hostile rampart can't be withdrawn from (the engine refuses it): those ramparts are
 *   squad targets (duo.ts pickTarget) and the attack is not over while they stand (isNeutralized), so
 *   the stronghold's container (bunker1: a rampart on the core and on the container) gets opened.
 * - Raids (opt-in `Memory.military.raid = true`, every RAID_EVERY ticks): a room the intel saw with at
 *   least RAID_MIN_LOOT of loot, empty towers, no armed creep, no safe mode and ramparts over the loot
 *   a dismantler can open (roi.ts isRaidable) is looted without a squad from the closest home with a
 *   storage within RAID_MAX_ROUTE rooms, one raid per home, when the loot pays for the looters and the
 *   dismantler (raidCost). The ramparts over the loot go to that home's dismantler
 *   (remote/dismantle.ts dismantleTargets). A tower seen with energy or an armed creep ends the raid,
 *   and the room is left alone for RAID_FAILURE_MEMORY ticks.
 * - Looters: CARRY / MOVE (plains), priority 3, weight 0 like the dismantler; as many as the open loot
 *   needs (roi.ts lootersNeeded). They take every resource and deliver through the destination
 *   dispatcher (storage / terminal), then recycle once nothing is left.
 * - A mission ends when the room is seen empty (nothing open, nothing under a rampart), after
 *   MISSION_TICKS, or when the home lost its storage.
 * Not in Hivemind (its 3.0.0 `gatherer` scavenged abandoned rooms, removed since: it could not open
 * walls), Overmind dev DirectiveStronghold "looting" (placed by hand), TooAngel and The International
 * have none. Our design.
 */

import { buildBody, MoveMode } from "../core/bodyBuilder";
import { whenInRange } from "../core/movement";
import { clearOrder, creepsByRole, effectiveEnergy } from "../core/roomState";
import { ENEMY_STRENGTH_NORMAL, enemyStrength } from "../defense/RoomDefense";
import { isRoomUnderAttack } from "../modules/RoomIntel";
import { trafficManager } from "../modules/TrafficManager";
import { MAX_DISMANTLE_HITS } from "../remote/blockers";
import { remoteSources } from "../remote/RemoteMining";
import { fleeIfThreatened } from "../roles/flee";
import { performRecycle } from "../roles/recycle";
import { registerRole } from "../roles/registry";
import { performDeliver } from "../roles/transporter";
import type { SpawnOption, SpawnRole } from "../spawning/spawnRoles";
import { log } from "../utils/logger";
import { countStat } from "../utils/stats";
import { militaryMemory } from "./intel";
import { isRaidable, lootersNeeded, raidCost } from "./roi";

export const LOOTER = "looter";

/** Smallest amount worth a withdraw (The International logisticsProcs: 50) */
const MIN_LOOT = 50;
/** A loot mission is given up after this long (stronghold ruins last until the collapse) */
const MISSION_TICKS = 20000;
/** Looters wait for this much energy at home */
const MIN_ENERGY = 5000;
/** Tiles per room on the way (route length x 50) */
const TILES_PER_ROOM = 50;
const RAID_EVERY = 100;
const RAID_MAX_ROUTE = 5;
/** A raid that met a defense is not tried again before this */
const RAID_FAILURE_MEMORY = 20000;
/** A tower with this much energy can fire */
const ARMED_TOWER = 10;
/** Dismantler body cap (remote/dismantle.ts MAX_WORK: 25 WORK + 25 MOVE) */
const DISMANTLER_MAX_COST = 25 * (BODYPART_COST[WORK] + BODYPART_COST[MOVE]);

export interface LootMission {
    home: string;
    since: number;
    until: number;
    /** Route length in rooms from home */
    rooms: number;
    /** Open loot left the last time the room was seen */
    amount: number;
    /** Loot under hostile ramparts the last time the room was seen */
    covered?: number;
    /** Hostile ramparts over loot ("x,y"), for the home's dismantler */
    ramparts?: string[];
    /** Started as a raid (no squad) */
    raid?: boolean;
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

/** A room we mine (owned, or a remote of one of our rooms) */
function isMinedRoom(roomName: string): boolean {
    for (const name in Game.rooms) {
        if (!Game.rooms[name].controller?.my) continue;
        if (name === roomName || remoteSources(name).some(s => s.room === roomName)) return true;
    }
    return false;
}

/** Stores of the room that are not ours and hold loot, open or under a hostile rampart */
function lootStores(room: Room): LootStore[] {
    const stores: LootStore[] = [...room.find(FIND_RUINS), ...room.find(FIND_TOMBSTONES)];
    const mined = isMinedRoom(room.name);
    for (const s of room.find(FIND_STRUCTURES)) {
        if (s.structureType === STRUCTURE_CONTAINER) {
            // Our source containers where we mine: their energy is ours, not loot (raid on W8N3, a remote:
            // the looters emptied them as the harvesters refilled them, so the mission never ended)
            if (!mined || s.pos.findInRange(FIND_SOURCES, 1).length === 0) stores.push(s);
        } else if ((s.structureType === STRUCTURE_STORAGE || s.structureType === STRUCTURE_TERMINAL) && !s.my) stores.push(s);
    }
    return stores.filter(s => s.store.getUsedCapacity() >= MIN_LOOT);
}

/** Hostile ramparts over loot: the squad or the dismantler breaks them */
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

function coveredAmount(room: Room): number {
    return _.sum(
        lootStores(room).filter(s => hostileRampartAt(s.pos)),
        s => s.store.getUsedCapacity()
    );
}

function hostileTowerEnergy(room: Room): number {
    return _.sum(
        room.find(FIND_HOSTILE_STRUCTURES).filter((s): s is StructureTower => s.structureType === STRUCTURE_TOWER),
        t => t.store.energy
    );
}

/** Loot a room from a home (needs its storage); `raid`: no squad went there */
export function startLooting(roomName: string, home: string, raid = false): void {
    const homeRoom = Game.rooms[home];
    if (!homeRoom?.storage?.my) return;
    const route = Game.map.findRoute(home, roomName);
    if (route === ERR_NO_PATH) return;
    const room = Game.rooms[roomName];
    const amount = room ? lootAmount(room) : 0;
    const covered = room ? coveredAmount(room) : 0;
    if (room && amount + covered === 0) return;
    lootMissions()[roomName] = {
        home,
        since: Game.time,
        until: Game.time + MISSION_TICKS,
        rooms: route.length,
        amount,
        covered,
        ...(raid && { raid }),
        looted: 0
    };
    log.info("Military", `${raid ? "Raid on" : "Looting"} ${roomName} from ${home}: ${amount} units open, ${covered} under ramparts`);
}

function logRaid(roomName: string, result: "success" | "abandoned"): void {
    const memory = militaryMemory();
    memory.log = [...(memory.log ?? []).slice(-9), { room: roomName, result, time: Game.time, losses: 0, squad: "raid" }];
}

/** Every tick: refresh the loot left in sight, end the missions that are done */
export function updateLootMissions(): void {
    const missions = lootMissions();
    for (const [roomName, mission] of Object.entries(missions)) {
        const room = Game.rooms[roomName];
        if (room) {
            mission.amount = lootAmount(room);
            mission.covered = coveredAmount(room);
            mission.ramparts = lootRamparts(room).map(r => `${r.pos.x},${r.pos.y}`);
        }
        const defended = mission.raid && (isRoomUnderAttack(roomName) || (room && hostileTowerEnergy(room) >= ARMED_TOWER));
        const reason =
            Game.time > mission.until
                ? "timeout"
                : !Game.rooms[mission.home]?.storage?.my
                  ? "home lost its storage"
                  : defended
                    ? "defended"
                    : room && mission.amount === 0 && !mission.covered
                      ? "empty"
                      : null;
        if (!reason) continue;
        delete missions[roomName];
        countStat("loot:missions");
        if (mission.raid) {
            countStat(`loot:raid:${reason === "empty" ? "done" : "abandoned"}`);
            logRaid(roomName, reason === "empty" ? "success" : "abandoned");
        }
        log.info("Military", `Looting ${roomName} over (${reason}): ${mission.looted} units brought home in ${Game.time - mission.since} ticks`);
    }
}

/** Ramparts over the loot of a home's missions, for its dismantler (remote/dismantle.ts) */
export function lootDismantlePositions(home: string): RoomPosition[] {
    const positions: RoomPosition[] = [];
    for (const [roomName, mission] of Object.entries(lootMissions())) {
        if (mission.home !== home || isRoomUnderAttack(roomName)) continue;
        for (const tile of mission.ramparts ?? []) {
            const [x, y] = tile.split(",").map(Number);
            positions.push(new RoomPosition(x, y, roomName));
        }
    }
    return positions;
}

function recentlyFailed(roomName: string): boolean {
    return (militaryMemory().log ?? []).some(
        e => e.room === roomName && e.result === "abandoned" && Game.time - e.time < RAID_FAILURE_MEMORY
    );
}

let lastRaidCheck = 0;

/** Opt-in raids: the best raidable room per home without a raid (closest home within RAID_MAX_ROUTE) */
export function startRaids(): void {
    const memory = militaryMemory();
    if (!memory.raid || Game.time - lastRaidCheck < RAID_EVERY) return;
    lastRaidCheck = Game.time;
    const missions = lootMissions();
    const busy = new Set(Object.values(missions).filter(m => m.raid).map(m => m.home));
    const homes = _.filter(
        Game.rooms,
        r => !!r.controller?.my && r.controller.level >= 4 && !!r.storage?.my && r.find(FIND_MY_SPAWNS).length > 0
    );
    for (const [roomName, intel] of Object.entries(memory.rooms ?? {})) {
        if (missions[roomName] || recentlyFailed(roomName)) continue;
        if (!isRaidable(intel, Game.time, MAX_DISMANTLE_HITS)) continue;
        let best: { home: Room; rooms: number } | null = null;
        for (const home of homes) {
            if (busy.has(home.name) || Game.map.getRoomLinearDistance(home.name, roomName) > RAID_MAX_ROUTE) continue;
            const route = Game.map.findRoute(home.name, roomName);
            if (route === ERR_NO_PATH || route.length > RAID_MAX_ROUTE) continue;
            if (!best || route.length < best.rooms) best = { home, rooms: route.length };
        }
        if (!best) continue;
        const body = looterBody(best.home);
        const capacity = body.filter(p => p === CARRY).length * CARRY_CAPACITY;
        const looterCost = _.sum(body, p => BODYPART_COST[p]);
        const dismantlerCost = Math.min(best.home.energyCapacityAvailable, DISMANTLER_MAX_COST);
        const cost = raidCost(intel.loot ?? 0, best.rooms, looterCost, capacity, dismantlerCost, (intel.lootBarrier ?? 0) > 0);
        if ((intel.loot ?? 0) < cost) continue;
        busy.add(best.home.name);
        countStat("loot:raid:started");
        startLooting(roomName, best.home.name, true);
    }
}

function travelTicks(mission: LootMission): number {
    return Math.max(1, mission.rooms) * TILES_PER_ROOM;
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
            if (have < lootersNeeded(mission.amount, mission.rooms, capacity))
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

    // Nothing left to fetch (open or behind a rampart being opened), or no time for another round trip
    if (!mission || (mission.amount === 0 && !mission.covered) || ttl < travel * 2.2) {
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
        // The rest is under a rampart the dismantler is opening: wait out of its way
        mission.amount = 0;
        trafficManager.requestMove(creep, creep.pos, { range: 0 });
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
