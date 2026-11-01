/**
 * Offline check of expansion/mineralValue: the expansion score weighs a room's mineral by its market
 * price against the other base minerals. Prices from shard0 on 2026-11-01 (7-day averages).
 *
 *   node tests/mineralValue/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-mineral-value-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--rootDir", join(ROOT, "src"), "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash",
            join(ROOT, "src", "expansion", "mineralValue.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside this file (global declarations) don't prevent emitting
}

const { mineralValueFactor, mineralScore, MIN_VALUE_FACTOR, MAX_VALUE_FACTOR } = require(join(OUT, "expansion", "mineralValue.js"));

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
    if (!ok) failures++;
};

// shard0 2026-11-01, base mineral 7-day averages
const prices = { H: 273.5, O: 553.2, U: 112.5, L: 688.4, K: 67.3, Z: 152.6, X: 691.3 };
const price = r => prices[r];
const near = (a, b) => Math.abs(a - b) < 1e-6;

check("the median base mineral (H) is worth 1", near(mineralValueFactor("H", price), 1), mineralValueFactor("H", price));
check("O at 2.02x the median: capped at 2", mineralValueFactor("O", price) === MAX_VALUE_FACTOR);
check("Z between floor and cap: price over median", near(mineralValueFactor("Z", price), 152.6 / 273.5));
check("L and X capped", mineralValueFactor("L", price) === MAX_VALUE_FACTOR && mineralValueFactor("X", price) === MAX_VALUE_FACTOR);
check("K floored", mineralValueFactor("K", price) === MIN_VALUE_FACTOR);
check("ranking X/L > O > H > Z > U > K", ["X", "O", "H", "Z", "U", "K"].every((r, i, a) => i === 0 || mineralValueFactor(a[i - 1], price) >= mineralValueFactor(r, price)));
check("without a price the mineral counts 1 (old behaviour)", mineralValueFactor("H", () => undefined) === 1);
check("a missing price among the others is ignored", near(mineralValueFactor("O", r => (r === "Z" ? undefined : prices[r])), 553.2 / ((273.5 + 553.2) / 2)));

// Score term: value over (rooms already on that mineral + 1), the old term was 1 / (owned + 1)
check("new mineral, median value: old score", near(mineralScore("H", 0, price), 1));
check("a fourth H room is worth less than a first O room", mineralScore("H", 3, price) < mineralScore("O", 0, price));
check("a first L room beats a first H room by the cap", near(mineralScore("L", 0, price) / mineralScore("H", 0, price), MAX_VALUE_FACTOR));
check("shard0: a 4th H room scores 0.25, a first X room 2", near(mineralScore("H", 3, price), 0.25) && near(mineralScore("X", 0, price), 2));

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
