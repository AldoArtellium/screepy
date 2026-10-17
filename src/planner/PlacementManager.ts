/**
 * PlacementManager - building cost matrix and placement primitives of the room planner
 *
 * Ported from Hivemind (MIT), src/room/planner/placement-manager.ts.
 *
 * Building matrix values: 0 free, 1 planned road, 5 discouraged (next to a harvest position),
 * 10 near an exit, 30 natural wall (roads may tunnel), >= 100 blocked by a planned structure.
 * The flood fill keeps parent pointers instead of Hivemind's copied path objects (same order:
 * FIFO = lowest range first, first inserted on ties).
 */

import { RoomPlan } from "./RoomPlan";
import { DistanceMatrix, chebyshev, forEachInArea, idx } from "./matrices";

export const ROAD_POSITION = 1;
export const DISCOURAGED_POSITION = 5;
export const IMPASSABLE_POSITION = 255;
export const ROAD_THROUGH_WALL_COST = 30;

/** Planned structure types and their count at RCL 8 */
const MAX_STRUCTURES: { [type: string]: number } = {
    spawn: 3,
    extension: 60,
    tower: 6,
    link: 6,
    storage: 1,
    terminal: 1,
    factory: 1,
    extractor: 1,
};

interface FloodNode {
    i: number;
    range: number;
    parent: FloodNode | null;
    removed: boolean;
}

export class PlacementManager {
    readonly matrix: CostMatrix = new PathFinder.CostMatrix();
    private readonly isWall = new Uint8Array(2500);
    private readonly isSwamp = new Uint8Array(2500);

    private origin: RoomPosition;
    private originEntrances: RoomPosition[] = [];
    private open: FloodNode[] = [];
    private openHead = 0;
    private openIndex: Map<number, FloodNode> = new Map();
    private closed: Uint8Array = new Uint8Array(2500);
    private current: FloodNode | null = null;

    /** PathFinder calls made (CPU diagnostics) */
    pathCalls = 0;

    constructor(
        readonly plan: RoomPlan,
        terrain: RoomTerrain,
        readonly wallDistance: DistanceMatrix,
        readonly exitDistance: DistanceMatrix
    ) {
        for (let y = 0; y < 50; y++) {
            for (let x = 0; x < 50; x++) {
                const t = terrain.get(x, y);
                if (t & TERRAIN_MASK_WALL) {
                    this.isWall[idx(x, y)] = 1;
                    this.matrix.set(x, y, ROAD_THROUGH_WALL_COST);
                    continue;
                }
                if (t & TERRAIN_MASK_SWAMP) this.isSwamp[idx(x, y)] = 1;
                // Border is unwalkable for in-room pathfinding
                if (x === 0 || y === 0 || x === 49 || y === 49) {
                    this.matrix.set(x, y, IMPASSABLE_POSITION);
                    continue;
                }
                // Avoid tiles we can't build ramparts on
                if (exitDistance[idx(x, y)] <= 2) this.matrix.set(x, y, DISCOURAGED_POSITION * 2);
            }
        }
    }

    get roomName(): string {
        return this.plan.roomName;
    }

    pos(x: number, y: number): RoomPosition {
        return new RoomPosition(x, y, this.plan.roomName);
    }

    isWallTile(x: number, y: number): boolean {
        return this.isWall[idx(x, y)] === 1;
    }

    isSwampTile(x: number, y: number): boolean {
        return this.isSwamp[idx(x, y)] === 1;
    }

    getWallDistance(x: number, y: number): number {
        return this.wallDistance[idx(x, y)];
    }

    getExitDistance(x: number, y: number): number {
        return this.exitDistance[idx(x, y)];
    }

    /** Remaining structures of a type before the RCL 8 limit */
    canPlaceMore(type: string): boolean {
        return this.plan.count(type) < (MAX_STRUCTURES[type] ?? 0);
    }

    /** Plans a location; sets the matrix cost (default 255) unless cost is 0/null or the tile is blocked */
    planLocation(pos: { x: number; y: number }, type: string, cost: number | null = IMPASSABLE_POSITION): void {
        this.plan.add(type, pos.x, pos.y);
        if (cost && this.matrix.get(pos.x, pos.y) < 100) this.matrix.set(pos.x, pos.y, cost);
    }

    discouragePosition(x: number, y: number): void {
        const value = this.matrix.get(x, y);
        if (value >= DISCOURAGED_POSITION || value === ROAD_POSITION) return;
        this.matrix.set(x, y, DISCOURAGED_POSITION);
    }

    blockPosition(x: number, y: number): void {
        this.matrix.set(x, y, IMPASSABLE_POSITION);
    }

    isBlockedTile(x: number, y: number): boolean {
        return this.matrix.get(x, y) >= 100;
    }

    /** Whether a structure can be placed on the tile */
    isBuildableTile(x: number, y: number, allowRoads = false, allowNearExit = false): boolean {
        if (x < 0 || y < 0 || x > 49 || y > 49) return false;
        if (this.isWall[idx(x, y)]) return false;
        if (this.exitDistance[idx(x, y)] <= (allowNearExit ? 2 : 5)) return false;

        const value = this.matrix.get(x, y);
        if (value > 100) return false;
        // Tiles next to walls are fine for building, just not for pathing
        if (value === DISCOURAGED_POSITION && this.wallDistance[idx(x, y)] <= 2) return true;
        if (value > 1) return false;
        if (value === ROAD_POSITION && !allowRoads) return false;
        return true;
    }

    /** Road from `from` (excluded) to the closest of `to` (included), swamps cost like plains */
    findAccessRoad(from: RoomPosition, to: RoomPosition[]): RoomPosition[] {
        this.pathCalls++;
        const result = PathFinder.search(from, to, {
            roomCallback: () => this.matrix,
            maxRooms: 1,
            plainCost: 2,
            swampCost: 2,
            heuristicWeight: 0.9,
        });
        return result.path ?? [];
    }

    /** Plans a road from `to` to the base center entrances */
    placeAccessRoad(to: RoomPosition): void {
        for (const pos of this.findAccessRoad(to, this.originEntrances)) this.planLocation(pos, "road", ROAD_POSITION);
    }

    /** Starts a flood fill from origin (kept from the previous call when omitted) */
    startBuildingPlacement(origin?: RoomPosition, originEntrances?: RoomPosition[]): void {
        if (origin) this.origin = origin;
        if (originEntrances) this.originEntrances = originEntrances;
        const root: FloodNode = { i: idx(this.origin.x, this.origin.y), range: 0, parent: null, removed: false };
        this.open = [root];
        this.openHead = 0;
        this.openIndex = new Map([[root.i, root]]);
        this.closed = new Uint8Array(2500);
        this.current = null;
    }

    /** Next buildable tile (no road, range >= 3 from origin) by increasing flood distance */
    getNextAvailableBuildSpot(): RoomPosition | null {
        while (this.openHead < this.open.length) {
            const node = this.open[this.openHead++];
            if (node.removed) continue;
            this.openIndex.delete(node.i);
            this.closed[node.i] = 1;

            const nx = node.i % 50;
            const ny = Math.floor(node.i / 50);
            forEachInArea(nx, ny, (x, y) => {
                if (x === nx && y === ny) return;
                if (!this.isBuildableTile(x, y, true)) return;
                const i = idx(x, y);
                if (this.openIndex.has(i) || this.closed[i]) return;
                const child: FloodNode = { i, range: node.range + 1, parent: node, removed: false };
                this.open.push(child);
                this.openIndex.set(i, child);
            });

            // Don't build too close to the center, nor on roads
            if (chebyshev(nx, ny, this.origin.x, this.origin.y) < 3) continue;
            if (!this.isBuildableTile(nx, ny)) continue;

            this.current = node;
            return this.pos(nx, ny);
        }
        return null;
    }

    /** Flood distance of the last spot returned by getNextAvailableBuildSpot */
    getCurrentBuildSpotRange(): number {
        return this.current?.range ?? 0;
    }

    /** Drops open entries whose flood path goes through pos */
    filterOpenList(pos: { x: number; y: number }): void {
        const target = idx(pos.x, pos.y);
        for (let k = this.openHead; k < this.open.length; k++) {
            const node = this.open[k];
            if (node.removed) continue;
            for (let n: FloodNode | null = node; n; n = n.parent) {
                if (n.i === target) {
                    node.removed = true;
                    this.openIndex.delete(node.i);
                    break;
                }
            }
        }
    }

    /** Places every remaining structure of a type on the next flood spots, optionally with an access road */
    placeAll(type: string, addRoad: boolean, onPlaced?: (pos: RoomPosition) => void): void {
        while (this.canPlaceMore(type)) {
            const pos = this.getNextAvailableBuildSpot();
            if (!pos) break;
            this.planLocation(pos, type);
            onPlaced?.(pos);
            this.filterOpenList(pos);
            if (addRoad) this.placeAccessRoad(pos);
        }
    }
}
