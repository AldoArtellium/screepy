/**
 * Offline check of remote/repairs: when a remote source's container and path roads need a remote
 * builder trip. Cases from shard0 on 2026-10-25 (hits missing per remote room).
 *
 *   node tests/remoteRepairs/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-remoterepairs-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--rootDir", join(ROOT, "src"), "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash",
            join(ROOT, "src", "remote", "repairs.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside this file (global declarations) don't prevent emitting
}

const {
    repairsDue,
    REPAIR_BATCH_HITS,
    pathNeed,
    builderWork,
    energyPerWorkLife,
    upkeepWork,
    MIN_REPAIR_WORK,
    MIN_BUILD_WORK,
    onRoomEdge
} = require(join(OUT, "remote", "repairs.js"));

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
    if (!ok) failures++;
};

const road = (hits, hitsMax = 5000) => ({ hits, hitsMax });
const full = Array.from({ length: 50 }, () => road(4800));
const container = { hits: 250000, hitsMax: 250000 };

check("roads near full: no trip", !repairsDue(container, full));
// shard0 W28N6: 50 roads, 9200 hits missing, worst 600 missing
check("shard0 W28N6 (9200 missing, worst 600): no trip", !repairsDue(container, [...full.slice(1), road(4400)]));
// Hivemind's 2/3 threshold sent a builder for one road at 3000 / 5000
check("one road at 60%: no trip yet", !repairsDue(container, [...full.slice(1), road(3000)]));
check("one road below a third: trip", repairsDue(container, [...full.slice(1), road(1600)]));
check("a swamp road below a third: trip", repairsDue(container, [...full.slice(1), road(8000, 25000)]));
// shard0 W27N4: 39 roads, 102460 hits missing, 23 below 2/3
const worn = Array.from({ length: 39 }, () => road(2400));
check("shard0 W27N4 (102k missing): trip", repairsDue(container, worn));
check(`${REPAIR_BATCH_HITS} hits missing over many roads: trip`, repairsDue(container, Array.from({ length: 50 }, () => road(4000))));
check("container below half: trip", repairsDue({ hits: 120000, hitsMax: 250000 }, full));
check("missing road (not built): trip", repairsDue(container, [...full, null]));
check("missing container: trip", repairsDue(null, full));
check("out of sight (undefined): no trip", !repairsDue(undefined, undefined));

// ------------------------------------------------------------------ builder WORK demand
console.log("\nremote builder WORK demand");
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
const need = (container, roads, travel) => ({ ...pathNeed(container, roads), travel });
const old = tiles => Math.ceil(0.7 + 0.03 * tiles);

// One WORK: 125 energy per trip, trips of 2 x travel + 125 ticks over 1500 - travel ticks
check("energy per WORK over a life, 100 tiles", near(energyPerWorkLife(100), 125 * (1400 / 325)), energyPerWorkLife(100).toFixed(0));
check("farther paths spend less per WORK", energyPerWorkLife(300) < energyPerWorkLife(100) / 2, energyPerWorkLife(300).toFixed(0));
check("a path longer than a life still counts one trip", energyPerWorkLife(1600) === 125);

const pn = pathNeed(container, [road(4000), null, { buildLeft: 120 }, undefined]);
check("pathNeed: repair hits, missing road, site, out of sight", pn.repairHits === 1000 && pn.buildEnergy === 420, JSON.stringify(pn));
check("pathNeed: missing container is 5000 to build", pathNeed(null, []).buildEnergy === 5000);
check("pathNeed: swamp road cost passed in", pathNeed(container, [null], 1500).buildEnergy === 1500);

// shard0 2026-10-26: every road and container healthy, 4.7 builders of 33 parts on W27N5's paths
check("nothing due: no builder", builderWork([]) === 0);
check("healthy path seen: no WORK", builderWork([need(container, full.map(() => road(5000)), 100)]) === 0);
// One road below a third on a 50-road path: ~132 energy, the 2-WORK floor (old: ceil(0.7 + 0.03 x 50) = 3 per source)
const oneWorn = builderWork([need(container, [...full.slice(1), road(1600)], 100)]);
check("one worn road: the repair floor", oneWorn === MIN_REPAIR_WORK, `${oneWorn} WORK (old ${old(50)})`);
// shard0 W27N4: 39 roads, 102460 hits missing, ~1025 energy at ~100 tiles: 2 WORK
const w27n4 = builderWork([need(container, worn, 100)]);
check("shard0 W27N4 (102k missing): 2 WORK", w27n4 === 2, `${w27n4} WORK (old ${old(39)})`);
// Several due sources share the one builder: their WORK adds up
const three = builderWork([need(container, worn, 100), need(container, worn, 150), need(container, worn, 60)]);
check("three worn paths: WORK added up", three >= 5 && three <= 7, `${three} WORK (old ${3 * old(39)})`);
// A new path: 100 plain roads to build, 30000 energy, more than any body (capped by the spawn role)
const fresh = builderWork([need(container, Array.from({ length: 100 }, () => null), 100)]);
check("new path of 100 roads: above the body cap", fresh >= 50, `${fresh} WORK`);
check("one small site: the build floor", builderWork([need(container, [{ buildLeft: 100 }], 100)]) === MIN_BUILD_WORK);
check("everything out of sight: no WORK", builderWork([need(undefined, [undefined, undefined], 100)]) === 0);

// ------------------------------------------------------------------ room edge tiles
console.log("\nroom edge tiles (no road can stand there)");
check("edge tiles", onRoomEdge({ x: 0, y: 20 }) && onRoomEdge({ x: 49, y: 20 }) && onRoomEdge({ x: 20, y: 0 }) && onRoomEdge({ x: 20, y: 49 }));
check("inner tiles", !onRoomEdge({ x: 1, y: 1 }) && !onRoomEdge({ x: 48, y: 48 }) && !onRoomEdge({ x: 25, y: 25 }));
// shard0 2026-10-26, W29N6:5:36 from W29N7: 40 path tiles in W29N6, the entry tile (49, 30) without road
// (roads are never built on edges), the 39 others roads missing ~28k hits in all (28510 live), none below a third
const entry = { x: 49, y: 30, road: null };
const inner = Array.from({ length: 39 }, (_, i) => ({ x: 48 - (i % 40), y: 30, road: road(i < 38 ? 4270 : 4770) }));
const tiles = [entry, ...inner];
const missingHits = inner.reduce((s, t) => s + t.road.hitsMax - t.road.hits, 0);
const cont = { hits: 249400, hitsMax: 250000 };
check("shard0 W29N6:5:36 with its edge tile: due (the old bug)", repairsDue(cont, tiles.map(t => t.road)), `${missingHits} hits missing`);
const kept = tiles.filter(t => !onRoomEdge(t)).map(t => t.road);
check("shard0 W29N6:5:36 without edge tiles: not due", !repairsDue(cont, kept));
const edgeWork = builderWork([need(cont, tiles.map(t => t.road), 65)]);
check("edge tile counted as a road to build: the 4-WORK build floor (the old bug)", edgeWork === MIN_BUILD_WORK, `${edgeWork} WORK`);
const keptWork = builderWork([need(cont, kept, 65)]);
check("without edge tiles: repairs only (2-WORK floor), and only spawned once due", keptWork === MIN_REPAIR_WORK, `${keptWork} WORK`);

// Selection estimate: steady upkeep of the roads, a fraction of the home's one builder
const up = upkeepWork(100, 100);
check("upkeep of 100 tiles at 100: under a WORK (old 4)", up > 0.5 && up < 1, up.toFixed(2));
check("upkeep grows with the tiles", upkeepWork(200, 200) > 2 * upkeepWork(100, 100));

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
