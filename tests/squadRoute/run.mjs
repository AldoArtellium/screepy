/**
 * Offline check of military/routeModel: room costs of a squad's room route (ally < neutral < enemy
 * remote < enemy room, the target always allowed), the route picked on a small map, and the obstacle
 * cache that keeps a room's matrix once it is out of sight.
 *
 *   node tests/squadRoute/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-squadroute-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--rootDir", join(ROOT, "src"), "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash",
            join(ROOT, "src", "military", "routeModel.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside this file (global declarations) don't prevent emitting
}

const { routeRoomCost, ObstacleCache, ROUTE_COST } = require(join(OUT, "military", "routeModel.js"));

let failures = 0;
function check(label, actual, expected) {
    const ok = Object.is(actual, expected);
    if (!ok) failures++;
    console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
}

const ME = "screepy";
const cost = (room, info, ourRemote = false, target = "T") => routeRoomCost(room, target, info, ME, ourRemote);

console.log("Room costs");
check("own room", cost("A", { owner: ME }), ROUTE_COST.ally);
check("our reservation", cost("A", { reserver: ME }), ROUTE_COST.ally);
check("our remote (selected, no reservation)", cost("A", {}, true), ROUTE_COST.ally);
check("neutral room", cost("A", {}), ROUTE_COST.neutral);
check("unknown room", cost("A", undefined), ROUTE_COST.neutral);
check("invader reservation is neutral", cost("A", { reserver: "Invader" }), ROUTE_COST.neutral);
check("enemy remote", cost("A", { reserver: "doorknobnob" }), ROUTE_COST.enemyRemote);
check("enemy remote we also mine", cost("A", { reserver: "doorknobnob" }, true), ROUTE_COST.enemyRemote);
check("enemy room", cost("A", { owner: "doorknobnob" }), Infinity);
check("enemy room that is the target", cost("T", { owner: "doorknobnob" }), ROUTE_COST.ally);
// shard0 2026-10-25: the W27N9 quad was routed through the keeper room W26N5, where cartographer (keepers
// avoided) refused every step its PathFinder path took: ERR_NO_PATH each tick, ~5 CPU per tick
check("source keeper room W26N5", cost("W26N5", {}), Infinity);
check("source keeper room E14S6", cost("E14S6", undefined), Infinity);
check("sector center W25N5 (no keepers)", cost("W25N5", {}), ROUTE_COST.neutral);
check("room next to the keeper block W27N5", cost("W27N5", {}), ROUTE_COST.neutral);
check("highway W30N5", cost("W30N5", {}), ROUTE_COST.neutral);
check("keeper room that is the target", cost("W26N5", {}, false, "W26N5"), ROUTE_COST.ally);
// shard0 2026-10-27: W24N8 (respawn zone) to W25N7 was routed through W25N8 (normal zone, walled off):
// findRoute ignores the zone walls, the quad would have stood at the wall
check("room of another zone", routeRoomCost("W25N8", "W25N7", { reserver: "asdpof" }, ME, false, false), Infinity);
check("target in another zone", routeRoomCost("W25N7", "W25N7", { owner: "Blindfold" }, ME, false, false), Infinity);
check("same zone by default", routeRoomCost("W24N7", "W25N7", { reserver: "Blindfold" }, ME, false), ROUTE_COST.enemyRemote);
check("order ally < neutral < enemy remote < enemy",
    ROUTE_COST.ally < ROUTE_COST.neutral && ROUTE_COST.neutral < ROUTE_COST.enemyRemote && ROUTE_COST.enemyRemote < Infinity, true);

// Dijkstra over rooms like Game.map.findRoute (cost of each room entered)
function route(graph, info, from, to, ourRemotes = new Set()) {
    const dist = new Map([[from, 0]]);
    const prev = new Map();
    const open = new Set([from]);
    while (open.size) {
        const room = [...open].sort((a, b) => dist.get(a) - dist.get(b))[0];
        open.delete(room);
        if (room === to) break;
        for (const next of graph[room] ?? []) {
            const c = routeRoomCost(next, to, info[next], ME, ourRemotes.has(next));
            if (c === Infinity) continue;
            const d = dist.get(room) + c;
            if (d < (dist.get(next) ?? Infinity)) {
                dist.set(next, d);
                prev.set(next, room);
                open.add(next);
            }
        }
    }
    if (!dist.has(to)) return null;
    const rooms = [to];
    while (rooms[0] !== from) rooms.unshift(prev.get(rooms[0]));
    return rooms.join(">");
}

console.log("Routes");
// H -> T: straight through E (enemy room), or around by N1, N2 (neutral) or R (enemy remote)
const graph = { H: ["E", "R", "N1"], E: ["T"], R: ["T"], N1: ["N2"], N2: ["T"] };
check("enemy room avoided, a 2-room neutral detour beats an enemy remote",
    route(graph, { E: { owner: "x" }, R: { reserver: "x" } }, "H", "T"), "H>N1>N2>T");
const farGraph = { H: ["E", "R", "N1"], E: ["T"], R: ["T"], N1: ["N2"], N2: ["N3"], N3: ["T"] };
check("enemy remote beats a 3-room neutral detour", route(farGraph, { E: { owner: "x" }, R: { reserver: "x" } }, "H", "T"), "H>R>T");
const longGraph = { H: ["E", "R", "N1"], E: ["T"], R: ["T"], N1: ["T"] };
check("one neutral room beats an enemy remote", route(longGraph, { E: { owner: "x" }, R: { reserver: "x" } }, "H", "T"), "H>N1>T");
const allyGraph2 = { H: ["N1", "A1"], N1: ["N2"], N2: ["T"], A1: ["A2"], A2: ["T"] };
check("our remotes preferred at equal length", route(allyGraph2, {}, "H", "T", new Set(["A1", "A2"])), "H>A1>A2>T");
check("only an enemy room on the way: no route", route({ H: ["E"], E: ["T"] }, { E: { owner: "x" } }, "H", "T"), null);
check("enemy target reachable", route({ H: ["T"] }, { T: { owner: "x" } }, "H", "T"), "H>T");

console.log("Obstacle cache");
const cache = new ObstacleCache(20, 1000, 2);
let computed = 0;
const compute = () => ({ id: ++computed });
check("visible: computed", cache.get("A", 100, true, compute).id, 1);
check("visible within the refresh: cached", cache.get("A", 110, true, compute).id, 1);
check("visible after the refresh: recomputed", cache.get("A", 125, true, compute).id, 2);
check("out of sight: last matrix kept", cache.get("A", 900, false, compute).id, 2);
check("out of sight: nothing computed", computed, 2);
check("out of sight past the lifetime: dropped", cache.get("A", 1200, false, compute), undefined);
check("dropped for good", cache.get("A", 1201, false, compute), undefined);
check("never seen: undefined", cache.get("B", 100, false, compute), undefined);
cache.get("B", 1300, true, compute);
cache.get("C", 1301, true, compute);
cache.get("D", 1302, true, compute);
check("capacity: oldest room dropped", cache.get("B", 1303, false, compute), undefined);
check("capacity: newest kept", cache.get("D", 1303, false, compute)?.id, computed);
check("capacity: size", cache.size, 2);

if (failures) {
    console.log(`\n${failures} failure(s)`);
    process.exit(1);
}
console.log("\nAll checks passed");
