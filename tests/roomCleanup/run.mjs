/**
 * Offline check of construction/RoomCleanup: which walls the cleanup destroys once the plan is final,
 * against a mocked Game / Memory and a stubbed room planner.
 *
 *   node tests/roomCleanup/run.mjs
 *
 * Respawn and novice area walls (shard0 W24N8, 2026-10-23: 37 border walls) come without `hits`,
 * with `hitsMax` 300M and a real-time `decayTime`; the engine never sets `ticksToLive` on them and
 * silently drops their destroy intent while destroy() still returns OK.
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-roomCleanup-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--rootDir", join(ROOT, "src"), "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash",
            join(ROOT, "src", "construction", "RoomCleanup.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside this file (global declarations) don't prevent emitting
}

Object.assign(globalThis, {
    OK: 0,
    FIND_STRUCTURES: 107, FIND_HOSTILE_STRUCTURES: 109, FIND_HOSTILE_CONSTRUCTION_SITES: 115,
    FIND_HOSTILE_CREEPS: 103, FIND_HOSTILE_POWER_CREEPS: 121,
    STRUCTURE_WALL: "constructedWall", STRUCTURE_EXTENSION: "extension", STRUCTURE_LAB: "lab",
    STRUCTURE_LINK: "link", STRUCTURE_CONTAINER: "container", STRUCTURE_ROAD: "road", STRUCTURE_RAMPART: "rampart",
    CONSTRUCTION_COST: { constructedWall: 1, extension: 3000, lab: 50000, link: 5000, container: 5000, road: 300, rampart: 1 },
});

// The planner is stubbed: one final plan with a single planned wall at (10,10)
const plan = {
    types: () => ["wall"],
    getLocations: type => (type === "wall" ? [{ x: 10, y: 10 }] : []),
};
require.cache[join(OUT, "planner", "RoomPlanner.js")] = {
    id: "RoomPlanner", loaded: true,
    exports: { roomPlanner: { getPlan: () => plan, isFinal: () => true } },
};

const { roomCleanupModule } = require(join(OUT, "construction", "RoomCleanup.js"));

let failures = 0;
function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

/** Owned room W24N8 holding the given walls; returns the names of the walls destroy() was called on */
function run(walls, { hostiles = 0 } = {}) {
    const destroyed = [];
    const room = {
        name: "W24N8",
        controller: { my: true },
        find: type => {
            if (type === FIND_STRUCTURES) return structures;
            if (type === FIND_HOSTILE_CREEPS) return Array.from({ length: hostiles }, () => ({}));
            return [];
        },
    };
    const structures = walls.map(({ name, x, y, ...fields }) => ({
        structureType: STRUCTURE_WALL,
        pos: { x, y },
        room,
        ...fields,
        destroy: () => { destroyed.push(name); return OK; },
    }));
    globalThis.Memory = { stats: { counters: {} } };
    globalThis.Game = { time: 78518777, rooms: { W24N8: room } };
    roomCleanupModule();
    return destroyed;
}

const respawn = { name: "respawn", x: 0, y: 15, hitsMax: 300000000 };
const legacyNovice = { name: "legacyNovice", x: 49, y: 15, hits: 1, hitsMax: 1, ticksToLive: 5000 };
const ours = { name: "ours", x: 20, y: 20, hits: 1000, hitsMax: 300000000 };
const planned = { name: "planned", x: 10, y: 10, hits: 1000, hitsMax: 300000000 };

check("respawn area wall (no hits): kept", run([respawn]), []);
check("legacy novice wall (ticksToLive): kept", run([legacyNovice]), []);
check("unplanned wall with hits: destroyed", run([ours]), ["ours"]);
check("planned wall: kept", run([planned]), []);
check("mixed room: only the destructible unplanned wall", run([respawn, legacyNovice, ours, planned]), ["ours"]);
check("respawn wall on a planned wall tile: kept", run([{ ...respawn, x: 10, y: 10 }]), []);
check("hostile creeps in the room: nothing destroyed", run([ours], { hostiles: 1 }), []);
run([respawn, ours]);
check("counter only for the real destroy", Memory.stats.counters["cleanup:constructedWall"], 1);

console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
