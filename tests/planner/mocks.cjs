/**
 * Minimal Screeps globals for running the room planner outside the game:
 * RoomPosition, PathFinder (weighted A*, 8 directions, cost matrices, maxOps), constants, Game, Memory.
 * Paths are close to the native PathFinder but tie-breaking can differ.
 */

const TERRAIN_MASK_WALL = 1;
const TERRAIN_MASK_SWAMP = 2;

class RoomPosition {
    constructor(x, y, roomName) {
        this.x = x;
        this.y = y;
        this.roomName = roomName;
    }
    getRangeTo(x, y) {
        if (typeof x === "object") ({ x, y } = x);
        return Math.max(Math.abs(this.x - x), Math.abs(this.y - y));
    }
    toString() {
        return `[room ${this.roomName} pos ${this.x},${this.y}]`;
    }
}

class CostMatrix {
    constructor() {
        this._bits = new Uint8Array(2500);
    }
    get(x, y) {
        return this._bits[x * 50 + y];
    }
    set(x, y, v) {
        this._bits[x * 50 + y] = v;
    }
    clone() {
        const m = new CostMatrix();
        m._bits.set(this._bits);
        return m;
    }
}

const terrains = {};

class Terrain {
    constructor(data) {
        this.data = data;
    }
    get(x, y) {
        return Number(this.data[y * 50 + x]) & 3;
    }
}

function search(origin, goals, opts = {}) {
    if (!Array.isArray(goals)) goals = [goals];
    goals = goals.map(g => (g.pos ? { pos: g.pos, range: g.range ?? 0 } : { pos: g, range: 0 }));
    const terrain = terrains[origin.roomName];
    const matrix = opts.roomCallback ? opts.roomCallback(origin.roomName) : null;
    const plain = opts.plainCost ?? 1;
    const swamp = opts.swampCost ?? 5;
    const weight = opts.heuristicWeight ?? 1.2;
    const maxOps = opts.maxOps ?? 2000;
    const minCost = Math.min(plain, swamp);

    const h = (x, y) => {
        let best = Infinity;
        for (const g of goals) best = Math.min(best, Math.max(0, Math.max(Math.abs(g.pos.x - x), Math.abs(g.pos.y - y)) - g.range));
        return best;
    };
    const cost = (x, y) => {
        const m = matrix ? matrix.get(x, y) : 0;
        if (m) return m >= 255 ? Infinity : m;
        const t = terrain.get(x, y);
        if (t & TERRAIN_MASK_WALL) return Infinity;
        return t & TERRAIN_MASK_SWAMP ? swamp : plain;
    };

    const g = new Float64Array(2500).fill(Infinity);
    const parent = new Int32Array(2500).fill(-1);
    const closed = new Uint8Array(2500);
    const heap = [];
    const push = (f, i) => {
        heap.push([f, i]);
        let k = heap.length - 1;
        while (k > 0) {
            const p = (k - 1) >> 1;
            if (heap[p][0] <= heap[k][0]) break;
            [heap[p], heap[k]] = [heap[k], heap[p]];
            k = p;
        }
    };
    const pop = () => {
        const top = heap[0];
        const last = heap.pop();
        if (heap.length) {
            heap[0] = last;
            let k = 0;
            for (;;) {
                const l = 2 * k + 1, r = l + 1;
                let s = k;
                if (l < heap.length && heap[l][0] < heap[s][0]) s = l;
                if (r < heap.length && heap[r][0] < heap[s][0]) s = r;
                if (s === k) break;
                [heap[s], heap[k]] = [heap[k], heap[s]];
                k = s;
            }
        }
        return top;
    };

    const start = origin.x + 50 * origin.y;
    g[start] = 0;
    push(h(origin.x, origin.y) * minCost * weight, start);
    let ops = 0;
    let found = -1;
    let closest = start;
    let closestH = h(origin.x, origin.y);
    while (heap.length && ops < maxOps) {
        const [, i] = pop();
        if (closed[i]) continue;
        closed[i] = 1;
        ops++;
        const x = i % 50, y = (i / 50) | 0;
        const hi = h(x, y);
        if (hi === 0) {
            found = i;
            break;
        }
        if (hi < closestH) {
            closestH = hi;
            closest = i;
        }
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (!dx && !dy) continue;
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx > 49 || ny > 49) continue;
                const j = nx + 50 * ny;
                if (closed[j]) continue;
                const c = cost(nx, ny);
                if (c === Infinity) continue;
                const ng = g[i] + c;
                if (ng < g[j]) {
                    g[j] = ng;
                    parent[j] = i;
                    push(ng + h(nx, ny) * minCost * weight, j);
                }
            }
        }
    }
    const end = found >= 0 ? found : closest;
    const path = [];
    for (let k = end; k !== start && k >= 0; k = parent[k]) path.push(new RoomPosition(k % 50, (k / 50) | 0, origin.roomName));
    path.reverse();
    return { path, ops, cost: g[end], incomplete: found < 0 };
}

let cpuStart = process.hrtime.bigint();
Object.assign(globalThis, {
    TERRAIN_MASK_WALL,
    TERRAIN_MASK_SWAMP,
    RoomPosition,
    PathFinder: { CostMatrix, search },
    Room: { Terrain: class extends Terrain {} },
    Memory: { rooms: {}, logLevel: 2 },
    Game: {
        time: 1,
        rooms: {},
        cpu: {
            bucket: 10000,
            limit: 20,
            tickLimit: 500,
            // ~1 ms here is roughly 1 CPU in game (pessimistic for a JIT-warm server)
            getUsed: () => Number(process.hrtime.bigint() - cpuStart) / 1e6,
        },
    },
});

module.exports = {
    makeTerrain(roomName, data) {
        terrains[roomName] = new Terrain(data);
        return terrains[roomName];
    },
    resetCpu() {
        cpuStart = process.hrtime.bigint();
    },
};
