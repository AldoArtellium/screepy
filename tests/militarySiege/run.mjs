/**
 * Offline check of military/siegeModel: CLAIM parts per capacity, ticks to bring a controller to level 0
 * by attacking it every 1000 ticks (each CLAIM part -300 ticks, the timer restarted at half the new level's
 * on a drop, overshoot carried over), siege cost and the spawn timing of the siege creeps.
 *
 *   node tests/militarySiege/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-militarysiege-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--rootDir", join(ROOT, "src"), "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash",
            join(ROOT, "src", "military", "siegeModel.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside this file (global declarations) don't prevent emitting
}

const {
    siegeClaimParts,
    siegeTicks,
    siegeCost,
    claimerCost,
    arrivalTicks,
    attackerDue,
    guardDue,
    DOWNGRADE_TICKS,
    SIEGE_MAX_TICKS
} = require(join(OUT, "military", "siegeModel.js"));

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail !== undefined ? `: ${detail}` : ""}`);
    if (!ok) failures++;
};

// CLAIM parts: one CLAIM + MOVE pair per 650 energy, at most 25
check("claim parts: RCL 7 capacity 5600 -> 8", siegeClaimParts(5600) === 8, siegeClaimParts(5600));
check("claim parts: RCL 8 capacity 12900 -> 19", siegeClaimParts(12900) === 19, siegeClaimParts(12900));
check("claim parts: capped at 25", siegeClaimParts(30000) === 25, siegeClaimParts(30000));
check("claim parts: 600 -> 0", siegeClaimParts(600) === 0, siegeClaimParts(600));
check("claimer cost: 8 parts 5200", claimerCost(8) === 5200);

// RCL 2, full timer (10000), 8 parts: 3400 per cycle; drop to 1 at 2800 (timer 10000), level 0 at 5600
const rcl2 = siegeTicks(2, DOWNGRADE_TICKS[2], 8);
check("RCL 2 full timer, 8 parts: 5600 ticks", rcl2 === 5600, rcl2);
// RCL 1 alone: 10000 ticks left, 8 parts
const rcl1 = siegeTicks(1, 10000, 8);
check("RCL 1 10000 left, 8 parts: 2800 ticks", rcl1 === 2800, rcl1);
// RCL 4 full timer (40000), 8 parts: ~19k ticks
const rcl4 = siegeTicks(4, DOWNGRADE_TICKS[4], 8);
check("RCL 4 full timer, 8 parts: 19000 ticks", rcl4 === 19000, rcl4);
// RCL 4 with 19 parts (RCL 8 base): faster
const rcl4big = siegeTicks(4, DOWNGRADE_TICKS[4], 19);
check("RCL 4 full timer, 19 parts: 9000 ticks (two levels drop on one attack at 7000)", rcl4big === 9000, rcl4big);
// RCL 5 full timer, 8 parts: 80000 + 20000 + 10000 + 5000 + 10000 timer ticks at 3400 a cycle
const rcl5 = siegeTicks(5, DOWNGRADE_TICKS[5], 8);
check("RCL 5 full timer, 8 parts: 36200 ticks, within the max", rcl5 === 36200 && rcl5 <= SIEGE_MAX_TICKS, rcl5);
const rcl6 = siegeTicks(6, DOWNGRADE_TICKS[6], 8);
check("RCL 6 full timer, 8 parts: 60000 ticks, at the max", rcl6 === 60000, rcl6);
const rcl7 = siegeTicks(7, DOWNGRADE_TICKS[7], 8);
check("RCL 7 full timer, 8 parts: over the max", rcl7 > SIEGE_MAX_TICKS, rcl7);
const rcl6big = siegeTicks(6, DOWNGRADE_TICKS[6], 25);
check("RCL 6 full timer, 25 parts: within the max", rcl6big <= SIEGE_MAX_TICKS, rcl6big);
const rcl8 = siegeTicks(8, DOWNGRADE_TICKS[8], 25);
check("RCL 8 full timer, 25 parts: 49000 ticks, within the max", rcl8 === 49000, rcl8);
// Mockup enemy (downgradeTime +100000 at RCL 2 by default): 32000 ticks
check("RCL 2 with 100000 ticks left, 8 parts: 32000 ticks", siegeTicks(2, 100000, 8) === 32000, siegeTicks(2, 100000, 8));
// One attack overshooting the timer drops the level at once (and the overshoot carries over)
check("RCL 1 with 2000 left, 8 parts: 0 ticks (first attack)", siegeTicks(1, 2000, 8) === 0, siegeTicks(1, 2000, 8));
check("RCL 2 with 2000 left, 8 parts: drop now, level 1 from 9600, level 0 at 3000", siegeTicks(2, 2000, 8) === 3000, siegeTicks(2, 2000, 8));
// More parts never take longer
let monotonic = true;
for (let level = 1; level <= 8; level++)
    for (let parts = 1; parts < 25; parts++)
        if (siegeTicks(level, DOWNGRADE_TICKS[level], parts + 1) > siegeTicks(level, DOWNGRADE_TICKS[level], parts)) monotonic = false;
check("more CLAIM parts never take longer", monotonic);
check("no CLAIM part: Infinity", siegeTicks(3, 20000, 0) === Infinity);
check("level 0: 0", siegeTicks(0, 0, 5) === 0);

// Cost: a claimer per 1000 ticks, a guard per 1500
check("siege cost: 5600 ticks, 5200 claimer, 2000 guard", siegeCost(5600, 5200, 2000) === 6 * 5200 + 4 * 2000, siegeCost(5600, 5200, 2000));
check("siege cost: 19000 ticks", siegeCost(19000, 5200, 2000) === 19 * 5200 + 13 * 2000, siegeCost(19000, 5200, 2000));
check("siege cost: Infinity", siegeCost(Infinity, 5200, 2000) === Infinity);

// Spawn timing
check("arrival: 2 rooms (+1 for the walks inside), 16 parts", arrivalTicks(2, 16) === 198, arrivalTicks(2, 16));
check("attacker due 240 ticks before the block ends (arrival 198 + margin 50)", attackerDue(1240, 1000, 198) === true);
check("attacker not due 300 ticks before", attackerDue(1300, 1000, 198) === false);
check("attacker due when the block already ended", attackerDue(900, 1000, 198) === true);
check("guard replaced when its life is shorter than the arrival", guardDue(100, 198) === true);
check("guard kept", guardDue(500, 198) === false);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
