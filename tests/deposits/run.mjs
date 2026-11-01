/**
 * Offline check of highway/depositPlan: what a deposit harvester brings home in its life (cooldown and
 * travel), how many harvesters a deposit takes, and which deposit and home get picked.
 *
 *   node tests/deposits/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-deposits-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--rootDir", join(ROOT, "src"), "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash",
            join(ROOT, "src", "highway", "depositPlan.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside this file (global declarations) don't prevent emitting
}

const { lifetimeYield, harvestersFor, chooseDeposit, MAX_HARVESTERS } = require(join(OUT, "highway", "depositPlan.js"));

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
    if (!ok) failures++;
};

// Full 50-part body at 3000 energy (Hivemind weights CARRY 3, WORK 2): 10 WORK, 15 CARRY (750)
const body = { work: 10, carry: 15 };

// Fresh deposit, 3 rooms away (150 ticks): 75 harvests fill it in 75 ticks, 4 round trips of 375 ticks
check("fresh deposit: 4 full trips", lifetimeYield({ ...body, cooldown: 0, travel: 150 }) === 3000,
    String(lifetimeYield({ ...body, cooldown: 0, travel: 150 })));
// Cooldown 15: filling takes 1125 ticks, one trip of 1425, the 75 ticks left can't make another
check("cooldown 15: one trip", lifetimeYield({ ...body, cooldown: 15, travel: 150 }) === 750);
// Cooldown 40: never full, it comes back with what 1200 ticks at the deposit gave (30 harvests)
check("cooldown 40: one partial trip", lifetimeYield({ ...body, cooldown: 40, travel: 150 }) === 300);
// Too far for any harvest
check("out of reach: nothing", lifetimeYield({ ...body, cooldown: 0, travel: 800 }) === 0);

// Harvesters: enough to keep one at the deposit, capped by its free tiles and MAX_HARVESTERS
check("fresh deposit: capped by MAX_HARVESTERS", harvestersFor({ ...body, cooldown: 0, travel: 150 }, 8) === MAX_HARVESTERS);
check("fresh deposit: capped by free tiles", harvestersFor({ ...body, cooldown: 0, travel: 150 }, 1) === 1);
check("cooldown 15: two cover the trip", harvestersFor({ ...body, cooldown: 15, travel: 150 }, 8) === 2);

// Choice: best return (lifetime yield x price over the body cost), deposits too slow or dying left out
const now = 10000;
const deposit = (id, cooldown, extra = {}) =>
    ({ id, room: "W30N7", x: 10, y: 10, type: "silicon", cooldown, decayAt: now + 40000, free: 3, ...extra });
const homes = room => (room === "W30N2" ? [] : [{ name: "W29N7", travel: 150 }, { name: "W28N7", travel: 250 }]);
const price = type => (type === "metal" ? 2 : 1);
const pick = (candidates, minRoi = 1) => chooseDeposit(candidates, homes, price, body, 3000, now, minRoi);

let choice = pick([deposit("a", 0), deposit("b", 0, { type: "metal" })]);
check("picks the best paying deposit", choice?.id === "b", JSON.stringify(choice));
check("closest home", choice?.home === "W29N7" && choice?.travel === 150);
check("roi = yield x price / cost", choice?.roi === 2 && choice?.harvesters === MAX_HARVESTERS);
check("deposit beyond the cooldown limit left out", pick([deposit("c", 120)]) === null);
check("deposit decaying before a creep life left out", pick([deposit("d", 0, { decayAt: now + 1000 })]) === null);
check("deposit without a home left out", pick([deposit("e", 0, { room: "W30N2" })]) === null);
check("return below minRoi left out", pick([deposit("f", 15)]) === null);
check("minRoi 0 keeps it", pick([deposit("f", 15)], 0)?.id === "f");

if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
}
console.log("\nall checks passed");
