/**
 * Planner matrices and map helpers
 *
 * Ported from Hivemind (MIT), src/room/planner/matrix-generator.ts, src/utils/map.ts
 * and src/utils/room-info.ts (exit centers).
 *
 * Distance matrices are Uint8Arrays indexed by `x + 50 * y`.
 */

/** Distance matrix: 255 on walls, 0 where unreachable, else Chebyshev distance (around walls) */
export type DistanceMatrix = Uint8Array;

export const idx = (x: number, y: number): number => x + 50 * y;

/**
 * Calls `callback` for every tile in the square of `range` around (x, y), clamped to the room,
 * dx outer then dy inner (Hivemind order, which drives tie-breaking). Stops when it returns false.
 */
export function forEachInArea(
    x: number,
    y: number,
    callback: (x: number, y: number) => boolean | void,
    range = 1
): void {
    for (let dx = -range; dx <= range; dx++) {
        const ax = x + dx;
        if (ax < 0 || ax >= 50) continue;
        for (let dy = -range; dy <= range; dy++) {
            const ay = y + dy;
            if (ay < 0 || ay >= 50) continue;
            if (callback(ax, ay) === false) return;
        }
    }
}

export const chebyshev = (x1: number, y1: number, x2: number, y2: number): number =>
    Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2));

/**
 * Wall and exit distance matrices.
 * wall: tiles next to a wall = 1, then BFS. exit: border tiles = 1, then BFS (walls = 255 in both).
 * Same values as Hivemind's iterative sweeps (each sweep is one BFS layer).
 */
export function generateDistanceMatrices(terrain: RoomTerrain): { wall: DistanceMatrix; exit: DistanceMatrix } {
    const wall = new Uint8Array(2500);
    const exit = new Uint8Array(2500);
    const isWall = new Uint8Array(2500);
    for (let y = 0; y < 50; y++) {
        for (let x = 0; x < 50; x++) {
            if (terrain.get(x, y) & TERRAIN_MASK_WALL) isWall[idx(x, y)] = 1;
        }
    }

    const wallQueue: number[] = [];
    const exitQueue: number[] = [];
    for (let y = 0; y < 50; y++) {
        for (let x = 0; x < 50; x++) {
            const i = idx(x, y);
            if (isWall[i]) {
                wall[i] = 255;
                exit[i] = 255;
                continue;
            }
            if (x === 0 || x === 49 || y === 0 || y === 49) {
                exit[i] = 1;
                exitQueue.push(i);
            }
            let nearWall = false;
            forEachInArea(x, y, (ax, ay) => {
                if (isWall[idx(ax, ay)]) {
                    nearWall = true;
                    return false;
                }
                return true;
            });
            if (nearWall) {
                wall[i] = 1;
                wallQueue.push(i);
            }
        }
    }

    propagate(wall, wallQueue);
    propagate(exit, exitQueue);
    return { wall, exit };
}

/** BFS from the seeded tiles over tiles still at 0 */
function propagate(matrix: DistanceMatrix, queue: number[]): void {
    for (let head = 0; head < queue.length; head++) {
        const i = queue[head];
        const d = matrix[i];
        if (d >= 254) continue;
        forEachInArea(i % 50, Math.floor(i / 50), (ax, ay) => {
            const j = idx(ax, ay);
            if (matrix[j] !== 0) return;
            matrix[j] = d + 1;
            queue.push(j);
        });
    }
}

/** Middle of every contiguous run of non-wall border tiles (i in 1..48), per side */
export function getExitCenters(terrain: RoomTerrain): { x: number; y: number }[] {
    const sides: { x: number; y: number }[][] = [[], [], [], []];
    for (let i = 1; i < 49; i++) {
        if (!(terrain.get(0, i) & TERRAIN_MASK_WALL)) sides[2].push({ x: 0, y: i });
        if (!(terrain.get(49, i) & TERRAIN_MASK_WALL)) sides[3].push({ x: 49, y: i });
        if (!(terrain.get(i, 0) & TERRAIN_MASK_WALL)) sides[0].push({ x: i, y: 0 });
        if (!(terrain.get(i, 49) & TERRAIN_MASK_WALL)) sides[1].push({ x: i, y: 49 });
    }

    // Hivemind order: N, S, W, E
    const centers: { x: number; y: number }[] = [];
    for (const coords of sides) {
        let start: { x: number; y: number } | null = null;
        let previous: { x: number; y: number } | null = null;
        for (const pos of coords) {
            if (!start) start = pos;
            if (previous && chebyshev(pos.x, pos.y, previous.x, previous.y) > 1) {
                centers.push({ x: Math.ceil((previous.x + start.x) / 2), y: Math.ceil((previous.y + start.y) / 2) });
                start = pos;
            }
            previous = pos;
        }
        if (start && previous) {
            centers.push({ x: Math.ceil((previous.x + start.x) / 2), y: Math.ceil((previous.y + start.y) / 2) });
        }
    }
    return centers;
}
