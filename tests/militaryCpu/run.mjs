/**
 * Offline check of military/cpuGuard: the Military module's CPU average and when a mission costs too much
 * CPU for the account. Case from shard0 on 2026-10-25 (W27N9 quad: ~5.3 CPU per tick at a 20 CPU limit).
 *
 *   node tests/militaryCpu/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-militarycpu-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--rootDir", join(ROOT, "src"), "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash",
            join(ROOT, "src", "military", "cpuGuard.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside this file (global declarations) don't prevent emitting
}

const { militaryCpuAverage, militaryCpuTooHigh } = require(join(OUT, "military", "cpuGuard.js"));

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
    if (!ok) failures++;
};

// Average: a 30 CPU spike barely moves it, a steady 5.3 gets there within ~1000 ticks
let avg = militaryCpuAverage(undefined, 0.1);
avg = militaryCpuAverage(avg, 30);
check("one 30 CPU spike stays under 0.2", avg < 0.2, avg.toFixed(3));
for (let i = 0; i < 1000; i++) avg = militaryCpuAverage(avg, 5.3);
check("1000 ticks at 5.3 reach over 4", avg > 4, avg.toFixed(2));

// Guard: over 15% of the limit while the bucket is low
check("shard0: 5.3 / 20 with a 5271 bucket: abandon", militaryCpuTooHigh(5.3, 20, 5271));
check("5.3 / 20 with a 8000 bucket: keep (the account still has CPU)", !militaryCpuTooHigh(5.3, 20, 8000));
check("2.5 / 20 with a 2500 bucket: keep (12.5%)", !militaryCpuTooHigh(2.5, 20, 2500));
check("5.3 / 300 (subscription): keep", !militaryCpuTooHigh(5.3, 300, 2500));
check("no average yet: keep", !militaryCpuTooHigh(undefined, 20, 0));

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
