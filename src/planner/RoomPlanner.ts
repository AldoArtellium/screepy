/**
 * RoomPlanner - computes and stores the base layout of owned rooms
 *
 * Ported from Hivemind (MIT), src/room/planner/room-planner.ts, variation-generator.ts,
 * variation-builder.ts and variation-builder-base.ts.
 *
 * Simplified (see docs/hivemind/hivemind-construction.md §2.8): a single "weighted" variation
 * (no spawn in source bays), computed in one tick, no scoring. Skipped steps: helper parking,
 * labs, high level structures, ramparts / min-cut, quad breaker, decorative walls, room sealing,
 * roads to ramps. Towers are placed by flood fill from the center instead of rampart coverage.
 * The controller link is not planned (links are not used yet); source and storage links are.
 */

import { log } from "../utils/logger";
import { PLAN_VERSION, RoomPlan } from "./RoomPlan";
import { ROAD_POSITION, PlacementManager } from "./PlacementManager";
import { chebyshev, forEachInArea, generateDistanceMatrices, getExitCenters } from "./matrices";

/** Room data the planner needs (decoupled from Room so it can run outside the game) */
export interface PlannerInput {
    roomName: string;
    terrain: RoomTerrain;
    controller: { x: number; y: number };
    sources: { id: string; x: number; y: number }[];
    minerals: { id: string; x: number; y: number }[];
    /** Spawn already in the room: kept in the plan, the base center is built next to it */
    spawn?: { x: number; y: number };
}

/** Closest the base center may be to an existing spawn (the core uses center +-2) */
const MIN_CENTER_SPAWN_RANGE = 3;

/** Ticks before retrying a room whose planning failed */
const RETRY_DELAY = 1000;
/** Minimum bucket to start planning a room */
const MIN_BUCKET = 1000;
/** Safety cap on bay iterations */
const MAX_BAYS = 20;

class PlanBuilder {
    private readonly pm: PlacementManager;
    private readonly plan: RoomPlan;
    private center: RoomPosition;
    private entrances: RoomPosition[] = [];
    private exitCenters: { x: number; y: number }[] = [];
    private readonly harvestPositions: Map<string, RoomPosition> = new Map();

    constructor(private readonly input: PlannerInput) {
        const { wall, exit } = generateDistanceMatrices(input.terrain);
        this.plan = new RoomPlan(input.roomName);
        this.pm = new PlacementManager(this.plan, input.terrain, wall, exit);
    }

    get pathCalls(): number {
        return this.pm.pathCalls;
    }

    build(): RoomPlan | null {
        const center = this.chooseCenter();
        if (!center) return null;

        this.gatherExitCoords();
        this.keepExistingSpawn();
        this.determineCorePosition(center);
        this.determineHarvesterPositions();
        this.determineUpgraderPosition();
        this.placeRoadNetwork();
        this.placeRoomCore();
        this.placeHarvestBayStructures();
        this.placeBays();
        this.placeTowers();
        this.placeMissingSpawns();

        if (this.plan.count("spawn") === 0) return null;
        return this.plan;
    }

    /**
     * "weighted" variation: core candidate closest to the mean of controller, exits, minerals and sources.
     * Not in Hivemind: with a spawn already in the room, the candidate closest to it. Energy is dropped at
     * the center before the storage exists; W9N5 (far center through swamps) 3.4k -> 4.6k points, W7N3 -2%.
     */
    private chooseCenter(): RoomPosition | null {
        const { controller, sources, minerals, terrain, spawn } = this.input;
        const points = spawn ? [spawn] : [controller, ...getExitCenters(terrain), ...minerals, ...sources];
        const cx = Math.floor(points.reduce((sum, p) => sum + p.x, 0) / points.length);
        const cy = Math.floor(points.reduce((sum, p) => sum + p.y, 0) / points.length);

        // Relaxed thresholds when no tile is far enough from walls and exits
        for (const [minWall, minExit] of [
            [3, 8],
            [2, 6],
        ]) {
            let best: RoomPosition | null = null;
            let bestRange = Infinity;
            for (let x = 0; x < 50; x++) {
                for (let y = 0; y < 50; y++) {
                    if (this.pm.isWallTile(x, y)) continue;
                    const wallDistance = this.pm.getWallDistance(x, y);
                    if (wallDistance < minWall || wallDistance >= 255) continue;
                    if (this.pm.getExitDistance(x, y) <= minExit) continue;
                    if (spawn && chebyshev(x, y, spawn.x, spawn.y) < MIN_CENTER_SPAWN_RANGE) continue;
                    const range = chebyshev(x, y, cx, cy);
                    if (range < bestRange) {
                        bestRange = range;
                        best = this.pm.pos(x, y);
                    }
                }
            }
            if (best) return best;
        }
        return null;
    }

    /** The existing spawn counts as the first planned spawn and nothing is planned on it */
    private keepExistingSpawn(): void {
        const spawn = this.input.spawn;
        if (!spawn) return;
        this.pm.planLocation(spawn, "spawn.0", null);
        this.pm.planLocation(spawn, "spawn");
    }

    private gatherExitCoords(): void {
        this.exitCenters = getExitCenters(this.input.terrain);
        for (const pos of this.exitCenters) this.pm.planLocation(pos, "exit", null);
    }

    private determineCorePosition(center: RoomPosition): void {
        this.center = center;
        // Center is reached through the 4 cardinal directions
        this.entrances = [
            this.pm.pos(center.x + 2, center.y),
            this.pm.pos(center.x - 2, center.y),
            this.pm.pos(center.x, center.y + 2),
            this.pm.pos(center.x, center.y - 2),
        ];
        this.pm.planLocation(center, "center", null);
    }

    private determineHarvesterPositions(): void {
        for (const source of this.input.sources) {
            const hp = this.findHarvestPosition(source);
            if (!hp) continue;
            this.pm.planLocation(hp, "harvester", null);
            this.pm.planLocation(hp, "harvester." + source.id, null);
            this.pm.planLocation(hp, "bay_center", null);

            // Discourage roads through the tiles around the harvest position
            forEachInArea(hp.x, hp.y, (x, y) => {
                if (!this.pm.isWallTile(x, y)) this.pm.discouragePosition(x, y);
            });

            // No other path through the harvester position
            this.pm.blockPosition(hp.x, hp.y);
            this.harvestPositions.set(source.id, hp);
        }

        // Minerals: extractor, road and container (not built yet, but they shape the road network)
        for (const mineral of this.input.minerals) {
            const pos = this.pm.pos(mineral.x, mineral.y);
            this.pm.planLocation(pos, "extractor");
            const roads = this.pm.findAccessRoad(pos, this.entrances);
            for (const road of roads) {
                this.pm.planLocation(road, "road", ROAD_POSITION);
                this.pm.planLocation(road, "road.mineral", null);
            }
            this.placeContainer(roads, "mineral");
            if (roads.length > 0) this.pm.blockPosition(roads[0].x, roads[0].y);
        }
    }

    /** Adjacent buildable tile with the most buildable tiles in its 3x3 (first wins on ties) */
    private findHarvestPosition(source: { x: number; y: number }): RoomPosition | null {
        let best: { x: number; y: number; free: number } | null = null;
        forEachInArea(source.x, source.y, (x, y) => {
            if (!this.pm.isBuildableTile(x, y)) return;
            let free = 0;
            forEachInArea(x, y, (x2, y2) => {
                if (this.pm.isBuildableTile(x2, y2)) free++;
            });
            if (!best || best.free < free) best = { x, y, free };
        });

        // Not in Hivemind (it would crash): source close to an exit or boxed in
        if (!best) {
            forEachInArea(source.x, source.y, (x, y) => {
                if (best || this.pm.isWallTile(x, y) || this.pm.isBlockedTile(x, y)) return;
                if (x === 0 || y === 0 || x === 49 || y === 49) return;
                best = { x, y, free: 0 };
            });
        }

        const found = best as { x: number; y: number } | null;
        return found ? this.pm.pos(found.x, found.y) : null;
    }

    private determineUpgraderPosition(): void {
        const controller = this.input.controller;
        const roads = this.findBestControllerRoad(controller);
        if (!roads) return;

        const upgraderPos = roads[0];
        for (let i = 1; i < roads.length; i++) {
            this.pm.planLocation(roads[i], "road", ROAD_POSITION);
            this.pm.planLocation(roads[i], "road.controller", null);
        }

        // Spot where the main upgrader stays
        this.pm.planLocation(upgraderPos, "upgrader.0", ROAD_POSITION);

        const container = this.placeContainer(roads, "controller");
        if (container) {
            this.pm.planLocation(container, "road", null);
            this.pm.planLocation(container, "road.controller", null);

            // Roads on swamps around the container so upgraders don't wander away from it
            forEachInArea(container.x, container.y, (x, y) => {
                if (!this.pm.isBuildableTile(x, y, false, true)) return;
                if (!this.pm.isSwampTile(x, y)) return;
                this.pm.planLocation({ x, y }, "road", ROAD_POSITION);
                this.pm.planLocation({ x, y }, "road.controller", null);
            });
        }

        // No other path through the upgrader position
        this.pm.blockPosition(upgraderPos.x, upgraderPos.y);
    }

    /** Tile within range 3 of the controller with >= 3 upgrade spots, minimizing road length - 1.1 * spots */
    private findBestControllerRoad(controller: { x: number; y: number }): RoomPosition[] | null {
        let best: { path: RoomPosition[]; score: number } | null = null;
        forEachInArea(
            controller.x,
            controller.y,
            (x, y) => {
                if (this.pm.isWallTile(x, y)) return;
                const spots = this.countUpgraderSpots(x, y, controller);
                if (spots < 3) return;

                const start = this.pm.pos(x, y);
                const path = [start, ...this.pm.findAccessRoad(start, this.entrances)];
                const score = path.length - spots * 1.1;
                if (!best || best.score > score) best = { path, score };
            },
            3
        );
        const found = best as { path: RoomPosition[] } | null;
        return found ? found.path : null;
    }

    /** Non-wall tiles of the 3x3 around (x, y) within range 3 of the controller */
    private countUpgraderSpots(x: number, y: number, controller: { x: number; y: number }): number {
        let spots = 0;
        forEachInArea(x, y, (x2, y2) => {
            if (this.pm.isWallTile(x2, y2)) return;
            if (chebyshev(x2, y2, controller.x, controller.y) > 3) return;
            spots++;
        });
        return spots;
    }

    /** Container on roads[0], else roads[1], else a buildable tile next to roads[0..2] */
    private placeContainer(roads: RoomPosition[], type: string): RoomPosition | null {
        let pos: RoomPosition | null = null;
        for (const road of roads.slice(0, 2)) {
            if (this.pm.isBuildableTile(road.x, road.y, true, true)) {
                pos = road;
                break;
            }
        }
        if (!pos) {
            for (const road of roads.slice(0, 3)) {
                forEachInArea(road.x, road.y, (x, y) => {
                    if (!this.pm.isBuildableTile(x, y, false, true)) return true;
                    pos = this.pm.pos(x, y);
                    return false;
                });
                if (pos) break;
            }
        }
        if (!pos) return null;

        const found: RoomPosition = pos;
        this.pm.planLocation(found, "container." + type, null);
        this.pm.planLocation(found, "container", ROAD_POSITION);
        return found;
    }

    /** Exit corridors: roads from each exit to the center, kept in the matrix only */
    private placeRoadNetwork(): void {
        for (const exit of this.exitCenters) {
            const roads = this.pm.findAccessRoad(this.pm.pos(exit.x, exit.y), this.entrances);
            for (const pos of roads) this.pm.planLocation(pos, "road.exit", ROAD_POSITION);
        }
        this.plan.removeType("road.exit");
    }

    /** Diamond of roads around the center, storage below, terminal above */
    private placeRoomCore(): void {
        const c = this.center;
        for (const [dx, dy] of [
            [-2, 0],
            [2, 0],
            [0, -2],
            [0, 2],
            [-1, -1],
            [-1, 1],
            [1, -1],
            [1, 1],
        ]) {
            this.pm.planLocation({ x: c.x + dx, y: c.y + dy }, "road", ROAD_POSITION);
        }

        this.pm.planLocation({ x: c.x, y: c.y + 1 }, "storage");
        this.pm.planLocation({ x: c.x, y: c.y - 1 }, "terminal");
        this.pm.planLocation({ x: c.x + 1, y: c.y }, "factory");
        this.pm.planLocation({ x: c.x - 1, y: c.y }, "link");
        this.pm.planLocation({ x: c.x - 1, y: c.y }, "link.storage");
    }

    /** Source roads, container on the harvest position, then link + extensions around it */
    private placeHarvestBayStructures(): void {
        for (const source of this.input.sources) {
            const hp = this.harvestPositions.get(source.id);
            if (!hp) continue;
            for (const pos of this.pm.findAccessRoad(hp, this.entrances)) {
                this.pm.planLocation(pos, "road", ROAD_POSITION);
                this.pm.planLocation(pos, "road.source", null);
            }
            this.pm.planLocation(hp, "container.source", null);
            this.pm.planLocation(hp, "container", null);
            this.placeBayStructures(hp, { spawn: false, source: true });
        }
    }

    /** Extension bays: 3x3 squares around a free center, closest to the base center first */
    private placeBays(): void {
        let count = 0;
        while (this.pm.canPlaceMore("extension") && count < MAX_BAYS) {
            const pos = this.findBayPosition();
            if (!pos) break;
            this.pm.placeAccessRoad(pos);
            this.pm.planLocation(pos, "bay_center", ROAD_POSITION);
            this.placeBayStructures(pos, { spawn: true, id: count++ });
        }
    }

    private findBayPosition(): RoomPosition | null {
        let maxExtensions = 0;
        let bestPos: RoomPosition | null = null;
        let bestScore = 0;

        this.pm.startBuildingPlacement(this.center, this.entrances);
        while (maxExtensions < 8) {
            const pos = this.pm.getNextAvailableBuildSpot();
            if (!pos) break;
            if (this.pm.getExitDistance(pos.x, pos.y) < 8) continue;
            if (!this.pm.isBuildableTile(pos.x, pos.y)) continue;

            let tiles = 0;
            forEachInArea(pos.x, pos.y, (x, y) => {
                if ((x !== pos.x || y !== pos.y) && this.pm.isBuildableTile(x, y)) tiles++;
            });
            if (tiles <= maxExtensions) continue;

            maxExtensions = tiles;
            const score = tiles / (this.pm.getCurrentBuildSpotRange() + 10);
            if (score > bestScore && tiles >= 4) {
                bestPos = pos;
                bestScore = score;
            }
        }

        return maxExtensions < 4 ? null : bestPos;
    }

    /**
     * Structures around a bay center: one spawn next to a planned road (bays only, while spawns
     * remain), a link first in source bays, then extensions (capped at 60 in total).
     */
    private placeBayStructures(bay: RoomPosition, options: { spawn?: boolean; source?: boolean; id?: number }): void {
        const allowNearExit = !!options.source && !options.spawn;

        if (options.spawn && this.pm.canPlaceMore("spawn")) {
            forEachInArea(bay.x, bay.y, (x, y) => {
                if (this.pm.isWallTile(x, y)) return true;
                if (!this.pm.isBuildableTile(x, y, false, allowNearExit)) return true;
                if (x === bay.x && y === bay.y) return true;

                // Only next to a road, so creeps can leave when the bay center is occupied
                let placed = false;
                forEachInArea(x, y, (x2, y2) => {
                    if (x2 === bay.x && y2 === bay.y) return true;
                    if (!this.plan.has({ x: x2, y: y2 }, "road")) return true;
                    this.pm.planLocation({ x, y }, "spawn." + this.plan.count("spawn"));
                    this.pm.planLocation({ x, y }, "spawn");
                    placed = true;
                    return false;
                });
                return !placed;
            });
        }

        let linkPlaced = !this.pm.canPlaceMore("link") || !options.source;
        forEachInArea(bay.x, bay.y, (x, y) => {
            if (this.pm.isWallTile(x, y)) return;
            if (!this.pm.isBuildableTile(x, y, false, allowNearExit)) return;
            if (x === bay.x && y === bay.y) return;

            if (!linkPlaced) {
                this.pm.planLocation({ x, y }, "link");
                if (options.source) this.pm.planLocation({ x, y }, "link.source");
                linkPlaced = true;
                return;
            }

            if (!this.pm.canPlaceMore("extension")) return;
            this.pm.planLocation({ x, y }, "extension");
            if (options.source) {
                this.pm.planLocation({ x, y }, "extension.harvester");
            } else {
                if (options.id !== undefined) this.pm.planLocation({ x, y }, "extension.bay." + options.id);
                this.pm.planLocation({ x, y }, "extension.bay");
            }
        });
    }

    /** 6 towers on the closest flood spots from the center, each with an access road */
    private placeTowers(): void {
        this.pm.startBuildingPlacement(this.center, this.entrances);
        this.pm.placeAll("tower", true, pos => {
            this.pm.planLocation(pos, "tower." + (this.plan.count("tower") - 1), null);
        });
    }

    /** Not in Hivemind: spawns the bays could not hold go on the next flood spots */
    private placeMissingSpawns(): void {
        if (!this.pm.canPlaceMore("spawn")) return;
        this.pm.placeAll("spawn", true, pos => {
            this.pm.planLocation(pos, "spawn." + (this.plan.count("spawn") - 1), null);
        });
    }
}

/** Computes a room plan from raw room data (no Game access besides PathFinder / RoomPosition) */
export function generateRoomPlan(input: PlannerInput): { plan: RoomPlan | null; pathCalls: number } {
    const builder = new PlanBuilder(input);
    const plan = builder.build();
    return { plan, pathCalls: builder.pathCalls };
}

class RoomPlanner {
    private readonly cache: Map<string, RoomPlan> = new Map();
    private readonly failedAt: Map<string, number> = new Map();

    /** Plan of an owned room (heap cache, else Memory.rooms[r].plan if version matches), null if not planned yet */
    getPlan(roomName: string): RoomPlan | null {
        const memory = Memory.rooms?.[roomName]?.plan;
        if (!memory || memory.v !== PLAN_VERSION) {
            // Deleted or outdated in Memory: replan
            this.cache.delete(roomName);
            return null;
        }

        let plan = this.cache.get(roomName);
        if (!plan) {
            plan = RoomPlan.deserialize(roomName, memory);
            this.cache.set(roomName, plan);
        }
        return plan;
    }

    /** Compute and store the plan of a room now (needs vision). Returns the plan or null on failure */
    planRoom(room: Room): RoomPlan | null {
        const controller = room.controller;
        if (!controller) return null;

        const start = Game.cpu.getUsed();
        const { plan, pathCalls } = generateRoomPlan({
            roomName: room.name,
            terrain: room.getTerrain(),
            controller: controller.pos,
            sources: room.find(FIND_SOURCES).map(s => ({ id: s.id, x: s.pos.x, y: s.pos.y })),
            minerals: room.find(FIND_MINERALS).map(m => ({ id: m.id, x: m.pos.x, y: m.pos.y })),
            spawn: room.find(FIND_MY_SPAWNS)[0]?.pos
        });
        const cpu = Game.cpu.getUsed() - start;

        if (!plan) {
            this.failedAt.set(room.name, Game.time);
            log.error("RoomPlanner", `${room.name}: planning failed (${cpu.toFixed(1)} CPU)`);
            return null;
        }

        if (!Memory.rooms) Memory.rooms = {};
        if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {} as RoomMemory;
        Memory.rooms[room.name].plan = plan.serialize();
        this.cache.set(room.name, plan);
        this.failedAt.delete(room.name);

        log.info(
            "RoomPlanner",
            `${room.name}: planned in ${cpu.toFixed(1)} CPU (${pathCalls} paths), center ${plan.getCenter()},`,
            `${plan.count("extension")} extensions, ${plan.count("spawn")} spawns, ${plan.count("tower")} towers`
        );
        return plan;
    }

    /** Plans the first owned room without a valid plan */
    run(): void {
        if ((Game.cpu.bucket ?? 10000) < MIN_BUCKET) return;
        for (const name in Game.rooms) {
            const room = Game.rooms[name];
            if (!room.controller?.my) continue;
            if (this.getPlan(name)) continue;
            const failed = this.failedAt.get(name);
            if (failed !== undefined && Game.time - failed < RETRY_DELAY) continue;
            this.planRoom(room);
            return;
        }
    }
}

export const roomPlanner = new RoomPlanner();

/** Module for ModuleManager: plans each owned room that has no valid plan (bucket >= 1000), one room per run */
export const roomPlannerModule = (): void => roomPlanner.run();
