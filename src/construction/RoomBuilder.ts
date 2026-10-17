/**
 * RoomBuilder - places construction sites from the room plan, in Hivemind's order, at most 5 at a time.
 * Ported from Hivemind (MIT), src/room/room-manager.ts manageStructures.
 * See docs/hivemind/hivemind-construction.md §1.
 *
 * RCL 1: spawns. RCL 2+: extensions bay by bay, source and controller containers, roads on swamps
 * towards sources and controller. RCL 3: extensions around sources, towers, ramparts. RCL 4: storage, then every
 * planned road once the storage is built, and the roads of the remote mining paths in the room.
 */

import { RoomPlan } from "../planner/RoomPlan";
import { roomPlanner } from "../planner/RoomPlanner";
import { operationRoadPositions } from "../remote/RemoteMining";

/** Construction sites per room, existing ones included */
const MAX_ROOM_SITES = 5;
/** Leave room under the global limit (100) */
const MAX_GLOBAL_SITES = MAX_CONSTRUCTION_SITES * 0.9;
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

/** RCL 3+, unless a long safe mode runs: main ramparts first, then the on-ramps (Hivemind manageRamparts) */
function manageRamparts(ctx: RoomContext): void {
    const controller = ctx.room.controller!;
    if (ctx.rcl < 3 || ((controller.safeMode ?? 0) >= 2000 && !controller.safeModeCooldown)) return;
    ctx.buildPlanned("rampart", STRUCTURE_RAMPART, pos => !ctx.plan.has(pos, "rampart.ramp"));
    ctx.buildPlanned("rampart", STRUCTURE_RAMPART);
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

    // Swamp roads towards sources and controller while no storage can exist yet, or once it is built
    if (room.storage || CONTROLLER_STRUCTURES[STRUCTURE_STORAGE][ctx.rcl] === 0) {
        ctx.buildPlanned("road.source", STRUCTURE_ROAD, pos => ctx.isSwamp(pos));
        ctx.buildPlanned("road.controller", STRUCTURE_ROAD, pos => ctx.isSwamp(pos));
    }
    if (!ctx.canCreate()) return;
    if (ctx.rcl < 4) return;

    if (room.storage) {
        ctx.buildPlanned("road", STRUCTURE_ROAD);
        // Roads of the remote mining paths in this room (Hivemind buildOperationRoads)
        for (const pos of operationRoadPositions(room.name)) if (!ctx.tryBuild(pos, STRUCTURE_ROAD)) break;
    }
    manageExtensions(ctx);
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
