/**
 * BasePlanner - Dynamic base layout generation
 *
 * Features:
 * - Terrain analysis (open spaces, walls, swamps)
 * - Distance mapping from key positions
 * - Spawn cluster optimization
 * - Extension placement (stamps/fill patterns)
 * - Lab cluster configuration
 * - Storage/terminal/link core
 * - Road network generation
 * - Rampart perimeter planning
 * - Adaptive replanning for RCL progression
 */

import { log } from "../utils/logger";

/** Structure placement with position */
interface PlannedStructure {
    structureType: BuildableStructureConstant;
    x: number;
    y: number;
    priority: number;
    minRCL: number;
}

/** Base plan for a room */
interface BasePlan {
    roomName: string;
    version: number;
    generatedAt: number;
    anchor: { x: number; y: number };
    structures: PlannedStructure[];
    roads: { x: number; y: number }[];
    ramparts: { x: number; y: number }[];
}

/** Stamp patterns for structure clusters */
const STAMPS = {
    /** 3x3 spawn cluster */
    SPAWN_CLUSTER: {
        structures: [
            { dx: 0, dy: 0, type: STRUCTURE_SPAWN },
            { dx: 1, dy: 0, type: STRUCTURE_SPAWN },
            { dx: 2, dy: 0, type: STRUCTURE_SPAWN },
            { dx: 0, dy: 1, type: STRUCTURE_EXTENSION },
            { dx: 1, dy: 1, type: STRUCTURE_LINK },
            { dx: 2, dy: 1, type: STRUCTURE_EXTENSION },
        ],
        width: 3,
        height: 2
    },
    /** Storage core */
    STORAGE_CORE: {
        structures: [
            { dx: 0, dy: 0, type: STRUCTURE_STORAGE },
            { dx: 1, dy: 0, type: STRUCTURE_TERMINAL },
            { dx: 0, dy: 1, type: STRUCTURE_LINK },
            { dx: 1, dy: 1, type: STRUCTURE_FACTORY },
        ],
        width: 2,
        height: 2
    },
    /** Lab cluster (10 labs in diamond) */
    LAB_CLUSTER: {
        structures: [
            // Input labs (2)
            { dx: 1, dy: 0, type: STRUCTURE_LAB },
            { dx: 2, dy: 0, type: STRUCTURE_LAB },
            // Output labs (8)
            { dx: 0, dy: 1, type: STRUCTURE_LAB },
            { dx: 1, dy: 1, type: STRUCTURE_LAB },
            { dx: 2, dy: 1, type: STRUCTURE_LAB },
            { dx: 3, dy: 1, type: STRUCTURE_LAB },
            { dx: 0, dy: 2, type: STRUCTURE_LAB },
            { dx: 1, dy: 2, type: STRUCTURE_LAB },
            { dx: 2, dy: 2, type: STRUCTURE_LAB },
            { dx: 3, dy: 2, type: STRUCTURE_LAB },
        ],
        width: 4,
        height: 3
    },
    /** Tower cluster */
    TOWER_CLUSTER: {
        structures: [
            { dx: 0, dy: 0, type: STRUCTURE_TOWER },
            { dx: 1, dy: 0, type: STRUCTURE_TOWER },
            { dx: 2, dy: 0, type: STRUCTURE_TOWER },
            { dx: 0, dy: 1, type: STRUCTURE_TOWER },
            { dx: 1, dy: 1, type: STRUCTURE_TOWER },
            { dx: 2, dy: 1, type: STRUCTURE_TOWER },
        ],
        width: 3,
        height: 2
    }
};

/** Structure count limits by RCL - reserved for future validation */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const STRUCTURE_LIMITS: Record<BuildableStructureConstant, number[]> = {
    [STRUCTURE_SPAWN]: [0, 1, 1, 1, 1, 1, 1, 2, 3],
    [STRUCTURE_EXTENSION]: [0, 0, 5, 10, 20, 30, 40, 50, 60],
    [STRUCTURE_TOWER]: [0, 0, 0, 1, 1, 2, 2, 3, 6],
    [STRUCTURE_STORAGE]: [0, 0, 0, 0, 1, 1, 1, 1, 1],
    [STRUCTURE_TERMINAL]: [0, 0, 0, 0, 0, 0, 1, 1, 1],
    [STRUCTURE_LAB]: [0, 0, 0, 0, 0, 0, 3, 6, 10],
    [STRUCTURE_LINK]: [0, 0, 0, 0, 0, 2, 3, 4, 6],
    [STRUCTURE_FACTORY]: [0, 0, 0, 0, 0, 0, 0, 1, 1],
    [STRUCTURE_OBSERVER]: [0, 0, 0, 0, 0, 0, 0, 0, 1],
    [STRUCTURE_POWER_SPAWN]: [0, 0, 0, 0, 0, 0, 0, 0, 1],
    [STRUCTURE_NUKER]: [0, 0, 0, 0, 0, 0, 0, 0, 1],
    [STRUCTURE_EXTRACTOR]: [0, 0, 0, 0, 0, 0, 1, 1, 1],
    [STRUCTURE_ROAD]: [0, 2500, 2500, 2500, 2500, 2500, 2500, 2500, 2500],
    [STRUCTURE_CONTAINER]: [5, 5, 5, 5, 5, 5, 5, 5, 5],
    [STRUCTURE_RAMPART]: [0, 0, 300000, 1000000, 3000000, 10000000, 30000000, 100000000, 300000000],
    [STRUCTURE_WALL]: [0, 0, 2500, 2500, 2500, 2500, 2500, 2500, 2500],
};

/** Configuration */
const CONFIG = {
    /** Minimum distance from room edge */
    EDGE_BUFFER: 4,
    /** Distance to prefer from sources */
    SOURCE_DISTANCE: 4,
    /** Distance to prefer from controller */
    CONTROLLER_DISTANCE: 3,
    /** Plan version (increment to regenerate) */
    PLAN_VERSION: 1
};

class BasePlanner {
    /** Cached plans per room */
    private plans: Map<string, BasePlan> = new Map();

    /** Distance transforms cache */
    private distanceCache: Map<string, CostMatrix> = new Map();

    /**
     * Main planning function - generates or retrieves base plan
     */
    getPlan(roomName: string, forceRegenerate: boolean = false): BasePlan | null {
        // Check cache
        const cached = this.plans.get(roomName);
        if (cached && !forceRegenerate && cached.version === CONFIG.PLAN_VERSION) {
            return cached;
        }

        // Check memory
        const memPlan = Memory.basePlans?.[roomName];
        if (memPlan && !forceRegenerate && memPlan.version === CONFIG.PLAN_VERSION) {
            this.plans.set(roomName, memPlan);
            return memPlan;
        }

        // Generate new plan
        const room = Game.rooms[roomName];
        if (!room) return null;

        const plan = this.generatePlan(room);
        if (plan) {
            this.plans.set(roomName, plan);

            // Store in memory
            if (!Memory.basePlans) Memory.basePlans = {};
            Memory.basePlans[roomName] = plan;
        }

        return plan;
    }

    /**
     * Generate a base plan for a room
     */
    private generatePlan(room: Room): BasePlan | null {
        log.info("BasePlanner", `Generating plan for ${room.name}`);

        // Analyze terrain
        const terrain = new Room.Terrain(room.name);
        const distanceTransform = this.calculateDistanceTransform(room.name, terrain);

        // Find optimal anchor point (center of base)
        const anchor = this.findAnchor(room, distanceTransform);
        if (!anchor) {
            log.warn("BasePlanner", `Could not find anchor for ${room.name}`);
            return null;
        }

        const plan: BasePlan = {
            roomName: room.name,
            version: CONFIG.PLAN_VERSION,
            generatedAt: Game.time,
            anchor,
            structures: [],
            roads: [],
            ramparts: []
        };

        // Place core structures
        this.placeSpawnCluster(plan, anchor, distanceTransform);
        this.placeStorageCore(plan, anchor, distanceTransform);
        this.placeTowers(plan, anchor, distanceTransform);
        this.placeLabCluster(plan, anchor, distanceTransform);

        // Place extensions
        this.placeExtensions(plan, anchor, distanceTransform, terrain);

        // Place links at sources and controller
        this.placeLinks(plan, room);

        // Place extractor
        this.placeExtractor(plan, room);

        // Generate roads
        this.generateRoads(plan, room);

        // Generate rampart perimeter
        this.generateRamparts(plan, anchor, distanceTransform);

        // Sort structures by priority
        plan.structures.sort((a, b) => a.priority - b.priority);

        log.info("BasePlanner", `Plan generated: ${plan.structures.length} structures, ${plan.roads.length} roads`);
        return plan;
    }

    /**
     * Calculate distance transform (distance from walls)
     */
    private calculateDistanceTransform(roomName: string, terrain: RoomTerrain): CostMatrix {
        const cached = this.distanceCache.get(roomName);
        if (cached) return cached;

        const matrix = new PathFinder.CostMatrix();

        // Initial pass: mark walls as 0, others as 255
        for (let x = 0; x < 50; x++) {
            for (let y = 0; y < 50; y++) {
                if (terrain.get(x, y) === TERRAIN_MASK_WALL) {
                    matrix.set(x, y, 0);
                } else if (x < CONFIG.EDGE_BUFFER || x >= 50 - CONFIG.EDGE_BUFFER ||
                          y < CONFIG.EDGE_BUFFER || y >= 50 - CONFIG.EDGE_BUFFER) {
                    matrix.set(x, y, 0); // Treat edges as walls
                } else {
                    matrix.set(x, y, 255);
                }
            }
        }

        // Distance transform using two-pass algorithm
        // Forward pass
        for (let y = 1; y < 49; y++) {
            for (let x = 1; x < 49; x++) {
                const current = matrix.get(x, y);
                if (current === 0) continue;

                const min = Math.min(
                    matrix.get(x - 1, y - 1) + 1,
                    matrix.get(x, y - 1) + 1,
                    matrix.get(x + 1, y - 1) + 1,
                    matrix.get(x - 1, y) + 1
                );
                matrix.set(x, y, Math.min(current, min));
            }
        }

        // Backward pass
        for (let y = 48; y > 0; y--) {
            for (let x = 48; x > 0; x--) {
                const current = matrix.get(x, y);
                if (current === 0) continue;

                const min = Math.min(
                    matrix.get(x + 1, y + 1) + 1,
                    matrix.get(x, y + 1) + 1,
                    matrix.get(x - 1, y + 1) + 1,
                    matrix.get(x + 1, y) + 1
                );
                matrix.set(x, y, Math.min(current, min));
            }
        }

        this.distanceCache.set(roomName, matrix);
        return matrix;
    }

    /**
     * Find optimal anchor point for base
     */
    private findAnchor(room: Room, distanceTransform: CostMatrix): { x: number; y: number } | null {
        const sources = room.find(FIND_SOURCES);
        const controller = room.controller;

        let bestPos: { x: number; y: number } | null = null;
        let bestScore = -Infinity;

        // Find positions with good distance from walls
        for (let x = CONFIG.EDGE_BUFFER; x < 50 - CONFIG.EDGE_BUFFER; x++) {
            for (let y = CONFIG.EDGE_BUFFER; y < 50 - CONFIG.EDGE_BUFFER; y++) {
                const wallDist = distanceTransform.get(x, y);
                if (wallDist < 5) continue; // Need 5x5 open space minimum

                // Calculate score
                let score = wallDist * 10; // Prefer open areas

                // Distance to sources (prefer closer but not too close)
                for (const source of sources) {
                    const dist = Math.abs(source.pos.x - x) + Math.abs(source.pos.y - y);
                    if (dist < CONFIG.SOURCE_DISTANCE) {
                        score -= 20; // Too close
                    } else if (dist < 15) {
                        score += 10;
                    }
                }

                // Distance to controller (prefer closer)
                if (controller) {
                    const dist = Math.abs(controller.pos.x - x) + Math.abs(controller.pos.y - y);
                    if (dist < CONFIG.CONTROLLER_DISTANCE) {
                        score -= 10; // Too close
                    } else if (dist < 20) {
                        score += 5;
                    }
                }

                // Prefer center of room
                const centerDist = Math.abs(25 - x) + Math.abs(25 - y);
                score -= centerDist * 0.5;

                if (score > bestScore) {
                    bestScore = score;
                    bestPos = { x, y };
                }
            }
        }

        return bestPos;
    }

    /**
     * Place spawn cluster
     */
    private placeSpawnCluster(plan: BasePlan, anchor: { x: number; y: number }, dt: CostMatrix): void {
        const stamp = STAMPS.SPAWN_CLUSTER;

        // Find best position near anchor
        const pos = this.findStampPosition(anchor, stamp.width, stamp.height, dt, plan);
        if (!pos) return;

        for (const s of stamp.structures) {
            plan.structures.push({
                structureType: s.type,
                x: pos.x + s.dx,
                y: pos.y + s.dy,
                priority: s.type === STRUCTURE_SPAWN ? 1 : 10,
                minRCL: s.type === STRUCTURE_SPAWN ? 1 : 5
            });
        }
    }

    /**
     * Place storage core
     */
    private placeStorageCore(plan: BasePlan, anchor: { x: number; y: number }, dt: CostMatrix): void {
        const stamp = STAMPS.STORAGE_CORE;
        const pos = this.findStampPosition(anchor, stamp.width, stamp.height, dt, plan);
        if (!pos) return;

        for (const s of stamp.structures) {
            let minRCL = 4;
            let priority = 20;

            if (s.type === STRUCTURE_STORAGE) { minRCL = 4; priority = 15; }
            if (s.type === STRUCTURE_TERMINAL) { minRCL = 6; priority = 25; }
            if (s.type === STRUCTURE_LINK) { minRCL = 5; priority = 22; }
            if (s.type === STRUCTURE_FACTORY) { minRCL = 7; priority = 30; }

            plan.structures.push({
                structureType: s.type,
                x: pos.x + s.dx,
                y: pos.y + s.dy,
                priority,
                minRCL
            });
        }
    }

    /**
     * Place towers
     */
    private placeTowers(plan: BasePlan, anchor: { x: number; y: number }, dt: CostMatrix): void {
        const stamp = STAMPS.TOWER_CLUSTER;
        const pos = this.findStampPosition(anchor, stamp.width, stamp.height, dt, plan);
        if (!pos) return;

        const rclForTower = [3, 3, 5, 5, 7, 7];
        let towerIndex = 0;

        for (const s of stamp.structures) {
            plan.structures.push({
                structureType: s.type,
                x: pos.x + s.dx,
                y: pos.y + s.dy,
                priority: 8,
                minRCL: rclForTower[towerIndex++] ?? 8
            });
        }
    }

    /**
     * Place lab cluster
     */
    private placeLabCluster(plan: BasePlan, anchor: { x: number; y: number }, dt: CostMatrix): void {
        const stamp = STAMPS.LAB_CLUSTER;
        const pos = this.findStampPosition(anchor, stamp.width, stamp.height, dt, plan);
        if (!pos) return;

        const rclForLab = [6, 6, 6, 7, 7, 7, 8, 8, 8, 8];
        let labIndex = 0;

        for (const s of stamp.structures) {
            plan.structures.push({
                structureType: s.type,
                x: pos.x + s.dx,
                y: pos.y + s.dy,
                priority: 35,
                minRCL: rclForLab[labIndex++] ?? 8
            });
        }
    }

    /**
     * Place extensions in open spaces
     */
    private placeExtensions(
        plan: BasePlan,
        anchor: { x: number; y: number },
        dt: CostMatrix,
        terrain: RoomTerrain
    ): void {
        const placed = new Set<string>();

        // Mark already planned positions
        for (const s of plan.structures) {
            placed.add(`${s.x},${s.y}`);
        }

        // Find positions in spiral from anchor
        const positions: { x: number; y: number; dist: number }[] = [];

        for (let dx = -15; dx <= 15; dx++) {
            for (let dy = -15; dy <= 15; dy++) {
                const x = anchor.x + dx;
                const y = anchor.y + dy;

                if (x < 2 || x > 47 || y < 2 || y > 47) continue;
                if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
                if (dt.get(x, y) < 2) continue;
                if (placed.has(`${x},${y}`)) continue;

                positions.push({ x, y, dist: Math.abs(dx) + Math.abs(dy) });
            }
        }

        // Sort by distance from anchor
        positions.sort((a, b) => a.dist - b.dist);

        // Place up to 60 extensions
        const rclThresholds = [0, 0, 5, 10, 20, 30, 40, 50, 60];
        let extensionCount = 0;

        for (const pos of positions) {
            if (extensionCount >= 60) break;

            // Skip if adjacent to existing structure (checkerboard pattern)
            const hasAdjacent = this.hasAdjacentStructure(pos.x, pos.y, placed);
            if (hasAdjacent && extensionCount > 10) continue;

            // Determine minRCL based on count
            let minRCL = 2;
            for (let rcl = 8; rcl >= 2; rcl--) {
                if (extensionCount < rclThresholds[rcl]) {
                    minRCL = rcl;
                }
            }

            plan.structures.push({
                structureType: STRUCTURE_EXTENSION,
                x: pos.x,
                y: pos.y,
                priority: 5 + extensionCount * 0.1,
                minRCL
            });

            placed.add(`${pos.x},${pos.y}`);
            extensionCount++;
        }
    }

    /**
     * Place links at sources and controller
     */
    private placeLinks(plan: BasePlan, room: Room): void {
        const controller = room.controller;
        const sources = room.find(FIND_SOURCES);

        // Controller link
        if (controller) {
            const pos = this.findAdjacentPosition(controller.pos, plan);
            if (pos) {
                plan.structures.push({
                    structureType: STRUCTURE_LINK,
                    x: pos.x,
                    y: pos.y,
                    priority: 18,
                    minRCL: 5
                });
            }
        }

        // Source links
        for (const source of sources) {
            const pos = this.findAdjacentPosition(source.pos, plan);
            if (pos) {
                plan.structures.push({
                    structureType: STRUCTURE_LINK,
                    x: pos.x,
                    y: pos.y,
                    priority: 20,
                    minRCL: 6
                });
            }
        }
    }

    /**
     * Place extractor on mineral
     */
    private placeExtractor(plan: BasePlan, room: Room): void {
        const minerals = room.find(FIND_MINERALS);
        if (minerals.length === 0) return;

        const mineral = minerals[0];
        plan.structures.push({
            structureType: STRUCTURE_EXTRACTOR,
            x: mineral.pos.x,
            y: mineral.pos.y,
            priority: 40,
            minRCL: 6
        });
    }

    /**
     * Generate road network
     */
    private generateRoads(plan: BasePlan, room: Room): void {
        const sources = room.find(FIND_SOURCES);
        const controller = room.controller;
        const mineral = room.find(FIND_MINERALS)[0];

        // Find spawn position (first spawn in plan)
        const spawnPos = plan.structures.find(s => s.structureType === STRUCTURE_SPAWN);
        if (!spawnPos) return;

        const spawn = new RoomPosition(spawnPos.x, spawnPos.y, room.name);
        const roadSet = new Set<string>();

        // Roads to sources
        for (const source of sources) {
            this.addRoadPath(spawn, source.pos, roadSet, room.name);
        }

        // Road to controller
        if (controller) {
            this.addRoadPath(spawn, controller.pos, roadSet, room.name);
        }

        // Road to mineral
        if (mineral) {
            this.addRoadPath(spawn, mineral.pos, roadSet, room.name);
        }

        // Convert set to array
        for (const key of roadSet) {
            const [x, y] = key.split(",").map(Number);
            plan.roads.push({ x, y });
        }
    }

    /**
     * Add road path between two positions
     */
    private addRoadPath(from: RoomPosition, to: RoomPosition, roadSet: Set<string>, roomName: string): void {
        const path = PathFinder.search(from, { pos: to, range: 1 }, {
            plainCost: 2,
            swampCost: 3,
            roomCallback: () => {
                const matrix = new PathFinder.CostMatrix();
                const terrain = new Room.Terrain(roomName);

                for (let x = 0; x < 50; x++) {
                    for (let y = 0; y < 50; y++) {
                        if (terrain.get(x, y) === TERRAIN_MASK_WALL) {
                            matrix.set(x, y, 255);
                        } else if (roadSet.has(`${x},${y}`)) {
                            matrix.set(x, y, 1); // Prefer existing roads
                        }
                    }
                }

                return matrix;
            }
        });

        for (const pos of path.path) {
            if (pos.roomName === roomName) {
                roadSet.add(`${pos.x},${pos.y}`);
            }
        }
    }

    /**
     * Generate rampart perimeter
     */
    private generateRamparts(plan: BasePlan, anchor: { x: number; y: number }, dt: CostMatrix): void {
        // Create a minimal perimeter around the base
        const covered = new Set<string>();

        // Mark all structure positions
        for (const s of plan.structures) {
            covered.add(`${s.x},${s.y}`);
        }

        // Find perimeter positions (adjacent to structures but not structures)
        const perimeter: { x: number; y: number }[] = [];

        for (const s of plan.structures) {
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    const x = s.x + dx;
                    const y = s.y + dy;
                    const key = `${x},${y}`;

                    if (covered.has(key)) continue;
                    if (x < 2 || x > 47 || y < 2 || y > 47) continue;
                    if (dt.get(x, y) === 0) continue;

                    perimeter.push({ x, y });
                    covered.add(key);
                }
            }
        }

        // Also add ramparts on critical structures
        for (const s of plan.structures) {
            if (s.structureType === STRUCTURE_SPAWN ||
                s.structureType === STRUCTURE_STORAGE ||
                s.structureType === STRUCTURE_TERMINAL ||
                s.structureType === STRUCTURE_TOWER) {
                plan.ramparts.push({ x: s.x, y: s.y });
            }
        }

        // Add outer perimeter ramparts
        for (const pos of perimeter) {
            plan.ramparts.push(pos);
        }
    }

    /**
     * Find valid position for a stamp
     */
    private findStampPosition(
        anchor: { x: number; y: number },
        width: number,
        height: number,
        dt: CostMatrix,
        plan: BasePlan
    ): { x: number; y: number } | null {
        // Spiral outward from anchor
        for (let radius = 0; radius <= 10; radius++) {
            for (let dx = -radius; dx <= radius; dx++) {
                for (let dy = -radius; dy <= radius; dy++) {
                    if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;

                    const x = anchor.x + dx;
                    const y = anchor.y + dy;

                    if (this.canPlaceStamp(x, y, width, height, dt, plan)) {
                        return { x, y };
                    }
                }
            }
        }

        return null;
    }

    /**
     * Check if a stamp can be placed at position
     */
    private canPlaceStamp(
        x: number,
        y: number,
        width: number,
        height: number,
        dt: CostMatrix,
        plan: BasePlan
    ): boolean {
        for (let dx = 0; dx < width; dx++) {
            for (let dy = 0; dy < height; dy++) {
                const px = x + dx;
                const py = y + dy;

                if (px < 2 || px > 47 || py < 2 || py > 47) return false;
                if (dt.get(px, py) < 2) return false;

                // Check existing structures
                for (const s of plan.structures) {
                    if (s.x === px && s.y === py) return false;
                }
            }
        }

        return true;
    }

    /**
     * Check if position has adjacent structure
     */
    private hasAdjacentStructure(x: number, y: number, placed: Set<string>): boolean {
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;
                if (placed.has(`${x + dx},${y + dy}`)) return true;
            }
        }
        return false;
    }

    /**
     * Find adjacent buildable position
     */
    private findAdjacentPosition(pos: RoomPosition, plan: BasePlan): { x: number; y: number } | null {
        const terrain = new Room.Terrain(pos.roomName);
        const placed = new Set(plan.structures.map(s => `${s.x},${s.y}`));

        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;

                const x = pos.x + dx;
                const y = pos.y + dy;

                if (x < 2 || x > 47 || y < 2 || y > 47) continue;
                if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
                if (placed.has(`${x},${y}`)) continue;

                return { x, y };
            }
        }

        return null;
    }

    /**
     * Get structures to build for current RCL
     */
    getStructuresToBuild(roomName: string, rcl: number): PlannedStructure[] {
        const plan = this.getPlan(roomName);
        if (!plan) return [];

        return plan.structures.filter(s => s.minRCL <= rcl);
    }

    /**
     * Get roads to build
     */
    getRoadsToBuild(roomName: string): { x: number; y: number }[] {
        const plan = this.getPlan(roomName);
        if (!plan) return [];

        return plan.roads;
    }

    /**
     * Visualize the plan
     */
    visualizePlan(roomName: string): void {
        const plan = this.getPlan(roomName);
        if (!plan) return;

        const visual = new RoomVisual(roomName);

        // Draw structures
        for (const s of plan.structures) {
            let color = "#ffffff";
            if (s.structureType === STRUCTURE_SPAWN) color = "#ffff00";
            if (s.structureType === STRUCTURE_EXTENSION) color = "#ffaa00";
            if (s.structureType === STRUCTURE_TOWER) color = "#ff0000";
            if (s.structureType === STRUCTURE_STORAGE) color = "#00ff00";
            if (s.structureType === STRUCTURE_LAB) color = "#ff00ff";
            if (s.structureType === STRUCTURE_LINK) color = "#00ffff";

            visual.circle(s.x, s.y, { radius: 0.4, fill: color, opacity: 0.5 });
        }

        // Draw roads
        for (const road of plan.roads) {
            visual.circle(road.x, road.y, { radius: 0.2, fill: "#888888", opacity: 0.3 });
        }

        // Draw ramparts
        for (const rampart of plan.ramparts) {
            visual.rect(rampart.x - 0.5, rampart.y - 0.5, 1, 1, {
                fill: "#00ff00",
                opacity: 0.2,
                stroke: "#00ff00"
            });
        }

        // Draw anchor
        visual.circle(plan.anchor.x, plan.anchor.y, {
            radius: 0.6,
            fill: "transparent",
            stroke: "#ffffff",
            strokeWidth: 0.1
        });
    }
}

// Add memory interface
declare global {
    interface Memory {
        basePlans?: { [roomName: string]: BasePlan };
    }
}

// Singleton instance
const basePlannerInstance = new BasePlanner();

export const basePlannerModule = () => {
    // Only run every 100 ticks for visualization
    if (Game.time % 100 === 0) {
        for (const room of Object.values(Game.rooms)) {
            if (room.controller?.my) {
                basePlannerInstance.visualizePlan(room.name);
            }
        }
    }
};

export const basePlanner = basePlannerInstance;
