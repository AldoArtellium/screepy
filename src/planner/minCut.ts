/**
 * Min-cut of a room: the smallest set of tiles separating protected areas from the exits, where the
 * planner puts ramparts. Dinic max-flow on a graph with two vertices per tile (capacity 1 between
 * them, so each tile is cut at most once).
 * Ported from Hivemind (MIT), src/utils/mincut.ts (code by Saruss, adapted by Chobobobo and
 * Mirroar). Changes: terrain passed in (runs outside the game), queues with a head index instead
 * of splice(0, 1).
 */

export interface MinCutRect {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    protectTopExits?: boolean;
    protectBottomExits?: boolean;
    protectLeftExits?: boolean;
    protectRightExits?: boolean;
}

const UNWALKABLE = -1;
const NORMAL = 0;
const PROTECTED = 1;
const TO_EXIT = 2;
const EXIT = 3;

const INFINITY = Number.MAX_VALUE;
const SURROUNDING: [number, number][] = [
    [0, -1],
    [-1, -1],
    [-1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
    [1, 0],
    [1, -1]
];
const ROOM_CORNERS: [number, number][][] = [
    [
        [1, 1],
        [1, 2],
        [2, 1]
    ],
    [
        [48, 1],
        [48, 2],
        [47, 1]
    ],
    [
        [1, 48],
        [1, 47],
        [2, 48]
    ],
    [
        [48, 48],
        [48, 47],
        [47, 48]
    ]
];

/** roomArray[x][y]: tile kinds; tiles next to an exit are sinks (no rampart can be built there) */
function terrainArray(terrain: RoomTerrain, bounds: MinCutRect = { x1: 0, y1: 0, x2: 49, y2: 49 }): number[][] {
    const room: number[][] = Array.from({ length: 50 }, () => new Array<number>(50).fill(UNWALKABLE));
    for (let x = bounds.x1; x <= bounds.x2; x++) {
        for (let y = bounds.y1; y <= bounds.y2; y++) {
            if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
            room[x][y] = x === 0 || y === 0 || x === 49 || y === 49 ? EXIT : NORMAL;
        }
    }
    for (let y = 1; y < 49; y++) {
        if (room[0][y - 1] === EXIT || room[0][y] === EXIT || room[0][y + 1] === EXIT) room[1][y] = TO_EXIT;
        if (room[49][y - 1] === EXIT || room[49][y] === EXIT || room[49][y + 1] === EXIT) room[48][y] = TO_EXIT;
    }
    for (let x = 1; x < 49; x++) {
        if (room[x - 1][0] === EXIT || room[x][0] === EXIT || room[x + 1][0] === EXIT) room[x][1] = TO_EXIT;
        if (room[x - 1][49] === EXIT || room[x][49] === EXIT || room[x + 1][49] === EXIT) room[x][48] = TO_EXIT;
    }

    const protectedExitTiles = new Set<number>();
    const protectExitTile = (x: number, y: number): void => {
        if (room[x][y] !== TO_EXIT) return;
        room[x][y] = PROTECTED;
        protectedExitTiles.add(x + 50 * y);
        for (const [dx, dy] of SURROUNDING) if (room[x + dx][y + dy] === NORMAL) room[x + dx][y + dy] = PROTECTED;
    };
    for (let i = 1; i < 49; i++) {
        if (bounds.protectTopExits) protectExitTile(i, 1);
        if (bounds.protectBottomExits) protectExitTile(i, 48);
        if (bounds.protectLeftExits) protectExitTile(1, i);
        if (bounds.protectRightExits) protectExitTile(48, i);
    }

    // Corners where a protected exit meets an unprotected one can't be walled: unprotect them
    for (const corner of ROOM_CORNERS) {
        const hasProtected = corner.some(([x, y]) => room[x][y] === PROTECTED);
        const hasForbidden = corner.some(([x, y]) => room[x][y] === TO_EXIT);
        if (!hasProtected || !hasForbidden) continue;
        const queue = corner.filter(([x, y]) => room[x][y] === PROTECTED);
        for (let head = 0; head < queue.length; head++) {
            const [x, y] = queue[head];
            if (room[x][y] !== PROTECTED) continue;
            room[x][y] = protectedExitTiles.has(x + 50 * y) ? TO_EXIT : NORMAL;
            for (const [dx, dy] of SURROUNDING) if (room[x + dx][y + dy] === PROTECTED) queue.push([x + dx, y + dy]);
        }
    }

    for (let i = 1; i < 49; i++) {
        room[0][i] = UNWALKABLE;
        room[49][i] = UNWALKABLE;
        room[i][0] = UNWALKABLE;
        room[i][49] = UNWALKABLE;
    }
    return room;
}

interface Edge {
    v: number;
    /** Index of the reverse edge in edges[v] */
    r: number;
    c: number;
    f: number;
    u?: number;
}

class Graph {
    readonly level: number[];
    readonly edges: Edge[][];

    constructor(readonly v: number) {
        this.level = new Array<number>(v);
        this.edges = Array.from({ length: v }, () => []);
    }

    addEdge(u: number, v: number, c: number): void {
        this.edges[u].push({ v, r: this.edges[v].length, c, f: 0 });
        this.edges[v].push({ v: u, r: this.edges[u].length - 1, c: 0, f: 0 });
    }

    /** Level graph by BFS; true when t is reachable from s */
    pathExistsBetween(s: number, t: number): boolean {
        this.level.fill(-1);
        this.level[s] = 0;
        const queue = [s];
        for (let head = 0; head < queue.length; head++) {
            const u = queue[head];
            for (const edge of this.edges[u]) {
                if (this.level[edge.v] < 0 && edge.f < edge.c) {
                    this.level[edge.v] = this.level[u] + 1;
                    queue.push(edge.v);
                }
            }
        }
        return this.level[t] >= 0;
    }

    /** Sends flow along level-increasing edges (DFS); c[u] = edges of u explored so far */
    accumulateFlow(u: number, f: number, t: number, c: number[]): number {
        if (u === t) return f;
        while (c[u] < this.edges[u].length) {
            const edge = this.edges[u][c[u]];
            if (this.level[edge.v] === this.level[u] + 1 && edge.f < edge.c) {
                const flow = this.accumulateFlow(edge.v, Math.min(f, edge.c - edge.f), t, c);
                if (flow > 0) {
                    edge.f += flow;
                    this.edges[edge.v][edge.r].f -= flow;
                    return flow;
                }
            }
            c[u]++;
        }
        return 0;
    }

    /** Saturated edges from the vertices reachable from s to the unreachable ones: their tiles */
    markReachableVertices(s: number): number[] {
        const cutEdges: Edge[] = [];
        this.level.fill(-1);
        this.level[s] = 1;
        const queue = [s];
        for (let head = 0; head < queue.length; head++) {
            const u = queue[head];
            for (const edge of this.edges[u]) {
                if (edge.f < edge.c && this.level[edge.v] < 1) {
                    this.level[edge.v] = 1;
                    queue.push(edge.v);
                }
                if (edge.f === edge.c && edge.c > 0) {
                    edge.u = u;
                    cutEdges.push(edge);
                }
            }
        }
        return cutEdges.filter(e => this.level[e.v] === -1).map(e => e.u!);
    }

    calculateMinCut(s: number, t: number): number {
        let total = 0;
        while (this.pathExistsBetween(s, t)) {
            const count = new Array<number>(this.v + 1).fill(0);
            let flow: number;
            do {
                flow = this.accumulateFlow(s, INFINITY, t, count);
                total += flow;
            } while (flow);
        }
        return total;
    }
}

const SOURCE = 2 * 50 * 50;
const SINK = 2 * 50 * 50 + 1;

function createGraph(terrain: RoomTerrain, rects: MinCutRect[], bounds: MinCutRect): Graph | null {
    const room = terrainArray(terrain, bounds);
    if (bounds.x1 >= bounds.x2 || bounds.y1 >= bounds.y2 || bounds.x1 < 0 || bounds.y1 < 0 || bounds.x2 > 49 || bounds.y2 > 49) {
        return null;
    }
    // Rectangle borders are the source (protected), their inside is left out
    for (const r of rects) {
        if (r.x1 > r.x2 || r.y1 > r.y2) continue;
        if (r.x1 < bounds.x1 || r.x2 > bounds.x2 || r.y1 < bounds.y1 || r.y2 > bounds.y2) continue;
        for (let x = r.x1; x <= r.x2; x++) {
            for (let y = r.y1; y <= r.y2; y++) {
                if (x === r.x1 || x === r.x2 || y === r.y1 || y === r.y2) {
                    if (room[x][y] === NORMAL) room[x][y] = PROTECTED;
                } else {
                    room[x][y] = UNWALKABLE;
                }
            }
        }
    }

    // Top vertex = y * 50 + x, bottom vertex = top + 2500
    const graph = new Graph(2 * 50 * 50 + 2);
    for (let x = 1; x < 49; x++) {
        for (let y = 1; y < 49; y++) {
            const top = y * 50 + x;
            const bottom = top + 2500;
            const kind = room[x][y];
            if (kind === NORMAL || kind === PROTECTED) {
                if (kind === PROTECTED) graph.addEdge(SOURCE, top, INFINITY);
                graph.addEdge(top, bottom, 1);
                for (const [dx, dy] of SURROUNDING) {
                    const other = room[x + dx][y + dy];
                    if (other === NORMAL || other === TO_EXIT) graph.addEdge(bottom, (y + dy) * 50 + x + dx, INFINITY);
                }
            } else if (kind === TO_EXIT) {
                graph.addEdge(top, SINK, INFINITY);
            }
        }
    }
    return graph;
}

/** With bounds smaller than the room, drops cut tiles that don't lead to an exit */
function deleteTilesLeadingToDeadEnds(terrain: RoomTerrain, cut: { x: number; y: number }[]): void {
    const room = terrainArray(terrain);
    for (const tile of cut) room[tile.x][tile.y] = UNWALKABLE;
    const open: number[] = [];
    for (let y = 0; y < 49; y++) {
        if (room[1][y] === TO_EXIT) open.push(50 * y + 1);
        if (room[48][y] === TO_EXIT) open.push(50 * y + 48);
    }
    for (let x = 0; x < 49; x++) {
        if (room[x][1] === TO_EXIT) open.push(50 + x);
        if (room[x][48] === TO_EXIT) open.push(50 * 48 + x);
    }
    while (open.length > 0) {
        const index = open.pop()!;
        const x = index % 50;
        const y = Math.floor(index / 50);
        for (const [dx, dy] of SURROUNDING) {
            if (room[x + dx][y + dy] !== NORMAL) continue;
            open.push(50 * (y + dy) + x + dx);
            room[x + dx][y + dy] = TO_EXIT;
        }
    }
    for (let i = cut.length - 1; i >= 0; i--) {
        const { x, y } = cut[i];
        if (!SURROUNDING.some(([dx, dy]) => room[x + dx][y + dy] === TO_EXIT)) cut.splice(i, 1);
    }
}

/** Tiles of the min cut between the protected rectangles and the exits */
export function getCutTiles(
    terrain: RoomTerrain,
    rects: MinCutRect[],
    bounds: MinCutRect = { x1: 0, y1: 0, x2: 49, y2: 49 }
): { x: number; y: number }[] {
    const graph = createGraph(terrain, rects, bounds);
    if (!graph) return [];
    const positions: { x: number; y: number }[] = [];
    if (graph.calculateMinCut(SOURCE, SINK) > 0) {
        for (const vertex of graph.markReachableVertices(SOURCE)) positions.push({ x: vertex % 50, y: Math.floor(vertex / 50) });
    }
    const isWholeRoom = bounds.x1 === 0 && bounds.y1 === 0 && bounds.x2 === 49 && bounds.y2 === 49;
    if (positions.length > 0 && !isWholeRoom) deleteTilesLeadingToDeadEnds(terrain, positions);
    return positions;
}
