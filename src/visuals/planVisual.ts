/**
 * Planned structures not built yet (faded, drawn like the game's structures, `structures.ts`) and
 * the outline of the planner's safe area. Drawn on a RoomVisual; the caller caches the export.
 */

import { RoomPlan } from "../planner/RoomPlan";
import { drawRoads, drawStructure } from "./structures";

const OPACITY = 0.3;
/** Planned roads: blue-grey, thin and dashed, so they never pass for built roads */
const PLANNED_ROAD: LineStyle = { color: "#6f8fb0", width: 0.2, opacity: 0.5, lineStyle: "dashed" };
/** Planned ramparts: outline only, the quietest layer on top */
const PLANNED_RAMPART: CircleStyle = { radius: 0.6, fill: "transparent", stroke: "#5fbf6f", strokeWidth: 0.06, opacity: 0.35 };

/** Drawing order after the roads; ramparts are drawn last, on top, as in the game */
const TYPES: StructureConstant[] = [
    STRUCTURE_CONTAINER,
    STRUCTURE_EXTENSION,
    STRUCTURE_SPAWN,
    STRUCTURE_TOWER,
    STRUCTURE_STORAGE,
    STRUCTURE_TERMINAL,
    STRUCTURE_FACTORY,
    STRUCTURE_LINK,
    STRUCTURE_LAB,
    STRUCTURE_EXTRACTOR,
    STRUCTURE_POWER_SPAWN,
    STRUCTURE_NUKER,
    STRUCTURE_OBSERVER
];

const SAFE_STYLE: LineStyle = { color: "#4dd0ff", width: 0.06, opacity: 0.35, lineStyle: "dashed" };

/** Draws the unbuilt part of the plan */
export function drawPlan(visual: RoomVisual, room: Room, plan: RoomPlan): void {
    const built = new Set<string>();
    const builtRoads: [number, number][] = [];
    for (const structure of room.find(FIND_STRUCTURES)) {
        built.add(`${structure.structureType}:${structure.pos.x + 50 * structure.pos.y}`);
        if (structure.structureType === STRUCTURE_ROAD) builtRoads.push([structure.pos.x, structure.pos.y]);
    }
    const unbuilt = (type: StructureConstant): RoomPosition[] =>
        plan.count(type) === 0 ? [] : plan.getLocations(type).filter(pos => !built.has(`${type}:${pos.x + 50 * pos.y}`));

    // Planned roads joined to the built ones next to them, so a road under construction reads as one
    const roads = unbuilt(STRUCTURE_ROAD).map((pos): [number, number] => [pos.x, pos.y]);
    drawRoads(visual, roads, builtRoads, OPACITY, PLANNED_ROAD);
    for (const type of TYPES) {
        for (const pos of unbuilt(type)) drawStructure(visual, pos.x, pos.y, type, OPACITY);
    }
    for (const pos of unbuilt(STRUCTURE_RAMPART)) visual.circle(pos.x, pos.y, PLANNED_RAMPART);
    drawSafeOutline(visual, plan);
}

/** Border of the safe area, as merged horizontal and vertical runs of tile edges */
function drawSafeOutline(visual: RoomVisual, plan: RoomPlan): void {
    if (plan.count("safe") === 0) return;
    const safe = new Uint8Array(2500);
    for (const pos of plan.getLocations("safe")) safe[pos.x + 50 * pos.y] = 1;
    const isSafe = (x: number, y: number): boolean => x >= 0 && x < 50 && y >= 0 && y < 50 && safe[x + 50 * y] === 1;

    for (const side of [-1, 1]) {
        // Horizontal edges (above / below each row)
        for (let y = 0; y < 50; y++) {
            let start = -1;
            for (let x = 0; x <= 50; x++) {
                const edge = x < 50 && isSafe(x, y) && !isSafe(x, y + side);
                if (edge && start < 0) start = x;
                if (!edge && start >= 0) {
                    visual.line(start - 0.5, y + side / 2, x - 0.5, y + side / 2, SAFE_STYLE);
                    start = -1;
                }
            }
        }
        // Vertical edges (left / right of each column)
        for (let x = 0; x < 50; x++) {
            let start = -1;
            for (let y = 0; y <= 50; y++) {
                const edge = y < 50 && isSafe(x, y) && !isSafe(x + side, y);
                if (edge && start < 0) start = y;
                if (!edge && start >= 0) {
                    visual.line(x + side / 2, start - 0.5, x + side / 2, y - 0.5, SAFE_STYLE);
                    start = -1;
                }
            }
        }
    }
}
