/**
 * Structures drawn the way the game draws them, ported from screepers/RoomVisual
 * (https://github.com/screepers/RoomVisual, src/structure.ts and src/roads.ts, MIT, see
 * THIRD_PARTY_NOTICES.md). Plain functions instead of RoomVisual prototype methods; roads are drawn
 * as merged runs instead of one line per pair of tiles.
 */

type Point = [number, number];

const COLORS = {
    gray: "#555555",
    light: "#AAAAAA",
    road: "#666666",
    energy: "#FFE87B",
    power: "#F53547",
    dark: "#181818",
    outline: "#8FBB93"
};

/** The renderer treats a falsy stroke / fill as "off", the typings only allow strings */
const OFF = false as unknown as string;

function relPoly(x: number, y: number, poly: Point[]): Point[] {
    return poly.map(([px, py]): Point => [px + x, py + y]);
}

function closed(poly: Point[]): Point[] {
    return poly.length > 0 ? [...poly, poly[0]] : poly;
}

function factoryLevelGaps(): Point[] {
    let x = -0.08;
    let y = -0.52;
    const result: Point[] = [];
    const gapAngle = 16 * (Math.PI / 180);
    const c1 = Math.cos(gapAngle);
    const s1 = Math.sin(gapAngle);
    const angle = 72 * (Math.PI / 180);
    const c2 = Math.cos(angle);
    const s2 = Math.sin(angle);
    for (let i = 0; i < 5; ++i) {
        result.push([0.0, 0.0]);
        result.push([x, y]);
        result.push([x * c1 - y * s1, x * s1 + y * c1]);
        const nextX = x * c2 - y * s2;
        y = x * s2 + y * c2;
        x = nextX;
    }
    return result;
}

const FACTORY_OUTLINE: Point[] = [
    [-0.68, -0.11], [-0.84, -0.18], [-0.84, -0.32], [-0.44, -0.44], [-0.32, -0.84], [-0.18, -0.84], [-0.11, -0.68],
    [0.11, -0.68], [0.18, -0.84], [0.32, -0.84], [0.44, -0.44], [0.84, -0.32], [0.84, -0.18], [0.68, -0.11],
    [0.68, 0.11], [0.84, 0.18], [0.84, 0.32], [0.44, 0.44], [0.32, 0.84], [0.18, 0.84], [0.11, 0.68],
    [-0.11, 0.68], [-0.18, 0.84], [-0.32, 0.84], [-0.44, 0.44], [-0.84, 0.32], [-0.84, 0.18], [-0.68, 0.11]
];
const FACTORY_SPIKES: Point[] = [
    [-0.4, -0.1], [-0.8, -0.2], [-0.8, -0.3], [-0.4, -0.4], [-0.3, -0.8], [-0.2, -0.8], [-0.1, -0.4],
    [0.1, -0.4], [0.2, -0.8], [0.3, -0.8], [0.4, -0.4], [0.8, -0.3], [0.8, -0.2], [0.4, -0.1],
    [0.4, 0.1], [0.8, 0.2], [0.8, 0.3], [0.4, 0.4], [0.3, 0.8], [0.2, 0.8], [0.1, 0.4],
    [-0.1, 0.4], [-0.2, 0.8], [-0.3, 0.8], [-0.4, 0.4], [-0.8, 0.3], [-0.8, 0.2], [-0.4, 0.1]
];
const FACTORY_LEVEL_GAPS = factoryLevelGaps();
const LINK_OUTER: Point[] = [[0.0, -0.5], [0.4, 0.0], [0.0, 0.5], [-0.4, 0.0]];
const LINK_INNER: Point[] = [[0.0, -0.3], [0.25, 0.0], [0.0, 0.3], [-0.25, 0.0]];
const TERMINAL_OUTER: Point[] = [
    [0.0, -0.8], [0.55, -0.55], [0.8, 0.0], [0.55, 0.55], [0.0, 0.8], [-0.55, 0.55], [-0.8, 0.0], [-0.55, -0.55]
];
const TERMINAL_INNER: Point[] = [
    [0.0, -0.65], [0.45, -0.45], [0.65, 0.0], [0.45, 0.45], [0.0, 0.65], [-0.45, 0.45], [-0.65, 0.0], [-0.45, -0.45]
];
const LAB_BOX: Point[] = [[-0.45, 0.3], [-0.45, 0.55], [0.45, 0.55], [0.45, 0.3]];
const STORAGE_OUTLINE: Point[] = [
    [-0.45, -0.55], [0, -0.65], [0.45, -0.55], [0.55, 0], [0.45, 0.55], [0, 0.65], [-0.45, 0.55], [-0.55, 0], [-0.45, -0.55]
];
const NUKER_OUTLINE: Point[] = [[0, -1], [-0.47, 0.2], [-0.5, 0.5], [0.5, 0.5], [0.47, 0.2], [0, -1]];
const NUKER_INLINE: Point[] = [[0, -0.8], [-0.4, 0.2], [0.4, 0.2], [0, -0.8]];

/** Draws a structure of `type` (not a road: see drawRoads) at x, y */
export function drawStructure(visual: RoomVisual, x: number, y: number, type: StructureConstant, opacity = 1): void {
    switch (type) {
        case STRUCTURE_FACTORY:
            visual.poly(relPoly(x, y, FACTORY_OUTLINE), { fill: OFF, stroke: COLORS.outline, strokeWidth: 0.05, opacity });
            visual.circle(x, y, { radius: 0.65, fill: "#232323", strokeWidth: 0.035, stroke: "#140a0a", opacity });
            visual.poly(relPoly(x, y, FACTORY_SPIKES), { fill: COLORS.gray, stroke: "#140a0a", strokeWidth: 0.04, opacity });
            visual.circle(x, y, { radius: 0.54, fill: "#302a2a", strokeWidth: 0.04, stroke: "#140a0a", opacity });
            visual.poly(relPoly(x, y, FACTORY_LEVEL_GAPS), { fill: "#140a0a", stroke: OFF, opacity });
            visual.circle(x, y, { radius: 0.42, fill: "#140a0a", opacity });
            visual.rect(x - 0.24, y - 0.24, 0.48, 0.48, { fill: "#3f3f3f", opacity });
            break;
        case STRUCTURE_EXTENSION:
            visual.circle(x, y, { radius: 0.5, fill: COLORS.dark, stroke: COLORS.outline, strokeWidth: 0.05, opacity });
            visual.circle(x, y, { radius: 0.35, fill: COLORS.gray, opacity });
            break;
        case STRUCTURE_SPAWN:
            visual.circle(x, y, { radius: 0.65, fill: COLORS.dark, stroke: "#CCCCCC", strokeWidth: 0.1, opacity });
            visual.circle(x, y, { radius: 0.4, fill: COLORS.energy, opacity });
            break;
        case STRUCTURE_POWER_SPAWN:
            visual.circle(x, y, { radius: 0.65, fill: COLORS.dark, stroke: COLORS.power, strokeWidth: 0.1, opacity });
            visual.circle(x, y, { radius: 0.4, fill: COLORS.energy, opacity });
            break;
        case STRUCTURE_LINK:
            visual.poly(closed(relPoly(x, y, LINK_OUTER)), { fill: COLORS.dark, stroke: COLORS.outline, strokeWidth: 0.05, opacity });
            visual.poly(closed(relPoly(x, y, LINK_INNER)), { fill: COLORS.gray, stroke: OFF, opacity });
            break;
        case STRUCTURE_TERMINAL:
            visual.poly(closed(relPoly(x, y, TERMINAL_OUTER)), { fill: COLORS.dark, stroke: COLORS.outline, strokeWidth: 0.05, opacity });
            visual.poly(closed(relPoly(x, y, TERMINAL_INNER)), { fill: COLORS.light, stroke: OFF, opacity });
            visual.rect(x - 0.45, y - 0.45, 0.9, 0.9, { fill: COLORS.gray, stroke: COLORS.dark, strokeWidth: 0.1, opacity });
            break;
        case STRUCTURE_LAB:
            visual.circle(x, y - 0.025, { radius: 0.55, fill: COLORS.dark, stroke: COLORS.outline, strokeWidth: 0.05, opacity });
            visual.circle(x, y - 0.025, { radius: 0.4, fill: COLORS.gray, opacity });
            visual.rect(x - 0.45, y + 0.3, 0.9, 0.25, { fill: COLORS.dark, stroke: OFF, opacity });
            visual.poly(relPoly(x, y, LAB_BOX), { stroke: COLORS.outline, strokeWidth: 0.05, opacity });
            break;
        case STRUCTURE_TOWER:
            visual.circle(x, y, { radius: 0.6, fill: COLORS.dark, stroke: COLORS.outline, strokeWidth: 0.05, opacity });
            visual.rect(x - 0.4, y - 0.3, 0.8, 0.6, { fill: COLORS.gray, opacity });
            visual.rect(x - 0.2, y - 0.9, 0.4, 0.5, { fill: COLORS.light, stroke: COLORS.dark, strokeWidth: 0.07, opacity });
            break;
        case STRUCTURE_RAMPART:
            visual.circle(x, y, { radius: 0.65, fill: "#434C43", stroke: "#5D735F", strokeWidth: 0.1, opacity });
            break;
        case STRUCTURE_WALL:
            visual.circle(x, y, { radius: 0.4, fill: COLORS.dark, stroke: COLORS.light, strokeWidth: 0.05, opacity });
            break;
        case STRUCTURE_STORAGE:
            visual.poly(relPoly(x, y, STORAGE_OUTLINE), { stroke: COLORS.outline, strokeWidth: 0.05, fill: COLORS.dark, opacity });
            visual.rect(x - 0.35, y - 0.45, 0.7, 0.9, { fill: COLORS.energy, opacity });
            break;
        case STRUCTURE_OBSERVER:
            visual.circle(x, y, { fill: COLORS.dark, radius: 0.45, stroke: COLORS.outline, strokeWidth: 0.05, opacity });
            visual.circle(x + 0.225, y, { fill: COLORS.outline, radius: 0.2, opacity });
            break;
        case STRUCTURE_NUKER:
            visual.poly(relPoly(x, y, NUKER_OUTLINE), { stroke: COLORS.outline, strokeWidth: 0.05, fill: COLORS.dark, opacity });
            visual.poly(relPoly(x, y, NUKER_INLINE), { stroke: COLORS.outline, strokeWidth: 0.01, fill: COLORS.gray, opacity });
            break;
        case STRUCTURE_CONTAINER:
            visual.rect(x - 0.225, y - 0.3, 0.45, 0.6, { fill: COLORS.gray, opacity, stroke: COLORS.dark, strokeWidth: 0.09 });
            visual.rect(x - 0.17, y + 0.07, 0.34, 0.2, { fill: COLORS.energy, opacity });
            break;
        case STRUCTURE_EXTRACTOR:
            // Not in screepers/RoomVisual: a ring around the mineral
            visual.circle(x, y, { radius: 0.6, fill: OFF, stroke: COLORS.outline, strokeWidth: 0.1, opacity });
            break;
        default:
            visual.circle(x, y, { fill: COLORS.light, radius: 0.35, stroke: COLORS.dark, strokeWidth: 0.2, opacity });
            break;
    }
}

/** Half of the 8 neighbours: every pair of tiles is visited from one side */
const ROAD_DIRS: Point[] = [
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1]
];

/**
 * Draws the roads of `tiles` the way the game connects them, also into the adjacent `joined` tiles
 * (built roads), as one line per straight run of tiles; a tile connected to nothing gets a dot.
 * `style` overrides the game look (planned roads use their own tint so they don't pass for built ones).
 */
export function drawRoads(visual: RoomVisual, tiles: Point[], joined: Point[] = [], opacity = 1, style?: LineStyle): void {
    const road = new Uint8Array(2500);
    const other = new Uint8Array(2500);
    const inBounds = (x: number, y: number): boolean => x >= 0 && x < 50 && y >= 0 && y < 50;
    const isRoad = (x: number, y: number): boolean => inBounds(x, y) && road[x + 50 * y] === 1;
    const isJoined = (x: number, y: number): boolean => inBounds(x, y) && other[x + 50 * y] === 1;
    for (const [x, y] of tiles) road[x + 50 * y] = 1;
    for (const [x, y] of joined) other[x + 50 * y] = 1;

    const lineStyle: LineStyle = { color: COLORS.road, width: 0.35, opacity, ...style };
    const dotColor = lineStyle.color ?? COLORS.road;
    const dotRadius = (lineStyle.width ?? 0.35) / 2;
    const connected = new Uint8Array(2500);
    for (const [dx, dy] of ROAD_DIRS) {
        for (const [x, y] of tiles) {
            // A run starts on a tile whose predecessor in this direction is not a planned road
            if (isRoad(x - dx, y - dy)) continue;
            let endX = x;
            let endY = y;
            while (isRoad(endX + dx, endY + dy)) {
                endX += dx;
                endY += dy;
            }
            let startX = x;
            let startY = y;
            if (isJoined(startX - dx, startY - dy)) {
                startX -= dx;
                startY -= dy;
            }
            if (isJoined(endX + dx, endY + dy)) {
                endX += dx;
                endY += dy;
            }
            if (startX === endX && startY === endY) continue;
            for (let cx = x, cy = y; isRoad(cx, cy); cx += dx, cy += dy) connected[cx + 50 * cy] = 1;
            visual.line(startX, startY, endX, endY, lineStyle);
        }
    }
    for (const [x, y] of tiles) {
        if (!connected[x + 50 * y]) visual.circle(x, y, { radius: dotRadius, fill: dotColor, stroke: OFF, opacity: lineStyle.opacity });
    }
}
