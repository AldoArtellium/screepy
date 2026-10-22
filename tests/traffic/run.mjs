/**
 * Offline check of core/traffic resolveTraffic: one tile per creep, a move only into a tile its
 * occupant leaves, swaps and chains through a one-tile choke, holding creeps kept in place.
 * The W28N7 fixture is the shard0 jam of 2026-10-21 (creeps frozen 200-460 ticks): cartographer's
 * greedy reconcile (ported below) leaves it frozen, the engine model shows what really moves.
 *
 *   node tests/traffic/run.mjs
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-traffic-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--rootDir", join(ROOT, "src"), "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash",
            join(ROOT, "src", "core", "traffic.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside this file (global declarations) don't prevent emitting
}

const { resolveTraffic } = require(join(OUT, "core", "traffic.js"));

let failures = 0;
function check(name, ok, detail = "") {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
    if (!ok) failures++;
}

const key = (x, y) => y * 50 + x;

/** Scenario from a map: '#' wall, '.' floor, creeps listed with their position, step or hold */
function scenario(grid, origin, list) {
    const [ox, oy] = origin;
    const walkable = (x, y) => {
        const row = grid[y - oy];
        return row !== undefined && row[x - ox] === ".";
    };
    const adjacent = (x, y) => {
        const out = [];
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if ((dx || dy) && walkable(x + dx, y + dy)) out.push(key(x + dx, y + dy));
            }
        }
        return out;
    };
    return list.map(c => {
        const pos = key(c.x, c.y);
        let targets;
        let priority = c.priority ?? 0;
        if (c.step) targets = [key(c.step[0], c.step[1])];
        else if (c.hold) targets = [pos];
        else {
            // no intent: cartographer shoves it to any adjacent walkable tile
            targets = [pos, ...adjacent(c.x, c.y)];
            priority = 0;
        }
        return { id: c.name, pos, priority, targets, mover: !!c.step };
    });
}

/** Engine movement check (@screeps/engine processor/intents/movement.js): which creeps really move */
function engineMoves(creeps, moves) {
    const byTile = new Map();
    for (const c of creeps) {
        const t = moves.get(c.id);
        if (t === undefined || t === c.pos) continue;
        if (!byTile.has(t)) byTile.set(t, []);
        byTile.get(t).push(c);
    }
    const winner = new Map();
    for (const [t, list] of byTile) {
        // several movers: the one whose tile is the target of a creep coming from t wins (a swap), else the first
        const swap = list.find(c => (byTile.get(c.pos) ?? []).some(o => o.pos === t));
        winner.set(t, swap ?? list[0]);
    }
    const occupant = new Map(creeps.map(c => [c.pos, c]));
    const moving = new Set(winner.values());
    let changed = true;
    while (changed) {
        changed = false;
        for (const [t, c] of winner) {
            const occ = occupant.get(t);
            if (occ && occ !== c && !moving.has(occ)) {
                winner.delete(t);
                moving.delete(c);
                changed = true;
            }
        }
    }
    return moving;
}

/** cartographer 1.8.16 reconcileTrafficByRoom, the greedy pass (no pullers, no blocked squares) */
function cartographer(creeps) {
    const prefersToStay = new Set(creeps.filter(c => c.targets[0] === c.pos).map(c => c.pos));
    const byTarget = new Map();
    const intents = creeps.map(c => ({ c, targets: c.targets, targetCount: c.targets.length }));
    for (const i of intents) {
        for (const t of i.targets) {
            if (!byTarget.has(t)) byTarget.set(t, new Set());
            byTarget.get(t).add(i);
        }
    }
    const used = new Set();
    const moves = new Map();
    const priorities = [...new Set(creeps.map(c => c.priority))].sort((a, b) => b - a);
    for (const pr of priorities) {
        for (;;) {
            const left = intents.filter(i => i.c.priority === pr && !i.done);
            if (!left.length) break;
            const min = Math.min(...left.map(i => i.targetCount));
            const stack = left.filter(i => i.targetCount === min);
            while (stack.length) {
                const i = stack.shift();
                if (i.resolved) {
                    i.done = true;
                    continue;
                }
                let target;
                for (const t of i.targets) {
                    if (used.has(t)) continue;
                    if (t === i.c.pos || !prefersToStay.has(t)) {
                        target = t;
                        break;
                    }
                    target ??= t;
                }
                i.done = true;
                if (target === undefined) continue;
                moves.set(i.c.id, target);
                i.resolved = true;
                used.add(target);
                for (const o of byTarget.get(target) ?? []) if (!o.resolved) o.targetCount--;
                if (target !== i.c.pos) {
                    const here = [...(byTarget.get(i.c.pos) ?? [])].filter(o => o !== i && o.targets.length < 2);
                    const sw = here.find(o => !o.resolved && o.c.pos === target);
                    if (sw) {
                        used.delete(i.c.pos);
                        sw.done = false;
                        stack.unshift(sw);
                    }
                }
            }
        }
    }
    return moves;
}

/** Checks every resolution must pass, returns the creeps the engine moves */
function checkConsistent(name, creeps, moves) {
    const tiles = new Map();
    let doubles = 0;
    for (const c of creeps) {
        const t = moves.get(c.id) ?? c.pos;
        if (tiles.has(t)) doubles++;
        tiles.set(t, c);
    }
    check(`${name}: one creep per tile`, doubles === 0, `${doubles} shared`);
    const moving = engineMoves(creeps, moves);
    const wanted = creeps.filter(c => moves.has(c.id) && moves.get(c.id) !== c.pos);
    const dropped = wanted.filter(c => !moving.has(c)).map(c => c.id);
    check(`${name}: every resolved move goes through the engine`, dropped.length === 0, dropped.join(" "));
    return moving;
}

const moved = (moving, id) => [...moving].some(c => c.id === id);

// --- W28N7, shard0 2026-10-21 ---
const fixture = JSON.parse(readFileSync(join(ROOT, "tests", "traffic", "data", "W28N7.json"), "utf8"));

/** Next tile of the cheapest path to the goal, creeps ignored (cartographer's fallback when stuck) */
function nextStep(grid, from, goal, avoid = new Set()) {
    const [gx, gy, range] = goal;
    const cost = k => {
        if (avoid.has(k)) return Infinity;
        const ch = grid[Math.floor(k / 50)][k % 50];
        return ch === "#" ? Infinity : ch === "=" ? 1 : ch === "~" ? 10 : 2;
    };
    const dist = new Map([[from, 0]]);
    const prev = new Map();
    const open = [from];
    while (open.length) {
        open.sort((a, b) => dist.get(a) - dist.get(b));
        const k = open.shift();
        const x = k % 50;
        const y = Math.floor(k / 50);
        if (Math.max(Math.abs(x - gx), Math.abs(y - gy)) <= range) {
            let step = k;
            while (prev.get(step) !== from) step = prev.get(step);
            return step;
        }
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const nx = x + dx;
                const ny = y + dy;
                if ((!dx && !dy) || nx < 1 || nx > 48 || ny < 1 || ny > 48) continue;
                const nk = key(nx, ny);
                const d = dist.get(k) + cost(nk);
                if (d < (dist.get(nk) ?? Infinity)) {
                    dist.set(nk, d);
                    prev.set(nk, k);
                    open.push(nk);
                }
            }
        }
    }
    return undefined;
}

/**
 * Ticks of W28N7: every mover steps along its path, the resolver picks the moves, the engine applies
 * them; a mover within range of its goal is done (taken out, as if it got its next order elsewhere).
 * Like TrafficManager.requestMove, a mover stuck 2 ticks paths around creeps, through them when that
 * leaves no path.
 */
function simulate(resolve, maxTicks) {
    let creeps = fixture.creeps.map(c => ({ ...c, stuck: 0 }));
    const total = creeps.filter(c => c.goal).length;
    for (let tick = 1; tick <= maxTicks; tick++) {
        const stepOf = c => {
            const from = key(c.x, c.y);
            let step;
            if (c.stuck >= 2) step = nextStep(fixture.grid, from, c.goal, new Set(creeps.filter(o => o !== c).map(o => key(o.x, o.y))));
            step ??= nextStep(fixture.grid, from, c.goal);
            return [step % 50, Math.floor(step / 50)];
        };
        const list = scenario(fixture.grid, fixture.origin, creeps.map(c => (c.goal ? { ...c, step: stepOf(c) } : c)));
        const moves = resolve(list);
        const moving = engineMoves(list, moves);
        const next = new Map(list.map(l => [l.id, l]));
        creeps = creeps.map(c => {
            const l = next.get(c.name);
            if (!moving.has(l)) return { ...c, stuck: c.stuck + 1 };
            const t = moves.get(c.name);
            return { ...c, x: t % 50, y: Math.floor(t / 50), stuck: 0 };
        }).filter(c => !c.goal || Math.max(Math.abs(c.x - c.goal[0]), Math.abs(c.y - c.goal[1])) > c.goal[2]);
        const left = creeps.filter(c => c.goal).length;
        if (!left) return { tick, done: total };
    }
    if (process.env.DEBUG) console.log(creeps.map(c => `${c.name}@${c.x},${c.y}${c.goal ? `->${c.goal}` : ""}`).join(" "));
    return { tick: maxTicks, done: total - creeps.filter(c => c.goal).length, left: creeps.filter(c => c.goal).map(c => c.name) };
}

{
    const w28n7 = scenario(fixture.grid, fixture.origin, fixture.creeps);
    const firstSteps = fixture.creeps.filter(c => c.goal).every(c => nextStep(fixture.grid, key(c.x, c.y), c.goal) === key(...c.step));
    check("W28N7: the path port finds the recorded first steps", firstSteps);

    const base = engineMoves(w28n7, cartographer(w28n7));
    check("W28N7 cartographer: the choke pair stays frozen (the bug)", !moved(base, "builder_a5") && !moved(base, "remoteHauler_fw"));

    const { moves } = resolveTraffic(w28n7);
    checkConsistent("W28N7", w28n7, moves);
    check("W28N7: holders stay", ["harvester_6w", "upgrader_3t"].every(n => moves.get(n) === w28n7.find(c => c.id === n).pos));

    const before = simulate(cartographer, 60);
    console.log(`     W28N7 cartographer, 60 ticks: ${before.done} movers arrived, stuck: ${(before.left ?? []).join(" ")}`);
    const after = simulate(list => resolveTraffic(list).moves, 60);
    console.log(`     W28N7 resolveTraffic: ${after.done} movers arrived by tick ${after.tick}${after.left ? `, stuck: ${after.left.join(" ")}` : ""}`);
    check("W28N7: every mover reaches its goal within 60 ticks", !after.left);
    check("W28N7: cartographer leaves movers frozen (the bug)", !!before.left);
}

// --- synthetic cases ---
const corridor = ["#######", ".......", "#######"];
{
    const creeps = scenario(corridor, [0, 0], [
        { name: "east", x: 2, y: 1, step: [3, 1], priority: 51 },
        { name: "west", x: 3, y: 1, step: [2, 1], priority: 51 },
    ]);
    const { moves } = resolveTraffic(creeps);
    const moving = checkConsistent("head-on", creeps, moves);
    check("head-on: both swap", moving.size === 2);
}
{
    // a queue into a corridor: each one steps onto the next one's tile, the head onto a free tile
    const creeps = scenario(corridor, [0, 0], [
        { name: "c", x: 1, y: 1, step: [2, 1], priority: 51 },
        { name: "b", x: 2, y: 1, step: [3, 1], priority: 51 },
        { name: "a", x: 3, y: 1, step: [4, 1], priority: 51 },
    ]);
    const { moves } = resolveTraffic(creeps);
    const moving = checkConsistent("queue", creeps, moves);
    check("queue: the whole queue moves", moving.size === 3);
}
{
    const open = [".....", ".....", "....."];
    const creeps = scenario(open, [0, 0], [
        { name: "r1", x: 1, y: 1, step: [2, 1], priority: 51 },
        { name: "r2", x: 2, y: 1, step: [2, 2], priority: 51 },
        { name: "r3", x: 2, y: 2, step: [1, 1], priority: 51 },
    ]);
    const { moves } = resolveTraffic(creeps);
    const moving = checkConsistent("rotation", creeps, moves);
    check("rotation: three creeps rotate", moving.size === 3);
}
{
    const creeps = scenario(corridor, [0, 0], [
        { name: "mover", x: 2, y: 1, step: [3, 1], priority: 51 },
        { name: "miner", x: 3, y: 1, hold: true, priority: 96 },
    ]);
    const { moves, blocked } = resolveTraffic(creeps);
    checkConsistent("holder", creeps, moves);
    check("holder: a holding creep is never pushed", moves.get("miner") === key(3, 1) && moves.get("mover") !== key(3, 1));
    check("holder: the mover counts as blocked", blocked === 1);
}
{
    // an idle creep (no intent) in a dead end is pushed deeper to let a mover in
    const creeps = scenario(corridor, [0, 0], [
        { name: "mover", x: 4, y: 1, step: [5, 1], priority: 51 },
        { name: "idle", x: 5, y: 1 },
    ]);
    const { moves, pushed } = resolveTraffic(creeps);
    const moving = checkConsistent("shove", creeps, moves);
    check("shove: the idle creep makes way", moved(moving, "mover") && moves.get("idle") === key(6, 1) && pushed === 1);
}
{
    // a high priority creep behind a lower priority mover that can't advance: they swap
    const creeps = scenario(corridor, [0, 0], [
        { name: "bayFiller", x: 1, y: 1, step: [2, 1], priority: 91 },
        { name: "builder", x: 2, y: 1, step: [3, 1], priority: 51 },
        { name: "miner", x: 3, y: 1, hold: true, priority: 96 },
    ]);
    const { moves } = resolveTraffic(creeps);
    const moving = checkConsistent("priority swap", creeps, moves);
    check("priority swap: the stuck lower priority mover steps back", moved(moving, "bayFiller") && moves.get("builder") === key(1, 1));
}
{
    // the reverse: a lower priority creep never pushes back a higher priority mover
    const creeps = scenario(corridor, [0, 0], [
        { name: "builder", x: 1, y: 1, step: [2, 1], priority: 51 },
        { name: "bayFiller", x: 2, y: 1, step: [3, 1], priority: 91 },
        { name: "miner", x: 3, y: 1, hold: true, priority: 96 },
    ]);
    const { moves } = resolveTraffic(creeps);
    checkConsistent("no reverse swap", creeps, moves);
    check("no reverse swap: both wait", moves.get("bayFiller") === key(2, 1) && moves.get("builder") === key(1, 1));
}

{
    // a packed block of idle creeps pushed into from outside must not exhaust the budget for a lone
    // mover elsewhere in the room (review: 49 idle creeps took 9.5 ms and froze it)
    // 6x6 block of creeps holding their range: own tile + 3 tiles, all inside the block
    const creeps = [];
    const inBlock = (x, y) => x >= 1 && x <= 6 && y >= 1 && y <= 6;
    for (let x = 1; x <= 6; x++) {
        for (let y = 1; y <= 6; y++) {
            const alt = [[x + 1, y], [x, y + 1], [x - 1, y]].filter(([ax, ay]) => inBlock(ax, ay)).map(([ax, ay]) => key(ax, ay));
            creeps.push({ id: `b${x},${y}`, pos: key(x, y), priority: 50, targets: [key(x, y), ...alt] });
        }
    }
    creeps.push({ id: "intruder", pos: key(7, 3), priority: 60, targets: [key(6, 3)] });
    creeps.push({ id: "lone", pos: key(15, 10), priority: 1, targets: [key(16, 10)] });
    const start = process.hrtime.bigint();
    const { moves } = resolveTraffic(creeps);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    checkConsistent("dense block", creeps, moves);
    check("dense block: the lone mover still moves", moves.get("lone") === key(16, 10));
    check("dense block: resolved in under 5 ms", ms < 5, `${ms.toFixed(2)} ms`);
}
{
    // never step a lower priority mover back onto an exit tile: the engine would carry it out of the room
    const edge = ["#.#", "#.#", "#.#"];
    const creeps = scenario(edge, [0, 0], [
        { name: "arrived", x: 1, y: 0, step: [1, 1], priority: 91 },
        { name: "builder", x: 1, y: 1, step: [1, 2], priority: 51 },
        { name: "miner", x: 1, y: 2, hold: true, priority: 96 },
    ]);
    const { moves } = resolveTraffic(creeps);
    checkConsistent("exit tile", creeps, moves);
    check("exit tile: no step back onto an exit tile", moves.get("builder") === key(1, 1));
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
