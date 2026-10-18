/**
 * Planned structures not built yet (faded shapes, one per structure type) and the outline of the
 * planner's safe area. Drawn on a RoomVisual; the caller caches the export.
 */

import { RoomPlan } from "../planner/RoomPlan";

const OPACITY = 0.2;

type Shape = (visual: RoomVisual, x: number, y: number) => void;

const circle =
    (radius: number, fill: string, stroke?: string): Shape =>
    (visual, x, y) =>
        visual.circle(x, y, { radius, fill, stroke, strokeWidth: 0.08, opacity: OPACITY });

const square =
    (size: number, fill: string, stroke?: string): Shape =>
    (visual, x, y) =>
        visual.rect(x - size / 2, y - size / 2, size, size, { fill, stroke, strokeWidth: 0.08, opacity: OPACITY });

const diamond =
    (size: number, fill: string): Shape =>
    (visual, x, y) =>
        visual.poly(
            [
                [x, y - size],
                [x + size, y],
                [x, y + size],
                [x - size, y],
                [x, y - size]
            ],
            { fill, stroke: fill, opacity: OPACITY }
        );

/** Drawing order: roads under everything, ramparts on top */
const SHAPES: [StructureConstant, Shape][] = [
    [STRUCTURE_ROAD, circle(0.15, "#aaaaaa")],
    [STRUCTURE_CONTAINER, square(0.6, "#b97a3c", "#6b4a2a")],
    [STRUCTURE_EXTENSION, circle(0.3, "#ffe56d", "#7a6a2a")],
    [STRUCTURE_SPAWN, circle(0.6, "#ffe56d", "#ffffff")],
    [STRUCTURE_TOWER, circle(0.45, "#e05050", "#ffffff")],
    [STRUCTURE_STORAGE, square(0.9, "#f5a623", "#ffffff")],
    [STRUCTURE_TERMINAL, diamond(0.55, "#bbbbbb")],
    [STRUCTURE_FACTORY, square(0.8, "#c8a0ff", "#ffffff")],
    [STRUCTURE_LINK, diamond(0.35, "#8cc8ff")],
    [STRUCTURE_LAB, circle(0.4, "#5bd65b", "#ffffff")],
    [STRUCTURE_EXTRACTOR, circle(0.6, "transparent", "#ff8800")],
    [STRUCTURE_POWER_SPAWN, circle(0.55, "#ff3c3c", "#ffffff")],
    [STRUCTURE_NUKER, square(0.8, "#555555", "#ff3c3c")],
    [STRUCTURE_OBSERVER, circle(0.3, "#8cc8ff", "#ffffff")],
    [STRUCTURE_RAMPART, square(0.95, "transparent", "#43c443")]
];

const SAFE_STYLE: LineStyle = { color: "#4dd0ff", width: 0.06, opacity: 0.35, lineStyle: "dashed" };

/** Draws the unbuilt part of the plan */
export function drawPlan(visual: RoomVisual, room: Room, plan: RoomPlan): void {
    const built = new Set<string>();
    for (const structure of room.find(FIND_STRUCTURES)) {
        built.add(`${structure.structureType}:${structure.pos.x + 50 * structure.pos.y}`);
    }
    for (const [type, shape] of SHAPES) {
        if (plan.count(type) === 0) continue;
        for (const pos of plan.getLocations(type)) {
            if (built.has(`${type}:${pos.x + 50 * pos.y}`)) continue;
            shape(visual, pos.x, pos.y);
        }
    }
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
