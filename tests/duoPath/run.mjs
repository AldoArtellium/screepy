/**
 * Offline check of military/duoPath: a duo's cached path is reused while the attacker walks it, and
 * searched again when the goal changes, the attacker is off it, the next tile is the healer's or leaves
 * the allowed rooms, a step stays blocked 3 ticks, or the path expires; and the still-creep detection.
 *
 *   node tests/duoPath/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-duopath-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--rootDir", join(ROOT, "src"), "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash",
            join(ROOT, "src", "military", "duoPath.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside this file (global declarations) don't prevent emitting
}

const { cachedStep, newPath, noteStep, stillFor, BLOCKED_TICKS, STILL_TICKS } = require(join(OUT, "military", "duoPath.js"));

let failures = 0;
function check(label, actual, expected) {
    const ok = Object.is(actual, expected);
    if (!ok) failures++;
    console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
}

const t = (x, y, roomName = "A") => ({ x, y, roomName });
const show = p => (p ? `${p.roomName}:${p.x}:${p.y}` : "null");
// A path from A (47,25) across the A/B border to B (2,25): PathFinder lists both exit tiles
const path = () => newPath("travel:B", t(47, 25), [t(48, 25), t(49, 25), t(0, 25, "B"), t(1, 25, "B"), t(2, 25, "B")], 100, 50);

console.log("Reuse");
{
    const cache = path();
    check("from the origin: first tile", show(cachedStep(cache, "travel:B", t(47, 25), 100)), "A:48:25");
    check("on the path: next tile", show(cachedStep(cache, "travel:B", t(48, 25), 101)), "A:49:25");
    check("carried over the border: next tile of B", show(cachedStep(cache, "travel:B", t(0, 25, "B"), 102)), "B:1:25");
    check("end of the path: search", show(cachedStep(cache, "travel:B", t(2, 25, "B"), 103)), "null");
}

console.log("Searched again");
{
    check("no cache", show(cachedStep(undefined, "travel:B", t(47, 25), 100)), "null");
    check("other goal", show(cachedStep(path(), "travel:C", t(47, 25), 100)), "null");
    check("expired", show(cachedStep(path(), "travel:B", t(47, 25), 150)), "null");
    check("still valid the tick before", show(cachedStep(path(), "travel:B", t(47, 25), 149)), "A:48:25");
    check("off the path", show(cachedStep(path(), "travel:B", t(47, 24), 101)), "null");
    check("next tile is the healer's", show(cachedStep(path(), "travel:B", t(48, 25), 101, t(49, 25))), "null");
    check("healer elsewhere", show(cachedStep(path(), "travel:B", t(48, 25), 101, t(47, 25))), "A:49:25");
    check("route no longer allows B", show(cachedStep(path(), "travel:B", t(48, 25), 101, undefined, new Set(["A", "C"]))), "null");
    check("route allows A and B", show(cachedStep(path(), "travel:B", t(48, 25), 101, undefined, new Set(["A", "B"]))), "A:49:25");
}

console.log("Blocked steps");
{
    const cache = path();
    let tick = 100;
    let step = cachedStep(cache, "travel:B", t(47, 25), tick);
    let blockedAt = null;
    for (let i = 1; i <= 5 && step; i++) {
        noteStep(cache, t(47, 25), tick);
        tick++;
        step = cachedStep(cache, "travel:B", t(47, 25), tick);
        if (!step && blockedAt === null) blockedAt = i;
    }
    check(`searched again after ${BLOCKED_TICKS} blocked steps`, blockedAt, BLOCKED_TICKS);

    const moving = path();
    noteStep(moving, t(47, 25), 100);
    cachedStep(moving, "travel:B", t(48, 25), 101);
    check("a step that moved resets the count", moving.blocked, 0);

    const holding = path();
    for (let i = 0; i < 5; i++) cachedStep(holding, "travel:B", t(47, 25), 100 + i);
    check("holding without a requested step never counts", holding.blocked, 0);
}

console.log("Still creep");
{
    const state = { pos: "", since: 0, seen: 0 };
    let firedAt = null;
    for (let tick = 1; tick <= 120; tick++) if (stillFor(state, t(10, 10), tick, STILL_TICKS) && firedAt === null) firedAt = tick;
    check(`fires after ${STILL_TICKS} ticks on the same tile`, firedAt, 1 + STILL_TICKS);

    const moving = { pos: "", since: 0, seen: 0 };
    let fired = false;
    for (let tick = 1; tick <= 120; tick++) fired = stillFor(moving, t(10 + (tick % 2), 10), tick, STILL_TICKS) || fired;
    check("a moving creep never fires", fired, false);

    const gap = { pos: "", since: 0, seen: 0 };
    fired = false;
    for (let tick = 1; tick <= 120; tick++) if (tick !== 40) fired = stillFor(gap, t(10, 10), tick, STILL_TICKS) || fired;
    check("an untracked tick restarts the count", gap.since, 91);
}

console.log(failures ? `\n${failures} failure(s)` : "\nall ok");
process.exit(failures ? 1 : 0);
