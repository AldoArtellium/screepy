/**
 * RoomPlanner - computes and stores the base layout of owned rooms
 *
 * Ported from Hivemind (MIT), src/room/planner/room-planner.ts, variation-generator.ts,
 * variation-builder.ts and variation-builder-base.ts.
 *
 * Simplified (see docs/hivemind/hivemind-construction.md §2.8): a single "weighted" variation
 * (no spawn in source bays), computed in one tick, no scoring. Skipped steps: helper parking,
 * labs, high level structures, quad breaker, decorative walls. Ramparts on the min cut around the
 * important structures, safe area, towers by rampart coverage, roads to the ramparts and on-ramps
 * follow Hivemind. No exit direction is considered safe (Hivemind: exits towards rooms enemies
 * can't reach). The controller link is not planned (links are not used yet).
 */

import { log } from "../utils/logger";
import { PLAN_VERSION, RoomPlan } from "./RoomPlan";
import { ROAD_POSITION, PlacementManager } from "./PlacementManager";
import { chebyshev, forEachInArea, generateDistanceMatrices, getExitCenters, idx } from "./matrices";
import { getCutTiles, MinCutRect } from "./minCut";
import { scoreRoomPlan } from "./RoomPlanScorer";

/** Room data the planner needs (decoupled from Room so it can run outside the game) */
export interface PlannerInput {
    roomName: string;
    terrain: RoomTerrain;
    controller: { x: number; y: number };
    sources: { id: string; x: number; y: number }[];
    minerals: { id: string; x: number; y: number }[];
    /** Spawn already in the room: kept in the plan, the base center is built next to it */
    spawn?: { x: number; y: number };
    /** Variation to build (default: the first of listVariations) */
    variation?: PlanVariation;
}

/** Hivemind variation: a base center (none = chosen like "weighted") and the sources whose bay holds a spawn */
export interface PlanVariation {
    key: string;
    center?: { x: number; y: number };
    sourcesWithSpawn: string[];
}

/** Closest the base center may be to an existing spawn (the core uses center +-2) */
const MIN_CENTER_SPAWN_RANGE = 3;

/** Ticks before retrying a room whose planning failed */
const RETRY_DELAY = 1000;
/** Minimum bucket to start planning a room */
const MIN_BUCKET = 1000;
/** Safety cap on bay iterations */
const MAX_BAYS = 20;
/** Towers at RCL 8 */
const MAX_TOWERS = 6;
/** Default range around a structure protected by the min cut (Hivemind minCutRampartDistance) */
const RAMPART_DISTANCE = 4;
/** Weight of the tower cover of the core (spawns, storage) against the rampart cover (0..1 each) */
const TOWER_CORE_WEIGHT = 0.5;
/** Planned structures the ramparts enclose with RAMPART_DISTANCE around them (Hivemind: every
 * CONTROLLER_STRUCTURES type but extension, road, container, extractor and link) */
const PROTECTED_STRUCTURES = ["spawn", "storage", "terminal", "factory", "tower", "lab", "nuker", "powerSpawn", "observer"];

/** Safety matrix values (Hivemind TILE_IS_*): endangered = safe but within range 3 of an unsafe tile */
export const TILE_ENDANGERED = 0;
export const TILE_SAFE = 1;
export const TILE_UNSAFE = 2;

/** Tower effect by range, 1 up to range 3, 0 from range 18 (Hivemind getTowerEffectScore) */
function towerEffect(x1: number, y1: number, x2: number, y2: number): number {
    const optimal = 5; // TOWER_OPTIMAL_RANGE
    const falloff = 20; // TOWER_FALLOFF_RANGE
    const range = Math.min(Math.max(chebyshev(x1, y1, x2, y2) + 2, optimal), falloff);
    return 1 - (range - optimal) / (falloff - optimal);
}

class PlanBuilder {
    private readonly pm: PlacementManager;
    private readonly plan: RoomPlan;
    private center: RoomPosition;
    private entrances: RoomPosition[] = [];
    private exitCenters: { x: number; y: number }[] = [];
    private readonly harvestPositions: Map<string, RoomPosition> = new Map();
    /** Areas the min cut must enclose */
    private readonly minCutBounds: MinCutRect[] = [];
    private readonly safety = new Uint8Array(2500);

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
        this.placeRamparts();
        this.sealRoom();
        this.placeTowers();
        this.placeRoadsToRamps();
        this.placeOnRamps();
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
        const { controller, sources, minerals, terrain, spawn, variation } = this.input;
        if (variation?.center) return this.pm.pos(variation.center.x, variation.center.y);
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
        // Not in Hivemind: the center stays free (towers by coverage could land on it, blocking the
        // energy drop point and every path to it); road cost keeps it walkable but not buildable
        this.pm.planLocation(center, "center", ROAD_POSITION);
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
        this.protectPosition(controller, 1);
        const roads = this.findBestControllerRoad(controller);
        if (!roads) return;

        const upgraderPos = roads[0];
        for (const pos of roads) this.protectPosition(pos, 0);
        this.protectPosition(upgraderPos, 1);
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
            const withSpawn = this.input.variation?.sourcesWithSpawn.includes(source.id) ?? false;
            for (const pos of this.pm.findAccessRoad(hp, this.entrances)) {
                this.pm.planLocation(pos, "road", ROAD_POSITION);
                this.pm.planLocation(pos, "road.source", null);
                if (withSpawn) this.protectPosition(pos, 0);
            }
            this.pm.planLocation(hp, "container.source", null);
            this.pm.planLocation(hp, "container", null);
            this.placeBayStructures(hp, { spawn: withSpawn, source: true });
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
            this.protectPosition(pos);
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

    /** Adds the square of `distance` around pos to the areas the min cut encloses */
    private protectPosition(pos: { x: number; y: number }, distance = RAMPART_DISTANCE): void {
        this.minCutBounds.push({
            x1: Math.max(2, pos.x - distance),
            x2: Math.min(47, pos.x + distance),
            y1: Math.max(2, pos.y - distance),
            y2: Math.min(47, pos.y + distance)
        });
    }

    /** Ramparts on the min cut between the protected areas and the exits (Hivemind placeRamparts) */
    private placeRamparts(): void {
        this.protectPosition(this.input.controller, 1);
        for (const type of this.plan.types()) {
            if (!PROTECTED_STRUCTURES.includes(type.split(".")[0])) continue;
            for (const pos of this.plan.getLocations(type)) this.protectPosition(pos);
        }
        const cut = getCutTiles(this.input.terrain, this.minCutBounds).map(c => ({ ...c, relevant: false, irrelevant: false }));
        this.pruneWalls(cut);
        for (const tile of cut) {
            if (!tile.relevant || this.pm.isWallTile(tile.x, tile.y)) continue;
            this.pm.planLocation(tile, "rampart", null);
            this.pm.planLocation(tile, "road", null);
            this.pm.planLocation(tile, "road.rampart", null);
        }
    }

    /**
     * Keeps the cut tiles reached both from inside (center, controller, sources, minerals) and from the
     * exits, and fills the safety matrix: safe inside, unsafe outside, endangered within 3 of outside.
     */
    private pruneWalls(cut: { x: number; y: number; relevant: boolean; irrelevant: boolean }[]): void {
        const { controller, sources, minerals } = this.input;
        const byTile = new Map(cut.map(c => [idx(c.x, c.y), c]));
        const inside = [this.center, controller, ...sources, ...minerals].map(p => idx(p.x, p.y));
        this.floodSafety(inside, byTile, TILE_SAFE);

        for (const tile of cut) {
            tile.irrelevant = !tile.relevant;
            tile.relevant = false;
        }
        const exits: number[] = [];
        for (let i = 0; i < 50; i++) {
            if (!this.pm.isWallTile(0, i)) exits.push(idx(0, i));
            if (!this.pm.isWallTile(49, i)) exits.push(idx(49, i));
            if (!this.pm.isWallTile(i, 0)) exits.push(idx(i, 0));
            if (!this.pm.isWallTile(i, 49)) exits.push(idx(i, 49));
        }
        this.floodSafety(exits, byTile, TILE_UNSAFE);

        for (let i = 0; i < 2500; i++) {
            if (this.safety[i] !== TILE_UNSAFE) continue;
            forEachInArea(
                i % 50,
                Math.floor(i / 50),
                (x, y) => {
                    if (this.safety[idx(x, y)] === TILE_SAFE) this.safety[idx(x, y)] = TILE_ENDANGERED;
                },
                3
            );
        }
    }

    /** Flood fill (8 directions, 1..48, natural walls only through planned roads) stopping at cut tiles */
    private floodSafety(start: number[], cut: Map<number, { relevant: boolean; irrelevant: boolean }>, value: number): void {
        const seen = new Uint8Array(2500);
        const queue = [...new Set(start)];
        for (const i of queue) seen[i] = 1;
        for (let head = 0; head < queue.length; head++) {
            const i = queue[head];
            this.safety[i] = value;
            forEachInArea(i % 50, Math.floor(i / 50), (x, y) => {
                if (x < 1 || x > 48 || y < 1 || y > 48) return;
                const j = idx(x, y);
                if (seen[j]) return;
                if (this.pm.isWallTile(x, y) && !this.plan.has({ x, y }, "road")) return;
                seen[j] = 1;
                const wall = cut.get(j);
                if (wall && !wall.irrelevant) {
                    wall.relevant = true;
                    return;
                }
                queue.push(j);
            });
        }
    }

    /** Nothing gets built outside the safe area; safe tiles are recorded in the plan */
    private sealRoom(): void {
        for (let x = 1; x < 49; x++) {
            for (let y = 1; y < 49; y++) {
                if (this.pm.isWallTile(x, y)) {
                    this.pm.blockPosition(x, y);
                    continue;
                }
                const safety = this.safety[idx(x, y)];
                if (safety === TILE_SAFE) this.pm.planLocation({ x, y }, "safe", null);
                else if (safety !== TILE_ENDANGERED) this.pm.blockPosition(x, y);
            }
        }
    }

    /**
     * 6 towers in the safe area, greedily where they add the most cover to the ramparts least covered
     * so far (Hivemind place-towers step); each must be reachable without tunnels and gets a road.
     * Not in Hivemind: without ramparts (base enclosed by natural walls) towers go on the closest
     * flood spots from the center instead of the top-left safe tiles; the cover of the core (spawns,
     * storage) also counts, else far chokepoints pulled every tower away from the base (W29N7: towers
     * 10-20 tiles from the center, core cover with 6 towers 2.4 -> 4.7 out of 6).
     */
    private placeTowers(): void {
        this.pm.startBuildingPlacement(this.center, this.entrances);
        const ramparts = this.plan.getLocations("rampart").map(pos => ({ pos, score: 1 }));
        if (ramparts.length === 0) {
            this.pm.placeAll("tower", true, pos => {
                this.pm.planLocation(pos, "tower." + (this.plan.count("tower") - 1), null);
            });
            return;
        }
        const core = [...this.plan.getLocations("spawn"), ...this.plan.getLocations("storage")];
        const positions: { pos: RoomPosition; score: number }[] = [];
        for (let x = 1; x < 49; x++) {
            for (let y = 1; y < 49; y++) {
                if (!this.pm.isBuildableTile(x, y) || this.safety[idx(x, y)] !== TILE_SAFE) continue;
                positions.push({ pos: this.pm.pos(x, y), score: 0 });
            }
        }
        const rescore = (): void => {
            const placed = [...this.plan.getLocations("tower"), ...this.plan.getLocations("tower_placeholder")];
            for (const rampart of ramparts) {
                rampart.score = placed.reduce((s, t) => s * (1 - 0.8 * towerEffect(t.x, t.y, rampart.pos.x, rampart.pos.y)), 1);
            }
            for (const info of positions) {
                if (!this.pm.isBuildableTile(info.pos.x, info.pos.y)) info.score = -1;
                if (info.score < 0) continue;
                const rampartCover = ramparts.reduce((s, r) => s + r.score * towerEffect(r.pos.x, r.pos.y, info.pos.x, info.pos.y), 0);
                const coreCover = core.reduce((s, c) => s + towerEffect(c.x, c.y, info.pos.x, info.pos.y), 0) / Math.max(1, core.length);
                info.score = rampartCover / ramparts.length + TOWER_CORE_WEIGHT * coreCover;
            }
        };
        const remaining = (): number => MAX_TOWERS - this.plan.count("tower");

        while (this.pm.canPlaceMore("tower")) {
            const newTowers: RoomPosition[] = [];
            rescore();
            while (newTowers.length < remaining()) {
                // First best in x-then-y order, like lodash _.max
                let best: { pos: RoomPosition; score: number } | null = null;
                for (const info of positions) if (!best || info.score > best.score) best = info;
                if (!best || best.score < 0) break;
                best.score = -1;
                if (!this.pm.isPositionAccessible(best.pos, true)) continue;
                newTowers.push(best.pos);
                this.pm.planTemporaryLocation(best.pos, "tower");
                if (newTowers.length < remaining()) rescore();
            }
            if (newTowers.length === 0) break;
            for (const pos of newTowers) {
                if (!this.pm.isPositionAccessible(pos, true)) continue;
                this.pm.commitTemporaryLocation(pos, "tower");
                this.pm.placeAccessRoad(pos);
            }
            this.pm.discardTemporaryLocations("tower");
        }
        // Not in Hivemind: built closest to the center first (the first towers defend the core and
        // are refilled quickly; the placement order favoured the far ramparts)
        const center = this.center;
        const byRange = this.plan.getLocations("tower").sort((a, b) => a.getRangeTo(center) - b.getRangeTo(center));
        byRange.forEach((pos, i) => this.pm.planLocation(pos, "tower." + i, null));
    }

    /** A road from the center to each group of adjacent ramparts, through extensions if needed */
    private placeRoadsToRamps(): void {
        for (const group of this.rampartGroups()) {
            for (const road of this.pm.findAccessRoad(this.entrances[0], group, true)) {
                if (this.plan.has(road, "extension")) {
                    this.plan.remove("extension", road.x, road.y);
                    this.plan.remove("extension.bay", road.x, road.y);
                    for (let i = 0; i < MAX_BAYS; i++) this.plan.remove(`extension.bay.${i}`, road.x, road.y);
                    this.pm.unblockPosition(road.x, road.y);
                }
                this.pm.planLocation(road, "road", ROAD_POSITION);
            }
        }
    }

    /** Ramparts grouped by 8-connectivity */
    private rampartGroups(): RoomPosition[][] {
        const all = this.plan.getLocations("rampart").map(pos => ({ pos, used: false }));
        const groups: RoomPosition[][] = [];
        for (const rampart of all) {
            if (rampart.used) continue;
            rampart.used = true;
            const group = [rampart.pos];
            let added: boolean;
            do {
                added = false;
                for (const other of all) {
                    if (other.used) continue;
                    if (!group.some(p => chebyshev(p.x, p.y, other.pos.x, other.pos.y) === 1)) continue;
                    other.used = true;
                    group.push(other.pos);
                    added = true;
                }
            } while (added);
            groups.push(group);
        }
        return groups;
    }

    /** Ramparts on the roads within 3 of a rampart in the endangered band (built after the main ones) */
    private placeOnRamps(): void {
        for (const rampart of this.plan.getLocations("rampart")) {
            forEachInArea(
                rampart.x,
                rampart.y,
                (x, y) => {
                    if (this.safety[idx(x, y)] !== TILE_ENDANGERED || this.pm.isWallTile(x, y)) return;
                    if (!this.plan.has({ x, y }, "road") || this.plan.has({ x, y }, "rampart")) return;
                    this.pm.planLocation({ x, y }, "rampart", null);
                    this.pm.planLocation({ x, y }, "rampart.ramp", null);
                },
                3
            );
        }
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
    const builder = new PlanBuilder({ ...input, variation: input.variation ?? listVariations(input)[0] });
    const plan = builder.build();
    return { plan, pathCalls: builder.pathCalls };
}

/**
 * Variations to try (Hivemind variation-generator): base centers x every combination of sources with
 * or without a spawn in their bay ("-" / "+", "-" first). Centers: "weighted", then the tile farthest
 * from walls in each cell of a 3x3 grid. Not in Hivemind: a room with a spawn keeps its center next
 * to the spawn ("spawn").
 */
export function listVariations(input: PlannerInput): PlanVariation[] {
    const centers: { key: string; center?: { x: number; y: number } }[] = [{ key: input.spawn ? "spawn" : "weighted" }];
    if (!input.spawn) {
        const { wall, exit } = generateDistanceMatrices(input.terrain);
        const best: Map<string, { x: number; y: number; distance: number }> = new Map();
        for (let x = 0; x < 50; x++) {
            for (let y = 0; y < 50; y++) {
                const distance = wall[idx(x, y)];
                if (input.terrain.get(x, y) === TERRAIN_MASK_WALL || distance < 3 || distance >= 255 || exit[idx(x, y)] <= 8) continue;
                const cell = `${Math.floor((x * 3) / 50)}x${Math.floor((y * 3) / 50)}`;
                const current = best.get(cell);
                if (!current || current.distance < distance) best.set(cell, { x, y, distance });
            }
        }
        for (const [cell, pos] of best) centers.push({ key: cell, center: { x: pos.x, y: pos.y } });
    }
    let combos: { suffix: string; sources: string[] }[] = [{ suffix: "", sources: [] }];
    for (const source of input.sources) {
        combos = combos.flatMap(c => [
            { suffix: c.suffix + "-", sources: c.sources },
            { suffix: c.suffix + "+", sources: [...c.sources, source.id] }
        ]);
    }
    return centers.flatMap(c => combos.map(combo => ({ key: `${c.key}:${combo.suffix}`, center: c.center, sourcesWithSpawn: combo.sources })));
}

/** Builds and scores a variation */
export function buildVariation(input: PlannerInput, variation: PlanVariation): { plan: RoomPlan | null; score: number; pathCalls: number } {
    const builder = new PlanBuilder({ ...input, variation });
    const plan = builder.build();
    if (!plan) return { plan: null, score: -Infinity, pathCalls: builder.pathCalls };
    const { exit } = generateDistanceMatrices(input.terrain);
    return { plan, score: scoreRoomPlan(plan, input, exit).total, pathCalls: builder.pathCalls };
}

/** Heap state of a room whose variations are still being tried */
interface VariationSearch {
    input: PlannerInput;
    variations: PlanVariation[];
    next: number;
    best: { key: string; score: number; plan: RoomPlan };
}

class RoomPlanner {
    private readonly cache: Map<string, RoomPlan> = new Map();
    private readonly failedAt: Map<string, number> = new Map();
    private readonly searches: Map<string, VariationSearch> = new Map();

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

    /** Every variation was tried: the plan won't change any more */
    isFinal(roomName: string): boolean {
        return !!this.getPlan(roomName) && !!Memory.rooms[roomName].plan!.done;
    }

    private input(room: Room): PlannerInput | null {
        const controller = room.controller;
        if (!controller) return null;
        return {
            roomName: room.name,
            terrain: room.getTerrain(),
            controller: controller.pos,
            sources: room.find(FIND_SOURCES).map(s => ({ id: s.id, x: s.pos.x, y: s.pos.y })),
            minerals: room.find(FIND_MINERALS).map(m => ({ id: m.id, x: m.pos.x, y: m.pos.y })),
            spawn: room.find(FIND_MY_SPAWNS)[0]?.pos
        };
    }

    private store(room: Room, plan: RoomPlan, key: string, score: number, done: boolean): void {
        if (!Memory.rooms) Memory.rooms = {};
        if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {} as RoomMemory;
        Memory.rooms[room.name].plan = { ...plan.serialize(), k: key, s: score, done };
        this.cache.set(room.name, plan);
    }

    /**
     * Plans a room now with its first variation (needs vision), the plan the economy uses while the
     * other variations are tried. Returns the plan or null on failure.
     */
    planRoom(room: Room): RoomPlan | null {
        const input = this.input(room);
        if (!input) return null;
        const start = Game.cpu.getUsed();
        const variations = listVariations(input);
        const { plan, score, pathCalls } = buildVariation(input, variations[0]);
        const cpu = Game.cpu.getUsed() - start;
        if (!plan) {
            this.failedAt.set(room.name, Game.time);
            log.error("RoomPlanner", `${room.name}: planning failed (${cpu.toFixed(1)} CPU)`);
            return null;
        }
        this.store(room, plan, variations[0].key, score, variations.length === 1);
        this.failedAt.delete(room.name);
        this.searches.set(room.name, { input, variations, next: 1, best: { key: variations[0].key, score, plan } });
        log.info(
            "RoomPlanner",
            `${room.name}: planned ${variations[0].key} in ${cpu.toFixed(1)} CPU (${pathCalls} paths), score ${score.toFixed(3)},`,
            `center ${plan.getCenter()}, ${plan.count("extension")} extensions, ${plan.count("spawn")} spawns,`,
            `${plan.count("tower")} towers, ${plan.count("rampart")} ramparts; ${variations.length - 1} variations left`
        );
        return plan;
    }

    /** Nothing was built from the plan yet (besides the first spawn): it can still be swapped */
    private canReplace(room: Room): boolean {
        if (room.find(FIND_MY_CONSTRUCTION_SITES).length > 0) return false;
        return !room.find(FIND_MY_STRUCTURES).some(s => s.structureType !== STRUCTURE_CONTROLLER && s.structureType !== STRUCTURE_SPAWN);
    }

    /** Tries the next variations of a room while CPU allows; at the end keeps the best scored plan */
    private searchVariations(room: Room): void {
        let search = this.searches.get(room.name);
        const memory = Memory.rooms[room.name].plan!;
        if (!search) {
            // Global reset: start over from the stored plan
            const input = this.input(room);
            if (!input) return;
            const variations = listVariations(input);
            const plan = this.getPlan(room.name)!;
            const next = Math.max(1, variations.findIndex(v => v.key === memory.k) + 1);
            search = { input, variations, next, best: { key: memory.k ?? variations[0].key, score: memory.s ?? -Infinity, plan } };
            this.searches.set(room.name, search);
        }
        const budget = Game.cpu.limit * 0.5;
        do {
            const variation = search.variations[search.next++];
            if (!variation) break;
            const { plan, score } = buildVariation(search.input, variation);
            if (plan && score > search.best.score) search.best = { key: variation.key, score, plan };
        } while (search.next < search.variations.length && Game.cpu.getUsed() < budget);

        if (search.next < search.variations.length) return;
        this.searches.delete(room.name);
        if (search.best.key !== memory.k && this.canReplace(room)) {
            this.store(room, search.best.plan, search.best.key, search.best.score, true);
            log.info("RoomPlanner", `${room.name}: best variation ${search.best.key}, score ${search.best.score.toFixed(3)}`);
        } else {
            memory.done = true;
            log.info("RoomPlanner", `${room.name}: keeping ${memory.k}${search.best.key !== memory.k ? ` (${search.best.key} scored better, already building)` : ""}`);
        }
    }

    /** Plans the first owned room without a valid plan, else tries variations of an unfinished plan */
    run(): void {
        if ((Game.cpu.bucket ?? 10000) < MIN_BUCKET) return;
        for (const name in Game.rooms) {
            const room = Game.rooms[name];
            if (!room.controller?.my) continue;
            if (this.getPlan(name)) {
                if (!this.isFinal(name)) {
                    this.searchVariations(room);
                    return;
                }
                continue;
            }
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
