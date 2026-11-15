/**
 * Offline check of military/safeMode: the safe mode phase of a player room (on, cooldown closing, window
 * where none can be activated, a charge armed), what a target gets in each phase (squad, bait or wait),
 * and the refill of engaged targets that never keeps one under safe mode.
 *
 *   node tests/safeMode/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-safemode-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--rootDir", join(ROOT, "src"), "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash",
            join(ROOT, "src", "military", "safeMode.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside this file (global declarations) don't prevent emitting
}

const { safeModePhase, attackMode, refillEngaged, SAFE_WINDOW_MIN, MAX_BAIT_FAILURES } = require(join(OUT, "military", "safeMode.js"));

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail !== undefined ? `: ${detail}` : ""}`);
    if (!ok) failures++;
};

const now = 1000000;

// shard0 W25N7 2026-11-14: safe mode 79041260 -> 79061260, cooldown to 79091260, 4 charges left
const w25n7 = { safeMode: 79061260, safeModeCooldown: 79091260, safeModeAvailable: 4 };
check("W25N7 during its safe mode: active", safeModePhase(w25n7, 79050000) === "active");
check("W25N7 right after its safe mode: window (30000 ticks without one)", safeModePhase(w25n7, 79061300) === "window");
check(
    "W25N7 near the cooldown end: closing (a mission would meet a fresh safe mode)",
    safeModePhase(w25n7, 79091260 - SAFE_WINDOW_MIN + 1) === "closing"
);
check("W25N7 after the cooldown: armed", safeModePhase(w25n7, 79091300) === "armed");
check("charge available, no cooldown: armed", safeModePhase({ safeModeAvailable: 2 }, now) === "armed");
check("no charge left: window", safeModePhase({ safeModeAvailable: 0 }, now) === "window");
check("no charge left but safe mode on: active", safeModePhase({ safeMode: now + 10, safeModeAvailable: 0 }, now) === "active");
check("charges unknown (old record): window, the former behaviour", safeModePhase({}, now) === "window");
check("long cooldown, no safe mode on: window", safeModePhase({ safeModeCooldown: now + SAFE_WINDOW_MIN, safeModeAvailable: 3 }, now) === "window");

check("window: squad", attackMode("window", 0) === "squad");
check("armed: bait first", attackMode("armed", 0) === "bait");
check(`armed after ${MAX_BAIT_FAILURES} failed baits: squad (the owner doesn't react to a bait)`, attackMode("armed", MAX_BAIT_FAILURES) === "squad");
check("active: wait", attackMode("active", 0) === "wait");
check("closing: wait", attackMode("closing", 0) === "wait");

// shard0 2026-11-14: W25N7 safe-moded, released by targetStillHeld, then re-added by the refill of
// targets with a mission: the quad poked under safe mode ~310 ticks until watchDrain abandoned it
const entries = [{ room: "W25N7" }, { room: "W28N8" }];
const withMission = room => room === "W25N7" || room === "W28N8";
const safeModed = room => room === "W25N7";
const refilled = refillEngaged([], entries, 2, withMission, safeModed).map(e => e.room);
check("a target under safe mode is not refilled", !refilled.includes("W25N7"), refilled.join(","));
// W28N8's last spawn fell (no longer a candidate) but its towers stand: its squad stays until the success
check("a target with a mission and no safe mode is refilled", refilled.includes("W28N8"), refilled.join(","));
const full = refillEngaged([{ room: "W29N4" }], entries, 1, withMission, () => false).map(e => e.room);
check("no refill past max", full.length === 1 && full[0] === "W29N4", full.join(","));
const noMission = refillEngaged([], entries, 2, () => false, () => false);
check("no refill without a mission", noMission.length === 0);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
