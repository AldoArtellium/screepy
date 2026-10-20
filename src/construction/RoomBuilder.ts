/**
 * RoomBuilder - places construction sites from the room plan, in Hivemind's order, at most 5 at a time.
 * Ported from Hivemind (MIT), src/room/room-manager.ts manageStructures.
 * See docs/hivemind/hivemind-construction.md §1.
 *
 * RCL 1: spawns. RCL 2+: extensions bay by bay, source and controller containers, roads on swamps
 * towards sources and controller. RCL 3: extensions around sources, towers, ramparts. RCL 4: storage, then every
 * planned road once the storage is built, and the roads of the remote mining paths in the room. RCL 5+: links.
 * RCL 6+: terminal, extractor and mineral container; once the ramparts hold, labs, then nuker, power spawn,
 * observer and factory when enabled (Hivemind buildEndgameStructures and its construct* settings, see
 * docs/hivemind/hivemind-endgame.md and ./settings.ts).
 *
 * A room with nothing left to build is idle (Hivemind room-manager builtAllStructures) until its RCL, plan,
 * structures, remote roads, safe mode, wall integrity or settings change, or for ~1500 ticks (decay check).
 */

import { RoomPlan } from "../planner/RoomPlan";
import { roomPlanner } from "../planner/RoomPlanner";
import { operationRoadPositions } from "../remote/RemoteMining";
import { lowestWallStrength, MAX_WALL_HEALTH } from "../defense/RoomDefense";
import { countStat } from "../utils/stats";
import { jitter } from "../utils/jitter";
import { constructionEnabled, constructionSettingsKey } from "./settings";
import { cleanStaleSites } from "./siteCleanup";

/** Construction sites per room, existing ones included */
const MAX_ROOM_SITES = 5;
/** Leave room under the global limit (100) */
const MAX_GLOBAL_SITES = MAX_CONSTRUCTION_SITES * 0.9;
/** Main ramparts must hold this share of MAX_WALL_HEALTH[8], scaled to the RCL, before endgame structures
 * (Hivemind checkWallIntegrity with minWallIntegrity 500k: 12.5k hits at RCL 5, 50k at RCL 6, 75k at RCL 7) */
const MIN_WALL_INTEGRITY = 500000;

/** Below this capacity extensions come before everything else (MAX_CREEP_SIZE * (WORK + MOVE) / 2) */
const EXTENSIONS_FIRST_CAPACITY = (MAX_CREEP_SIZE * (BODYPART_COST[WORK] + BODYPART_COST[MOVE])) / 2;

class RoomContext {
  newSites = 0;
  /** Something buildable was left out for a passing reason (creep in the way, global site cap) */
  deferred = false;
  /** The endgame structures wait for the ramparts (checkWallIntegrity failed) */
  wallsClosed = false;
  readonly siteCount: number;
  readonly rcl: number;
  readonly terrain: RoomTerrain;

  constructor(
    readonly room: Room,
    readonly plan: RoomPlan
  ) {
    this.siteCount = room.find(FIND_MY_CONSTRUCTION_SITES).length;
    this.rcl = room.controller?.level ?? 0;
    this.terrain = room.getTerrain();
  }

  canCreate(): boolean {
    return this.newSites + this.siteCount < MAX_ROOM_SITES;
  }

  /** True to keep going (built, already there, or failed for a reason that shouldn't stop the loop) */
  tryBuild(pos: RoomPosition, type: BuildableStructureConstant): boolean {
    if (pos.lookFor(LOOK_STRUCTURES).some((s) => s.structureType === type)) return true;
    if (pos.lookFor(LOOK_CONSTRUCTION_SITES).some((s) => s.structureType === type)) return true;
    if (!this.canCreate()) return false;
    if (_.size(Game.constructionSites) >= MAX_GLOBAL_SITES) {
      this.deferred = true;
      return false;
    }
    const isObstacle = (OBSTACLE_OBJECT_TYPES as string[]).includes(type);
    if (isObstacle && pos.lookFor(LOOK_CREEPS).length > 0) {
      this.deferred = true;
      return true;
    }
    if (pos.createConstructionSite(type) === OK) this.newSites++;
    return true;
  }

  buildPlanned(
    locationType: string,
    type: BuildableStructureConstant,
    filter?: (pos: RoomPosition) => boolean
  ): boolean {
    for (const pos of this.plan.getLocations(locationType)) {
      if (filter && !filter(pos)) continue;
      if (!this.tryBuild(pos, type)) return false;
    }
    return true;
  }

  isSwamp(pos: RoomPosition): boolean {
    return this.terrain.get(pos.x, pos.y) === TERRAIN_MASK_SWAMP;
  }
}

function manageExtensions(ctx: RoomContext): void {
  if (!ctx.canCreate()) return;
  const isExtension = (pos: RoomPosition) => ctx.plan.has(pos, "extension");
  // At RCL 3 harvesters are big enough to drain their source with extensions around
  if (ctx.rcl >= 3) ctx.buildPlanned("extension.harvester", STRUCTURE_EXTENSION, isExtension);
  for (let i = 0; i < 10; i++) ctx.buildPlanned(`extension.bay.${i}`, STRUCTURE_EXTENSION, isExtension);
  ctx.buildPlanned("extension.bay", STRUCTURE_EXTENSION, isExtension);
  ctx.buildPlanned("extension", STRUCTURE_EXTENSION);
}

function manageTowers(ctx: RoomContext): void {
  const isTower = (pos: RoomPosition) => ctx.plan.has(pos, "tower");
  for (let i = 0; i < CONTROLLER_STRUCTURES[STRUCTURE_TOWER][ctx.rcl]; i++) {
    ctx.buildPlanned(`tower.${i}`, STRUCTURE_TOWER, isTower);
  }
  ctx.buildPlanned("tower", STRUCTURE_TOWER);
}

/** Missing spawns only: the first spawn is never moved, even when off plan (like Hivemind at RCL 1-4) */
function manageSpawns(ctx: RoomContext): void {
  const max = CONTROLLER_STRUCTURES[STRUCTURE_SPAWN][ctx.rcl];
  const spawns = ctx.room.find(FIND_MY_SPAWNS).length;
  const sites = ctx.room.find(FIND_MY_CONSTRUCTION_SITES, {
    filter: (s) => s.structureType === STRUCTURE_SPAWN
  }).length;
  if (spawns + sites >= max) return;
  const isSpawn = (pos: RoomPosition) => ctx.plan.has(pos, "spawn");
  for (let i = 0; i < max; i++) ctx.buildPlanned(`spawn.${i}`, STRUCTURE_SPAWN, isSpawn);
  ctx.buildPlanned("spawn", STRUCTURE_SPAWN);
}

/** RCL 3+, unless a long safe mode runs: main ramparts first, then the on-ramps (Hivemind manageRamparts) */
function manageRamparts(ctx: RoomContext): void {
  const controller = ctx.room.controller!;
  if (ctx.rcl < 3 || ((controller.safeMode ?? 0) >= 2000 && !controller.safeModeCooldown)) return;
  ctx.buildPlanned("rampart", STRUCTURE_RAMPART, (pos) => !ctx.plan.has(pos, "rampart.ramp"));
  ctx.buildPlanned("rampart", STRUCTURE_RAMPART);
}

/** Every planned main rampart holds MIN_WALL_INTEGRITY scaled to the RCL (Hivemind checkWallIntegrity) */
function checkWallIntegrity(ctx: RoomContext): boolean {
  return wallsHold(ctx.room, ctx.plan);
}

function wallsHold(room: Room, plan: RoomPlan): boolean {
  if (plan.count("rampart") === 0) return true;
  const rcl = room.controller?.level ?? 0;
  return lowestWallStrength(room) >= (MIN_WALL_INTEGRITY * MAX_WALL_HEALTH[rcl]) / MAX_WALL_HEALTH[8];
}

/** Planned structures of a type the RCL allows */
function buildAllowed(ctx: RoomContext, locationType: string, type: BuildableStructureConstant): boolean {
  if (CONTROLLER_STRUCTURES[type][ctx.rcl] === 0) return true;
  return ctx.buildPlanned(locationType, type);
}

/** Labs (reaction labs first while only 3 are allowed), then nuker, power spawn, observer, factory when enabled */
function buildEndgameStructures(ctx: RoomContext): void {
  if (CONTROLLER_STRUCTURES[STRUCTURE_LAB][ctx.rcl] === 3) {
    buildAllowed(ctx, "lab.reaction", STRUCTURE_LAB);
  } else {
    buildAllowed(ctx, "lab.boost", STRUCTURE_LAB);
    buildAllowed(ctx, "lab", STRUCTURE_LAB);
  }
  if (!ctx.canCreate()) return;
  if (constructionEnabled("nuker")) buildAllowed(ctx, "nuker", STRUCTURE_NUKER);
  if (!ctx.canCreate()) return;
  if (constructionEnabled("powerSpawn")) buildAllowed(ctx, "powerSpawn", STRUCTURE_POWER_SPAWN);
  if (!ctx.canCreate()) return;
  if (constructionEnabled("observer")) buildAllowed(ctx, "observer", STRUCTURE_OBSERVER);
  if (!ctx.canCreate()) return;
  if (constructionEnabled("factory")) buildAllowed(ctx, "factory", STRUCTURE_FACTORY);
}

/**
 * Links within the RCL limit (Hivemind manageLinks): controller first, then source links farthest
 * from the controller first, then the storage link (with 2 sources: RCL 5 controller + 1 source,
 * RCL 6 both sources, RCL 7 storage). Unplanned links are not destroyed (Hivemind does).
 */
function manageLinks(ctx: RoomContext): void {
  const limit = CONTROLLER_STRUCTURES[STRUCTURE_LINK][ctx.rcl] ?? 0;
  if (limit === 0) return;
  let count = 0;
  if (!ctx.buildPlanned("link.controller", STRUCTURE_LINK)) return;
  if (++count >= limit) return;
  const controller = ctx.room.controller!.pos;
  const farthest = _.sortBy(ctx.plan.getLocations("link.source"), (pos) => -pos.getRangeTo(controller));
  for (const pos of farthest) {
    if (!ctx.tryBuild(pos, STRUCTURE_LINK)) return;
    if (++count >= limit) return;
  }
  ctx.buildPlanned("link.storage", STRUCTURE_LINK);
  if (++count >= limit) return;
  ctx.buildPlanned("link", STRUCTURE_LINK);
}

function manageStructures(ctx: RoomContext): void {
  const room = ctx.room;
  const onlySpawn = _.size(Game.spawns) === 1 ? _.values<StructureSpawn>(Game.spawns)[0] : null;
  if (onlySpawn?.room.name === room.name && ctx.rcl < 4) manageExtensions(ctx);
  if (!ctx.canCreate()) return;

  manageTowers(ctx);
  manageSpawns(ctx);
  if (!ctx.canCreate()) return;
  if (ctx.rcl < 2) return;

  if (room.energyCapacityAvailable < EXTENSIONS_FIRST_CAPACITY) {
    manageExtensions(ctx);
    if (!ctx.canCreate()) return;
  }

  ctx.buildPlanned("container.source", STRUCTURE_CONTAINER);
  ctx.buildPlanned("container.controller", STRUCTURE_CONTAINER);
  manageRamparts(ctx);
  if (!ctx.canCreate()) return;

  ctx.buildPlanned("storage", STRUCTURE_STORAGE);
  buildAllowed(ctx, "terminal", STRUCTURE_TERMINAL);

  // Swamp roads towards sources and controller while no storage can exist yet, or once it is built
  if (room.storage || CONTROLLER_STRUCTURES[STRUCTURE_STORAGE][ctx.rcl] === 0) {
    ctx.buildPlanned("road.source", STRUCTURE_ROAD, (pos) => ctx.isSwamp(pos));
    ctx.buildPlanned("road.controller", STRUCTURE_ROAD, (pos) => ctx.isSwamp(pos));
  }
  if (!ctx.canCreate()) return;
  manageLinks(ctx);

  if (CONTROLLER_STRUCTURES[STRUCTURE_EXTRACTOR][ctx.rcl] > 0) {
    ctx.buildPlanned("extractor", STRUCTURE_EXTRACTOR);
    ctx.buildPlanned("container.mineral", STRUCTURE_CONTAINER);
  }
  if (ctx.rcl < 4) return;
  if (!ctx.canCreate()) return;

  if (room.storage) {
    ctx.buildPlanned("road", STRUCTURE_ROAD);
    // Roads of the remote mining paths in this room (Hivemind buildOperationRoads)
    for (const pos of operationRoadPositions(room.name)) if (!ctx.tryBuild(pos, STRUCTURE_ROAD)) break;
  }
  manageExtensions(ctx);

  // Further constructions only once the ramparts hold
  if (!ctx.canCreate()) return;
  if (!checkWallIntegrity(ctx)) {
    ctx.wallsClosed = true;
    return;
  }
  buildEndgameStructures(ctx);
}

/** Hostile players (not NPC invaders) in the room without safe mode: build nothing */
function underAttack(room: Room): boolean {
  if (room.controller?.safeMode) return false;
  return room
    .find(FIND_HOSTILE_CREEPS)
    .some((c) => c.owner.username !== "Invader" && c.body.some((p) => p.type !== MOVE));
}

/** Full rescan of a complete room at least this often: decayed roads and containers (Hivemind: CREEP_LIFE_TIME) */
const RECHECK_INTERVAL = CREEP_LIFE_TIME;

interface CompleteRoom {
  /** completionKey() when the room was found complete */
  key: string;
  /** Full rescan due */
  recheckAt: number;
  /** The endgame structures waited for the ramparts: rescan once they hold */
  wallsClosed: boolean;
}

/** A long safe mode pauses the ramparts (same test as manageRamparts) */
function rampartsPaused(room: Room): boolean {
  const controller = room.controller!;
  return (controller.safeMode ?? 0) >= 2000 && !controller.safeModeCooldown;
}

/** Heap: rooms with nothing left to build (a global reset only costs a rescan) */
const completeRooms = new Map<string, CompleteRoom>();

/**
 * What decides what can be built: RCL, plan (version, variation; replans and extensions change it), structures
 * (count and positions: a destroyed or decayed one changes it), the remote paths' roads in the room, a safe mode
 * pausing the ramparts and the settings
 */
function completionKey(room: Room): string {
  const plan = roomPlanner.planMemory(room.name);
  let structureSum = 0;
  const structures = room.find(FIND_STRUCTURES);
  for (const s of structures) structureSum += s.pos.x + 50 * s.pos.y;
  const roads = operationRoadPositions(room.name);
  let roadSum = 0;
  for (const pos of roads) roadSum += pos.x + 50 * pos.y;
  return [
    room.controller?.level ?? 0,
    plan?.v,
    plan?.k,
    plan?.s,
    structures.length,
    structureSum,
    roads.length,
    roadSum,
    rampartsPaused(room) ? 1 : 0,
    constructionSettingsKey()
  ].join("|");
}

/** The room was found complete and nothing changed since */
function isStillComplete(room: Room, plan: RoomPlan): boolean {
  const state = completeRooms.get(room.name);
  if (!state) return false;
  if (
    Game.time < state.recheckAt &&
    state.key === completionKey(room) &&
    !(state.wallsClosed && wallsHold(room, plan))
  ) {
    return true;
  }
  completeRooms.delete(room.name);
  return false;
}

export const roomBuilderModule = () => {
  cleanStaleSites();
  for (const name in Game.rooms) {
    const room = Game.rooms[name];
    if (!room.controller?.my) continue;
    const plan = roomPlanner.getPlan(room.name);
    if (!plan || underAttack(room)) continue;
    // A room without spawn waits for the best variation: its first construction site fixes the plan
    if (!roomPlanner.isFinal(room.name) && room.find(FIND_MY_SPAWNS).length === 0) continue;
    if (isStillComplete(room, plan)) {
      countStat("roomBuilder:idle");
      continue;
    }
    const ctx = new RoomContext(room, plan);
    manageStructures(ctx);
    countStat("roomBuilder:scan");
    if (ctx.siteCount + ctx.newSites === 0 && !ctx.deferred) {
      completeRooms.set(room.name, {
        key: completionKey(room),
        recheckAt: Game.time + jitter(RECHECK_INTERVAL),
        wallsClosed: ctx.wallsClosed
      });
    }
  }
};
