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

const { repairsDue, REPAIR_BATCH_HITS } = require(join(OUT, "remote", "repairs.js"));

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

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
