/**
 * Offline check of highway/highwayIntel: deposits and power banks seen in highway rooms, which ones were
 * usable (close enough, cheap enough to harvest, enough time left), pruning and the rate per 10000 ticks.
 *
 *   node tests/highway/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-highway-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--rootDir", join(ROOT, "src"), "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash",
            join(ROOT, "src", "highway", "highwayIntel.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside this file (global declarations) don't prevent emitting
}

const { recordSightings, pruneHighwayLog, summarizeHighwayLog, HIGHWAY_LOG_KEEP } = require(join(OUT, "highway", "highwayIntel.js"));

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
    if (!ok) failures++;
};

const deposit = (id, cooldown, ticksToDecay = 40000) =>
    ({ id, kind: "deposit", x: 10, y: 10, type: "silicon", cooldown, ticksToDecay, free: 3 });
const bank = (id, power, ticksToDecay, free = 4) =>
    ({ id, kind: "powerBank", x: 20, y: 20, power, hits: 2000000, ticksToDecay, free });
const near = { name: "W29N7", distance: 1 };
const far = { name: "W29N7", distance: 5 };

// First sighting creates the entry, with the home and the decay tick
let log = { since: 1000, objects: {} };
recordSightings(log, "W30N7", [deposit("d1", 12)], 1000, near);
const d1 = log.objects.d1;
check("deposit recorded", !!d1 && d1.room === "W30N7" && d1.firstSeen === 1000 && d1.decayAt === 41000, JSON.stringify(d1));
check("close cheap deposit usable", d1?.usable === true);

// A later sighting updates lastSeen and cooldown, keeps firstSeen; once usable stays usable
recordSightings(log, "W30N7", [deposit("d1", 120, 30000)], 5000, near);
check("resighting keeps firstSeen", log.objects.d1.firstSeen === 1000 && log.objects.d1.lastSeen === 5000);
check("cooldown updated", log.objects.d1.cooldown === 120);
check("usable is sticky", log.objects.d1.usable === true);

// Expensive or far deposits are not usable
recordSightings(log, "W30N8", [deposit("d2", 80)], 1000, near);
recordSightings(log, "W30N3", [deposit("d3", 5)], 1000, far);
recordSightings(log, "W30N2", [deposit("d4", 5)], 1000, undefined);
check("deposit with a high cooldown not usable", log.objects.d2.usable === false);
check("deposit too far not usable", log.objects.d3.usable === false);
check("deposit with no home not usable", log.objects.d4.usable === false && log.objects.d4.home === undefined);

// Power banks: enough power, enough time left, at least 2 attack tiles
recordSightings(log, "W30N6", [bank("p1", 3000, 4500)], 1000, near);
recordSightings(log, "W30N6", [bank("p2", 500, 4500)], 1000, near);
recordSightings(log, "W30N6", [bank("p3", 3000, 1000)], 1000, near);
recordSightings(log, "W30N6", [bank("p4", 3000, 4500, 1)], 1000, near);
check("big fresh power bank usable", log.objects.p1.usable === true, JSON.stringify(log.objects.p1));
check("small power bank not usable", log.objects.p2.usable === false);
check("decaying power bank not usable", log.objects.p3.usable === false);
check("power bank with one free tile not usable", log.objects.p4.usable === false);

// A bank first seen late is judged on its first sighting only (its ticks left only shrink)
recordSightings(log, "W30N6", [bank("p3", 3000, 900)], 1100, near);
check("power bank stays unusable", log.objects.p3.usable === false);

// Summary: rate per 10000 ticks since the log started
const summary = summarizeHighwayLog(log, 11000);
check("summary ticks", summary.ticks === 10000, JSON.stringify(summary));
check("summary deposit counts", summary.deposits === 4 && summary.usableDeposits === 1);
check("summary power bank counts", summary.powerBanks === 4 && summary.usablePowerBanks === 1);
check("summary rates", summary.usableDepositsPer10k === 1 && summary.usablePowerBanksPer10k === 1);

// Pruning: entries gone (decayed or unseen) for HIGHWAY_LOG_KEEP ticks are dropped, recent ones kept
log = { since: 0, objects: {} };
recordSightings(log, "W30N7", [bank("old", 3000, 4000)], 1000, near);
recordSightings(log, "W30N7", [deposit("recent", 5, 40000)], 1000, near);
pruneHighwayLog(log, 5000 + HIGHWAY_LOG_KEEP + 1);
check("decayed bank pruned", !log.objects.old);
check("living deposit kept", !!log.objects.recent);

// Pruning never moves the summary window start
check("since unchanged by pruning", log.since === 0);

if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
}
console.log("\nall checks passed");
