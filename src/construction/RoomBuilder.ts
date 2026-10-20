/**
 * RoomBuilder - places construction sites from the room plan, in Hivemind's order, at most 5 at a time.
 * Ported from Hivemind (MIT), src/room/room-manager.ts manageStructures.
 * See docs/hivemind/hivemind-construction.md §1.
 *
 * RCL 1: spawns. RCL 2+: extensions bay by bay, source and controller containers, roads on swamps
 * towards sources and controller. RCL 3: extensions around sources, towers, ramparts. RCL 4: storage, then every
 * planned road once the storage is built, and the roads of the remote mining paths in the room. RCL 5+: links.
 * RCL 6+: terminal, extractor and mineral container; once the ramparts hold, labs, nuker, power spawn,
 * observer and factory (Hivemind buildEndgameStructures, see docs/hivemind/hivemind-endgame.md).
 */

import { RoomPlan } from "../planner/RoomPlan";
import { roomPlanner } from "../planner/RoomPlanner";
import { operationRoadPositions } from "../remote/RemoteMining";
import { lowestWallStrength, MAX_WALL_HEALTH } from "../defense/RoomDefense";

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
    readonly siteCount: number;
    readonly rcl: number;
    readonly terrain: RoomTerrain;

    constructor(readonly room: Room, readonly plan: RoomPlan) {
        this.siteCount = room.find(FIND_MY_CONSTRUCTION_SITES).length;
        this.rcl = room.controller?.level ?? 0;
        this.terrain = room.getTerrain();
    }

    canCreate(): boolean {
        return this.newSites + this.siteCount < MAX_ROOM_SITES;
    }

    /** True to keep going (built, already there, or failed for a reason that shouldn't stop the loop) */
    tryBuild(pos: RoomPosition, type: BuildableStructureConstant): boolean {
        if (pos.lookFor(LOOK_STRUCTURES).some(s => s.structureType === type)) return true;
        if (pos.lookFor(LOOK_CONSTRUCTION_SITES).some(s => s.structureType === type)) return true;
        if (!this.canCreate() || _.size(Game.constructionSites) >= MAX_GLOBAL_SITES) return false;
        const isObstacle = (OBSTACLE_OBJECT_TYPES as string[]).includes(type);
        if (isObstacle && pos.lookFor(LOOK_CREEPS).length > 0) return true;
        if (pos.createConstructionSite(type) === OK) this.newSites++;
        return true;
    }

    buildPlanned(locationType: string, type: BuildableStructureConstant, filter?: (pos: RoomPosition) => boolean): boolean {
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
    const sites = ctx.room.find(FIND_MY_CONSTRUCTION_SITES, { filter: s => s.structureType === STRUCTURE_SPAWN }).length;
    if (spawns + sites >= max) return;
    const isSpawn = (pos: RoomPosition) => ctx.plan.has(pos, "spawn");
    for (let i = 0; i < max; i++) ctx.buildPlanned(`spawn.${i}`, STRUCTURE_SPAWN, isSpawn);
    ctx.buildPlanned("spawn", STRUCTURE_SPAWN);
}

/** Ramparts wait for the storage (The International placeRamparts `needsStoringStructure`) */
const RAMPARTS_NEED_STORAGE = false;

/** RCL 3+, unless a long safe mode runs: main ramparts first, then the on-ramps (Hivemind manageRamparts) */
function manageRamparts(ctx: RoomContext): void {
    const controller = ctx.room.controller!;
    if (ctx.rcl < 3 || ((controller.safeMode ?? 0) >= 2000 && !controller.safeModeCooldown)) return;
    if (RAMPARTS_NEED_STORAGE && !ctx.room.storage) return;
    ctx.buildPlanned("rampart", STRUCTURE_RAMPART, pos => !ctx.plan.has(pos, "rampart.ramp"));
    ctx.buildPlanned("rampart", STRUCTURE_RAMPART);
}

/**
 * Every planned main rampart holds MIN_WALL_INTEGRITY scaled to the RCL (Hivemind checkWallIntegrity). Always
 * below the threat-free rampart target (`wallTarget`: 100k at RCL 5, 276k at 6, 566k at 7, 988k at 8).
 */
function checkWallIntegrity(ctx: RoomContext): boolean {
    if (ctx.plan.count("rampart") === 0) return true;
    return lowestWallStrength(ctx.room) >= (MIN_WALL_INTEGRITY * MAX_WALL_HEALTH[ctx.rcl]) / MAX_WALL_HEALTH[8];
}

/** Planned structures of a type the RCL allows */
function buildAllowed(ctx: RoomContext, locationType: string, type: BuildableStructureConstant): boolean {
    if (CONTROLLER_STRUCTURES[type][ctx.rcl] === 0) return true;
    return ctx.buildPlanned(locationType, type);
}

/** Labs (reaction labs first while only 3 are allowed), nuker, power spawn, observer, factory */
function buildEndgameStructures(ctx: RoomContext): void {
    if (CONTROLLER_STRUCTURES[STRUCTURE_LAB][ctx.rcl] === 3) {
        buildAllowed(ctx, "lab.reaction", STRUCTURE_LAB);
    } else {
        buildAllowed(ctx, "lab.boost", STRUCTURE_LAB);
        buildAllowed(ctx, "lab", STRUCTURE_LAB);
    }
    if (!ctx.canCreate()) return;
    buildAllowed(ctx, "nuker", STRUCTURE_NUKER);
    if (!ctx.canCreate()) return;
    buildAllowed(ctx, "powerSpawn", STRUCTURE_POWER_SPAWN);
    if (!ctx.canCreate()) return;
    buildAllowed(ctx, "observer", STRUCTURE_OBSERVER);
    if (!ctx.canCreate()) return;
    buildAllowed(ctx, "factory", STRUCTURE_FACTORY);
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
    const farthest = _.sortBy(ctx.plan.getLocations("link.source"), pos => -pos.getRangeTo(controller));
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
        ctx.buildPlanned("road.source", STRUCTURE_ROAD, pos => ctx.isSwamp(pos));
        ctx.buildPlanned("road.controller", STRUCTURE_ROAD, pos => ctx.isSwamp(pos));
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
    if (!ctx.canCreate() || !checkWallIntegrity(ctx)) return;
    buildEndgameStructures(ctx);
}

/** Hostile players (not NPC invaders) in the room without safe mode: build nothing */
function underAttack(room: Room): boolean {
    if (room.controller?.safeMode) return false;
    return room.find(FIND_HOSTILE_CREEPS).some(c => c.owner.username !== "Invader" && c.body.some(p => p.type !== MOVE));
}

export const roomBuilderModule = () => {
    for (const name in Game.rooms) {
        const room = Game.rooms[name];
        if (!room.controller?.my) continue;
        const plan = roomPlanner.getPlan(room.name);
        if (!plan || underAttack(room)) continue;
        // A room without spawn waits for the best variation: its first construction site fixes the plan
        if (!roomPlanner.isFinal(room.name) && room.find(FIND_MY_SPAWNS).length === 0) continue;
        manageStructures(new RoomContext(room, plan));
    }
};
