/**
 * Military intel: what our squads need to know about hostile rooms (towers, spawns, barriers,
 * invader cores and strongholds, defenders) and how much each player hurt us (infamy, after
 * Harabi's ROI target selection: the energy a player made us lose). Our design.
 */

import { energyPrice } from "../modules/MarketManager";
import { remoteSources } from "../remote/RemoteMining";
import { lootRamparts } from "./loot";
import {
  aggressionFromEvents,
  AGGRESSION_DECAY,
  AGGRESSION_DECAY_EVERY,
  AttackEventItem,
  decayAggression
} from "./playerThreat";
import { lootValue, RAID_MIN_LOOT } from "./roi";

export interface HostileRoom {
  /** Tick of the record */
  t: number;
  owner?: string;
  rcl?: number;
  towers: number;
  spawns: number;
  /** Tick the safe mode ends */
  safeMode?: number;
  /** Weakest hostile rampart or wall hits (0: none), the cost of a breach */
  barrier: number;
  /** Invader core level (0: plain core, 1+: stronghold) */
  coreLevel?: number;
  /** Tick the core is deployed (strongholds deploy their towers then) */
  coreDeploy?: number;
  /** Tick the stronghold collapses */
  collapse?: number;
  /** Damage and healing per tick of the hostile creeps */
  damage: number;
  heal: number;
  /** Loot seen in the room, in energy (roi.ts lootValue at market prices) */
  loot?: number;
  /** Energy in the hostile towers (raids need them empty) */
  towerEnergy?: number;
  /** Hits of the strongest hostile rampart over loot (raids: a dismantler must open it) */
  lootBarrier?: number;
}

declare global {
  interface Memory {
    military?: {
      /** Room to attack, set by hand (overrides the automatic target) */
      attack?: string;
      /** Automatic attacks on player rooms (default on since 2026-10-25; false: strongholds only) */
      auto?: boolean;
      /** Allow raids on rooms with loot and no defense (loot.ts; default off) */
      raid?: boolean;
      /** Force the squad type of new missions ("duo" or "quad"; default: sized from the threat) */
      squad?: "duo" | "quad";
      /**
       * Boosts of new squads (boostNeed.ts): "auto" (default) the cheapest set that holds against
       * the target, "max" the strongest in stock (before 2026-10-25), "none" plain bodies
       */
      boosts?: "auto" | "max" | "none";
      /** Automatic target (strongholds near our rooms, players with `auto`) */
      target?: { room: string; reason: "stronghold" | "player"; since: number; roi?: number };
      duos: { [name: string]: import("./duo").DuoMemory };
      quads?: { [name: string]: import("./quad").QuadMemory };
      /** Lowest RCL of the attacking room (default 4; lower it to test sooner) */
      minRcl?: number;
      /** Highest stronghold level attacked automatically (default 1) */
      maxStrongholdLevel?: number;
      /** Finished missions ("retargeted": the target changed, not a failure) */
      log?: {
        room: string;
        result: "success" | "abandoned" | "retargeted";
        time: number;
        losses: number;
        squad?: string;
      }[];
      /** Hostile rooms seen */
      rooms?: { [room: string]: HostileRoom };
      /** Energy each player made us lose (decays) */
      infamy?: { [player: string]: number };
      /** Damage each player's creeps dealt to ours in our rooms and remotes (decays; playerThreat.ts) */
      aggression?: { [player: string]: number };
      /** Tick of the last aggression decay */
      aggressionDecayed?: number;
      /** Rooms looted after a successful attack (loot.ts) */
      loot?: { [room: string]: import("./loot").LootMission };
    };
  }
}

const RECORD_EVERY = 10;
const FORGET_AFTER = 50000;
const INFAMY_DECAY_EVERY = 1000;
const INFAMY_DECAY = 0.95;
const NPC = ["Invader", "Source Keeper"];

export function militaryMemory(): NonNullable<Memory["military"]> {
  if (!Memory.military) Memory.military = { duos: {} };
  // Set by hand as `Memory.military = { attack: "W8N3" }`: fill the required fields
  if (!Memory.military.duos) Memory.military.duos = {};
  return Memory.military;
}

function combatPower(creeps: Creep[]): { damage: number; heal: number } {
  let damage = 0;
  let heal = 0;
  for (const creep of creeps) {
    for (const part of creep.body) {
      if (part.hits <= 0) continue;
      const boost = part.boost ? 4 : 1;
      if (part.type === ATTACK) damage += ATTACK_POWER * boost;
      else if (part.type === RANGED_ATTACK) damage += RANGED_ATTACK_POWER * boost;
      else if (part.type === HEAL) heal += HEAL_POWER * boost;
    }
  }
  return { damage, heal };
}

/** Loot in sight, in energy: stores that are not ours (containers, ruins, others' storage and terminal) */
/** Our rooms and the rooms we mine (their containers are ours) */
function ourRooms(): Set<string> {
  const ours = new Set<string>();
  for (const name in Game.rooms) {
    if (!Game.rooms[name].controller?.my) continue;
    ours.add(name);
    for (const source of remoteSources(name)) ours.add(source.room);
  }
  return ours;
}

function roomLoot(room: Room, ours: Set<string>): number {
  if (room.controller?.my) return 0;
  // The containers of the rooms we mine are ours
  const mined = ours.has(room.name);
  const store: { [resourceType: string]: number } = {};
  const add = (s: Store<ResourceConstant, boolean>) => {
    for (const r of Object.keys(s) as ResourceConstant[]) store[r] = (store[r] ?? 0) + (s[r] ?? 0);
  };
  for (const ruin of room.find(FIND_RUINS)) add(ruin.store);
  for (const s of room.find(FIND_STRUCTURES)) {
    if (s.structureType === STRUCTURE_CONTAINER && !mined) add(s.store);
    else if ((s.structureType === STRUCTURE_STORAGE || s.structureType === STRUCTURE_TERMINAL) && !s.my) add(s.store);
  }
  return Math.round(lootValue(store, (r) => energyPrice(r as ResourceConstant)));
}

function recordRoom(room: Room, ours: Set<string>): void {
  const memory = militaryMemory();
  const owner = room.controller?.owner?.username;
  const hostileOwner = !!owner && !room.controller?.my;
  const structures = room.find(FIND_HOSTILE_STRUCTURES);
  const core = structures.find((s) => s.structureType === STRUCTURE_INVADER_CORE) as StructureInvaderCore | undefined;
  const loot = roomLoot(room, ours);
  // Kept with enough loot even without owner, core or tower: an abandoned base (raids)
  if (!hostileOwner && !core && !structures.some((s) => s.structureType === STRUCTURE_TOWER) && loot < RAID_MIN_LOOT) {
    if (memory.rooms?.[room.name]) delete memory.rooms[room.name];
    return;
  }
  const barriers = room.find(FIND_STRUCTURES, {
    filter: (s) =>
      s.structureType === STRUCTURE_WALL || (s.structureType === STRUCTURE_RAMPART && !(s as StructureRampart).my)
  });
  const collapse = core?.effects?.find((e) => e.effect === EFFECT_COLLAPSE_TIMER);
  const power = combatPower(room.find(FIND_HOSTILE_CREEPS, { filter: (c) => c.owner.username !== "Source Keeper" }));
  const towers = structures.filter((s): s is StructureTower => s.structureType === STRUCTURE_TOWER);
  const lootBarrier = _.max([0, ...lootRamparts(room).map((r) => r.hits)]);
  memory.rooms = memory.rooms ?? {};
  memory.rooms[room.name] = {
    t: Game.time,
    ...(hostileOwner && { owner, rcl: room.controller!.level }),
    towers: towers.length,
    spawns: structures.filter((s) => s.structureType === STRUCTURE_SPAWN).length,
    ...(room.controller?.safeMode && { safeMode: Game.time + room.controller.safeMode }),
    barrier: barriers.length ? _.min(barriers.map((s) => s.hits)) : 0,
    ...(core && { coreLevel: core.level, coreDeploy: Game.time + (core.ticksToDeploy ?? 0) }),
    ...(collapse && { collapse: Game.time + collapse.ticksRemaining }),
    damage: power.damage,
    heal: power.heal,
    ...(loot > 0 && { loot }),
    ...(towers.length > 0 && { towerEnergy: _.sum(towers, (t) => t.store.energy) }),
    ...(lootBarrier > 0 && { lootBarrier })
  };
}

/** Player creeps seen in our rooms and remotes (heap: each creep counted once) */
const seenCreeps: Set<string> = new Set();

function bodyCost(creep: Creep): number {
  return _.sum(creep.body, (p) => BODYPART_COST[p.type]);
}

/** Infamy: energy value of the player creeps that came into our rooms or remotes */
function recordInfamy(ours: Set<string>): void {
  const memory = militaryMemory();
  for (const roomName of ours) {
    const room = Game.rooms[roomName];
    if (!room) continue;
    for (const creep of room.find(FIND_HOSTILE_CREEPS)) {
      if (NPC.includes(creep.owner.username) || seenCreeps.has(creep.id)) continue;
      seenCreeps.add(creep.id);
      const fighter = creep.body.some((p) => p.type === ATTACK || p.type === RANGED_ATTACK || p.type === WORK);
      memory.infamy = memory.infamy ?? {};
      memory.infamy[creep.owner.username] =
        (memory.infamy[creep.owner.username] ?? 0) + (fighter ? bodyCost(creep) : 100);
    }
  }
  if (Game.time % INFAMY_DECAY_EVERY === 0) {
    seenCreeps.clear();
    for (const player in memory.infamy ?? {}) {
      memory.infamy![player] *= INFAMY_DECAY;
      if (memory.infamy![player] < 10) delete memory.infamy![player];
    }
  }
}

/** Player creeps able to hurt us (ATTACK, RANGED_ATTACK, WORK to dismantle) seen in a room on a tick */
interface ArmedSnapshot {
  tick: number;
  /** Armed hostile creep id -> owner (the attacker may be dead when its event is read) */
  hostiles: Map<string, string>;
  /** Our creeps in the room (a target killed by the attack is gone too) */
  ours: Set<string>;
}

/** Rooms of ours with armed player creeps last tick (heap) */
const armedRooms: { [room: string]: ArmedSnapshot } = {};

function isArmed(creep: Creep): boolean {
  return creep.body.some((p) => p.hits > 0 && (p.type === ATTACK || p.type === RANGED_ATTACK || p.type === WORK));
}

/** A target of ours: our creep (alive or seen last tick), our structure, or an unowned one (road, container) in our room or remote */
function isOursIn(snapshot: ArmedSnapshot): (id: string) => boolean {
  return (id) => {
    if (snapshot.ours.has(id)) return true;
    const object = Game.getObjectById(id as Id<Creep | Structure>);
    if (!object) return false;
    if (object instanceof Creep) return object.my;
    const owned = object as OwnedStructure;
    return owned.owner ? owned.my : true;
  };
}

/**
 * Aggression: damage dealt to us by player creeps in our rooms and remotes, from the event log of the
 * rooms where armed player creeps stood last tick (only there: getEventLog parses the room's log)
 */
function recordAggression(ours: Set<string>): void {
  const memory = militaryMemory();
  for (const roomName of ours) {
    const room = Game.rooms[roomName];
    const previous = armedRooms[roomName];
    delete armedRooms[roomName];
    if (!room) continue;
    if (previous?.tick === Game.time - 1) {
      const damage = aggressionFromEvents(
        room.getEventLog() as unknown as AttackEventItem[],
        (id) => previous.hostiles.get(id),
        isOursIn(previous)
      );
      for (const player in damage) {
        memory.aggression = memory.aggression ?? {};
        memory.aggression[player] = (memory.aggression[player] ?? 0) + damage[player];
      }
    }
    const armed = room.find(FIND_HOSTILE_CREEPS, { filter: (c) => !NPC.includes(c.owner.username) && isArmed(c) });
    if (armed.length === 0) continue;
    armedRooms[roomName] = {
      tick: Game.time,
      hostiles: new Map(armed.map((c) => [c.id as string, c.owner.username])),
      ours: new Set(room.find(FIND_MY_CREEPS).map((c) => c.id as string))
    };
  }
  // Elapsed ticks, not Game.time %: a skipped tick would miss the decay
  const decayed = memory.aggressionDecayed ?? Game.time;
  const periods = Math.floor((Game.time - decayed) / AGGRESSION_DECAY_EVERY);
  if (periods > 0 && memory.aggression) decayAggression(memory.aggression, Math.pow(AGGRESSION_DECAY, periods));
  if (periods > 0 || memory.aggressionDecayed === undefined)
    memory.aggressionDecayed = decayed + periods * AGGRESSION_DECAY_EVERY;
  if (memory.aggression && Object.keys(memory.aggression).length === 0) delete memory.aggression;
}

/** Every RECORD_EVERY ticks: hostile rooms in sight; every tick: infamy and aggression */
export function updateMilitaryIntel(): void {
  const ours = ourRooms();
  recordInfamy(ours);
  recordAggression(ours);
  if (Game.time % RECORD_EVERY !== 0) return;
  for (const name in Game.rooms) recordRoom(Game.rooms[name], ours);
  const rooms = militaryMemory().rooms ?? {};
  for (const name in rooms) if (Game.time - rooms[name].t > FORGET_AFTER) delete rooms[name];
}

export function hostileRoom(roomName: string): HostileRoom | undefined {
  return militaryMemory().rooms?.[roomName];
}
