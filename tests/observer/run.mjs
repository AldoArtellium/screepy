/**
 * Offline check of intel/observerPlan: need classification, ranking (military > remote > expansion >
 * rescout, oldest first, military only under CPU pressure), one room per observer within OBSERVER_RANGE,
 * and the scout exclusion of rooms covered by an observer. Rooms of shard0 on 2026-11-15.
 *
 *   node tests/observer/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-observer-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--rootDir", join(ROOT, "src"), "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash",
            join(ROOT, "src", "intel", "observerPlan.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside this file (global declarations) don't prevent emitting
}

const { OBSERVER_RANGE, classifyNeed, rankCandidates, assignObservations, coveredByObserver } = require(join(OUT, "intel", "observerPlan.js"));

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
    if (!ok) failures++;
};

// Linear room distance (Game.map.getRoomLinearDistance without world wrap)
const coords = name => {
    const m = /^([WE])(\d+)([NS])(\d+)$/.exec(name);
    return { x: m[1] === "W" ? -Number(m[2]) - 1 : Number(m[2]), y: m[3] === "N" ? -Number(m[4]) - 1 : Number(m[4]) };
};
const distance = (a, b) => {
    const p = coords(a);
    const q = coords(b);
    return Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y));
};

check("observer range", OBSERVER_RANGE === 10);

// --- Classification -------------------------------------------------------------------------------
const intel = {
    W27N9: { owner: "doorknobnob", controller: true },
    W27N7: { controller: true },
    W28N3: { owner: "Blindfold", controller: true },
    W30N5: { controller: false },
    W22N5: { controller: true }
};
const ctx = {
    military: new Set(["W28N3"]),
    remote: new Set(["W27N7", "W27N9", "W28N3"]),
    expansion: new Set(["W30N5"]),
    intel: room => intel[room]
};
check("military target first, even owned", classifyNeed("W28N3", ctx) === "military");
check("remote candidate", classifyNeed("W27N7", ctx) === "remote");
check("owned room in remote range is not a remote", classifyNeed("W27N9", ctx) === "rescout");
check("expansion target", classifyNeed("W30N5", ctx) === "expansion");
check("never seen room: expansion", classifyNeed("W20N5", ctx) === "expansion");
check("unowned controller out of remote range: expansion", classifyNeed("W22N5", ctx) === "expansion");
check("highway out of every set: rescout", classifyNeed("W30N9", { ...ctx, intel: () => ({ controller: false }) }) === "rescout");

// --- Ranking --------------------------------------------------------------------------------------
const candidates = [
    { room: "W27N9", need: "rescout", age: 59000 },
    { room: "W27N8", need: "remote", age: 58500 },
    { room: "W27N7", need: "remote", age: 58400 },
    { room: "W30N5", need: "expansion", age: Infinity },
    { room: "W28N3", need: "military", age: 100 }
];
const ranked = rankCandidates(candidates.slice(), false).map(c => c.room);
check("rank: military > remote (oldest first) > expansion > rescout", ranked.join(",") === "W28N3,W27N8,W27N7,W30N5,W27N9", ranked.join(","));
const pressured = rankCandidates(candidates.slice(), true).map(c => c.room);
check("CPU pressure: military only", pressured.join(",") === "W28N3", pressured.join(","));
const tie = rankCandidates([{ room: "W2N2", need: "remote", age: 5 }, { room: "W1N1", need: "remote", age: 5 }], false).map(c => c.room);
check("ties by name", tie.join(",") === "W1N1,W2N2", tie.join(","));

// --- Assignment -----------------------------------------------------------------------------------
const one = [{ id: "o1", room: "W27N5" }];
const a1 = assignObservations(one, rankCandidates(candidates.slice(), false), distance);
check("one room per observer and tick", a1.length === 1 && a1[0].room === "W28N3", JSON.stringify(a1));
const far = assignObservations(one, [{ room: "W10N5", need: "military", age: 1 }, { room: "W27N7", need: "remote", age: 1 }], distance);
check("out of range skipped, next in range taken", far.length === 1 && far[0].room === "W27N7", JSON.stringify(far));
check("range edge: distance 10 observed", assignObservations(one, [{ room: "W17N5", need: "rescout", age: 1 }], distance).length === 1);
check("range edge: distance 11 not observed", assignObservations(one, [{ room: "W16N5", need: "rescout", age: 1 }], distance).length === 0);
const two = [
    { id: "a", room: "W27N5" },
    { id: "b", room: "W10N5" }
];
const a2 = assignObservations(two, [{ room: "W12N5", need: "military", age: 1 }, { room: "W27N7", need: "remote", age: 1 }, { room: "W26N6", need: "rescout", age: 1 }], distance);
check(
    "two observers: closest observer per room, each room once",
    a2.length === 2 && a2.find(x => x.room === "W12N5")?.observer === "b" && a2.find(x => x.room === "W27N7")?.observer === "a",
    JSON.stringify(a2)
);
const a3 = assignObservations(two, [{ room: "W19N5", need: "remote", age: 1 }, { room: "W18N5", need: "remote", age: 1 }], distance);
check("both in range of both: each observer one room", a3.length === 2 && new Set(a3.map(x => x.observer)).size === 2, JSON.stringify(a3));
check("no observer: nothing", assignObservations([], candidates, distance).length === 0);

// --- Scout exclusion ------------------------------------------------------------------------------
check("covered within 10", coveredByObserver("W27N9", ["W27N5"], distance));
check("not covered beyond 10", !coveredByObserver("W38N5", ["W27N5"], distance));
check("not covered without observer", !coveredByObserver("W27N9", [], distance));

if (failures > 0) {
    console.log(`${failures} failure(s)`);
    process.exit(1);
}
console.log("all observer checks passed");
