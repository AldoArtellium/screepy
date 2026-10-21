/**
 * Offline check of remote/travel: ticks a remote harvester takes to walk its path by terrain and body,
 * the path terrain count (roads seen in visible rooms) and the observed travel / spawn wait averages.
 *
 *   node tests/remoteTravel/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-remotetravel-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--rootDir", join(ROOT, "src"), "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash",
            join(ROOT, "src", "remote", "travel.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside this file (global declarations) don't prevent emitting
}

// Room W1N1: swamp for x < 10, a road at (20, 25) when the room is visible
const roads = [{ structureType: "road", pos: { x: 20, y: 25 } }];
Object.assign(globalThis, {
    FIND_STRUCTURES: 107, STRUCTURE_ROAD: "road", TERRAIN_MASK_SWAMP: 2,
    Game: {
        time: 100,
        rooms: {},
        map: { getRoomTerrain: () => ({ get: (x) => (x < 10 ? 2 : 0) }) },
    },
});

const { walkTicks, pathTerrain, recordTravel, travelObserved, recordSpawnLateness, spawnLeadObserved } = require(join(OUT, "remote", "travel.js"));

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
    if (!ok) failures++;
};

// A 6 WORK 1 CARRY remote harvester: ROAD body 4 MOVE, PLAINS body 7 MOVE (bodyBuilder)
const plains = { plain: 100, swamp: 0, road: 0 };
const swamp = { plain: 0, swamp: 100, road: 0 };
const road = { plain: 0, swamp: 0, road: 100 };
check("road body off roads: 2 ticks per plain tile", walkTicks(plains, 6, 4) === 200, walkTicks(plains, 6, 4));
check("road body on roads: 1 tick per tile", walkTicks(road, 6, 4) === 100);
check("road body in swamp: 8 ticks per tile", walkTicks(swamp, 6, 4) === 800, walkTicks(swamp, 6, 4));
check("plains body on plains: 1 tick per tile", walkTicks(plains, 6, 7) === 100);
check("plains body in swamp: 5 ticks per tile", walkTicks(swamp, 6, 7) === 500, walkTicks(swamp, 6, 7));
check("no MOVE: never arrives", walkTicks(plains, 6, 0) === Infinity);

const path = Array.from({ length: 30 }, (_, i) => ({ x: i, y: 25, roomName: "W1N1" }));
const unseen = pathTerrain("W1N1:0:25", path);
check("out of sight: terrain only", unseen.swamp === 10 && unseen.plain === 20 && unseen.road === 0, JSON.stringify(unseen));
Game.rooms.W1N1 = { find: () => roads };
check("cached until it expires", pathTerrain("W1N1:0:25", path).road === 0);
const seen = pathTerrain("W1N1:1:25", path);
check("visible room: its roads count", seen.road === 1 && seen.plain === 19 && seen.swamp === 10, JSON.stringify(seen));

check("no observation: undefined", travelObserved("x") === undefined);
recordTravel("x", 200);
recordTravel("x", 100);
check("observed travel: slow average", Math.abs(travelObserved("x") - 170) < 1e-9, travelObserved("x"));
check("no replacement yet: no spawn lead", spawnLeadObserved("W1N1") === 0);
recordSpawnLateness("W1N1", 100);
check("a late replacement raises the lead", Math.abs(spawnLeadObserved("W1N1") - 30) < 1e-9, spawnLeadObserved("W1N1"));
recordSpawnLateness("W1N1", -50);
check("an early one lowers it", Math.abs(spawnLeadObserved("W1N1") - 15) < 1e-9, spawnLeadObserved("W1N1"));
recordSpawnLateness("W1N1", -500);
check("never below 0", spawnLeadObserved("W1N1") === 0);
for (let i = 0; i < 20; i++) recordSpawnLateness("W1N1", 900);
check("capped at 200", spawnLeadObserved("W1N1") === 200);
// A constant queue of q ticks: the lead settles on q (each spawn is late by q - lead)
let lead = 0;
for (let i = 0; i < 50; i++) {
    recordSpawnLateness("W2N2", 60 - spawnLeadObserved("W2N2"));
    lead = spawnLeadObserved("W2N2");
}
check("a constant queue: the lead settles on it", Math.abs(lead - 60) < 0.5, lead.toFixed(2));

process.exit(failures ? 1 : 0);
