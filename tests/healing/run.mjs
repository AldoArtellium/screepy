/**
 * Offline check of core/patients: which wounded creep an idle healer heals, and how far a keeper killer
 * waiting for a lair may walk to heal.
 *
 *   node tests/healing/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-healing-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--rootDir", join(ROOT, "src"), "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash",
            join(ROOT, "src", "core", "patients.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside this file (global declarations) don't prevent emitting
}

const { pickPatient, roamRange, DANGER_RANGE } = require(join(OUT, "core", "patients.js"));

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
    if (!ok) failures++;
};

const healer = { x: 25, y: 25 };
const creep = (id, x, y, hits, hitsMax = 1000) => ({ id, x, y, hits, hitsMax });

check("nobody wounded: none", pickPatient(healer, []) === undefined);
check("full creeps are skipped", pickPatient(healer, [creep("a", 26, 25, 1000)]) === undefined);
check(
    "most hits missing first",
    pickPatient(healer, [creep("near", 26, 25, 900), creep("far", 40, 40, 300)])?.id === "far"
);
check(
    "tie: the closest",
    pickPatient(healer, [creep("far", 40, 40, 500), creep("near", 27, 25, 500)])?.id === "near"
);
check(
    "the healer itself counts",
    pickPatient(healer, [creep("self", 25, 25, 200), creep("other", 26, 25, 900)])?.id === "self"
);
check(
    "beyond maxRange: skipped",
    pickPatient(healer, [creep("far", 40, 40, 100), creep("near", 27, 25, 900)], [], 3)?.id === "near"
);
// A remote harvester next to a live keeper (W26N5 kind of room): the healer would walk into its reach
const keeper = { x: 10, y: 10 };
check(
    `within ${DANGER_RANGE} of a hostile: skipped`,
    pickPatient(healer, [creep("byKeeper", 12, 13, 100), creep("safe", 30, 30, 800)], [keeper])?.id === "safe"
);
check(
    `just beyond ${DANGER_RANGE} of a hostile: healed`,
    pickPatient(healer, [creep("ok", 10, 10 + DANGER_RANGE + 1, 100)], [keeper])?.id === "ok"
);
check("only patients by a hostile: none", pickPatient(healer, [creep("byKeeper", 11, 11, 100)], [keeper]) === undefined);

console.log("\nkeeper killer roam range");
check("no lair to wait for: unbounded", roamRange(undefined) === Infinity);
check("keeper spawning now: stays", roamRange(0) === 0);
check("keeper in 30 ticks: 10 tiles", roamRange(30) === 10, String(roamRange(30)));
check("keeper in 300 ticks: 145 tiles", roamRange(300) === 145, String(roamRange(300)));

console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
