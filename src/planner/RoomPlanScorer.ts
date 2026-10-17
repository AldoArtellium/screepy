/**
 * Room plan score (higher is better): planned structures, upkeep, tower cover of the ramparts,
 * ramparts close to exits, and travel distances once the room is built.
 * Ported from Hivemind (MIT), src/room/planner/room-plan-scorer.ts and room-plan.ts
 * (createNavigationMatrix). Constants are spelled out so the planner runs outside the game.
 */

import { DistanceMatrix, chebyshev, idx } from "./matrices";
import { RoomPlan } from "./RoomPlan";

/** Structures at RCL 8 (CONTROLLER_STRUCTURES[type][8]) */
const RCL8_COUNT: { [type: string]: number } = {
    extension: 60,
    factory: 1,
    observer: 1,
    lab: 10,
    nuker: 1,
    extractor: 1,
    powerSpawn: 1,
    spawn: 3,
    terminal: 1,
    tower: 6,
    storage: 1,
    rampart: 2500,
    container: 5
};

const STRUCTURE_SCORE: [string, number][] = [
    ["extension", 0.01],
    ["factory", 0.01],
    ["observer", 0.01],
    ["lab", 0.02],
    ["nuker", 0.02],
    ["extractor", 0.05],
    ["powerSpawn", 0.05],
    ["spawn", 0.1],
    ["terminal", 0.2],
    ["tower", 0.2],
    ["storage", 1]
];

/** Planned types that block movement once built (OBSTACLE_OBJECT_TYPES among planned types) */
const OBSTACLES = ["spawn", "extension", "tower", "storage", "terminal", "factory", "link", "lab", "nuker", "powerSpawn", "observer", "extractor"];

export interface PlanScore {
    structures: number;
    maintenance: number;
    towers: number;
    defense: number;
    distance: number;
    total: number;
}

/** Sum without lodash: the planner also runs outside the game (tests/planner) */
function sum<T>(items: T[], f: (item: T) => number): number {
    return items.reduce((total, item) => total + f(item), 0);
}

function amount(plan: RoomPlan, type: string): number {
    return Math.min(plan.count(type), RCL8_COUNT[type] ?? 2500);
}

function towerEffect(a: { x: number; y: number }, b: { x: number; y: number }): number {
    const range = Math.min(Math.max(chebyshev(a.x, a.y, b.x, b.y) + 2, 5), 20);
    return 1 - (range - 5) / 15;
}

/** Roads 1 (tunnels through natural walls don't exist yet), harvest spots, bay centers and obstacles 255 */
function navigationMatrix(plan: RoomPlan, terrain: RoomTerrain): CostMatrix {
    const matrix = new PathFinder.CostMatrix();
    for (const type of plan.types()) {
        if (type !== "road" && type !== "harvester" && type !== "bay_center" && type !== "wall" && !OBSTACLES.includes(type)) continue;
        for (const pos of plan.getLocations(type)) {
            if (type === "road") {
                if (matrix.get(pos.x, pos.y) !== 0 || terrain.get(pos.x, pos.y) === TERRAIN_MASK_WALL) continue;
                matrix.set(pos.x, pos.y, 1);
            } else {
                matrix.set(pos.x, pos.y, 255);
            }
        }
    }
    return matrix;
}

export function scoreRoomPlan(
    plan: RoomPlan,
    input: { terrain: RoomTerrain; controller: { x: number; y: number }; minerals: { x: number; y: number }[] },
    exitDistance: DistanceMatrix
): PlanScore {
    const { terrain } = input;
    const structures = sum(STRUCTURE_SCORE, ([type, value]) => value * amount(plan, type));

    // RAMPART_DECAY_AMOUNT / RAMPART_DECAY_TIME = 3, CONTAINER_DECAY / CONTAINER_DECAY_TIME_OWNED = 10,
    // ROAD_DECAY_AMOUNT / ROAD_DECAY_TIME = 0.1, roads on swamps x5, on walls x150
    let maintenance = -0.001 * amount(plan, "rampart") * 3 - 0.001 * amount(plan, "container") * 10;
    for (const pos of plan.getLocations("road")) {
        let factor = 0.002;
        const t = terrain.get(pos.x, pos.y);
        if (t === TERRAIN_MASK_SWAMP) factor *= 5;
        if (t === TERRAIN_MASK_WALL) factor *= 150;
        maintenance -= factor * 0.1;
    }

    const ramparts = plan.getLocations("rampart");
    const towers = plan.getLocations("tower");
    let towerScore = 0;
    if (ramparts.length > 0 && towers.length > 0) {
        for (const r of ramparts) for (const t of towers) towerScore += towerEffect(t, r);
        towerScore = (0.2 * towerScore) / ramparts.length;
    }

    let defense = 0;
    for (const r of ramparts) {
        const d = exitDistance[idx(r.x, r.y)];
        if (d < 6) defense += (6 - d) * (6 - d);
    }
    defense = -0.003 * defense - 0.001 * amount(plan, "wall.quad");

    const matrix = navigationMatrix(plan, terrain);
    const pathLength = (from: RoomPosition, to: { pos: RoomPosition; range: number }[]): number => {
        if (to.length === 0) return 1000;
        const result = PathFinder.search(from, to, { roomCallback: () => matrix, plainCost: 2, swampCost: 10, maxRooms: 1 });
        return result.incomplete ? 1000 : result.path.length;
    };
    const spawnGoals = plan.getLocations("spawn").map(pos => ({ pos, range: 1 }));
    const center = plan.getLocations("center")[0] ?? plan.getLocations("storage")[0];
    const centerGoal = center ? [{ pos: center, range: 0 }] : [];
    const upgrader =
        plan.getLocations("container.controller")[0] ?? new RoomPosition(input.controller.x, input.controller.y, plan.roomName);
    const harvesters = plan.getLocations("harvester");
    let distance = 0;
    distance -= 0.003 * sum(harvesters, h => pathLength(h, spawnGoals));
    distance -= 0.002 * pathLength(upgrader, spawnGoals);
    for (const m of input.minerals) distance -= 0.001 * pathLength(new RoomPosition(m.x, m.y, plan.roomName), spawnGoals);
    distance -= 0.005 * sum(plan.getLocations("bay_center"), b => pathLength(b, centerGoal));
    distance -= 0.001 * sum(harvesters, h => pathLength(h, centerGoal));
    distance -= 0.01 * pathLength(upgrader, centerGoal);
    distance -= 0.001 * sum(plan.getLocations("lab"), l => pathLength(l, centerGoal));
    distance -= 0.001 * sum(towers, t => pathLength(t, centerGoal));

    const total = structures + maintenance + towerScore + defense + distance;
    return { structures, maintenance, towers: towerScore, defense, distance, total };
}
