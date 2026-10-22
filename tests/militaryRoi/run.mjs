/**
 * Offline check of military/roi: a target is only attacked automatically when what it brings (loot in
 * energy, remote income a stronghold blocks, a player's infamy) pays for the squad and its
 * replacements; the best return wins, the current target is kept unless another does clearly better.
 *
 *   node tests/militaryRoi/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-militaryroi-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--rootDir", join(ROOT, "src"), "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash",
            join(ROOT, "src", "military", "roi.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside these files (global declarations) don't prevent emitting
}

const { squadCost, remoteValue, lootValue, targetValue, pickTarget, ATTRITION, MIN_ROI, CURRENT_BONUS } = require(join(OUT, "military", "roi.js"));

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
    if (!ok) failures++;
};

// Squad cost: every member's body, ATTRITION times (replacements of the creeps lost)
check("ATTRITION is 2", ATTRITION === 2);
check("squad cost: 4 members of 1000", squadCost([1000, 1000, 1000, 1000]) === 8000, squadCost([1000, 1000, 1000, 1000]));
// RCL 7 quad (mockup W7N3 --preset rcl7, 5600 capacity): ~4000 per member
const quadRcl7 = squadCost([4000, 4000, 4000, 4000]);

// Loot in energy: market price ratio, 1 without prices
const prices = { energy: 1, purifier: 40, utrium_bar: 20 };
check("loot value with prices", lootValue({ purifier: 22, energy: 100 }, r => prices[r] ?? 1) === 22 * 40 + 100);
check("loot value without prices", lootValue({ purifier: 22 }, () => 1) === 22);

// Remote income a stronghold blocks: 3 energy/tick per source, until its collapse, at most 10000 ticks
check("remote value: 2 sources, collapse far", remoteValue(2, 70000) === 2 * 3 * 10000, remoteValue(2, 70000));
check("remote value: collapse in 1000 ticks", remoteValue(2, 1000) === 6000);
check("remote value: no source", remoteValue(0, 70000) === 0);
check("remote value: already collapsed", remoteValue(2, -50) === 0);

// Level 1 stronghold with no source around (only its loot): not worth a quad
const lone = targetValue({ loot: 100, remote: 0, infamy: 0 }) / quadRcl7;
check("L1 stronghold without remote: ROI < 1", lone < MIN_ROI, lone.toFixed(3));
// Same stronghold in a two-source room next to ours, collapse far away: worth it (mockup W7N4)
const blocking = targetValue({ loot: 100, remote: remoteValue(2, 70000), infamy: 0 }) / quadRcl7;
check("L1 stronghold blocking 2 sources: ROI >= 1", blocking >= MIN_ROI, blocking.toFixed(2));
// Collapsing soon: the remote frees itself
const collapsing = targetValue({ loot: 100, remote: remoteValue(2, 1000), infamy: 0 }) / quadRcl7;
check("stronghold collapsing in 1000 ticks: ROI < 1", collapsing < MIN_ROI, collapsing.toFixed(2));

// Picking: best ROI at least MIN_ROI, the current target kept unless another beats it x CURRENT_BONUS
check("CURRENT_BONUS is 1.5", CURRENT_BONUS === 1.5);
const a = { room: "A", roi: 1.5 };
const b = { room: "B", roi: 2.0 };
const c = { room: "C", roi: 2.5 };
check("nothing pays: no target", pickTarget([{ room: "X", roi: 0.4 }], undefined) === null);
check("best ROI wins", pickTarget([a, b, c], undefined)?.room === "C");
check("current kept against a slightly better one", pickTarget([a, b], "A")?.room === "A");
check("current replaced by a clearly better one", pickTarget([a, c], "A")?.room === "C");
check("current below MIN_ROI dropped", pickTarget([{ room: "A", roi: 0.8 }], "A") === null);

// --- Raids: rooms with loot and no defense, looted without a squad ---
const { isRaidable, lootersNeeded, raidCost, RAID_MIN_LOOT, RAID_INTEL_AGE } = require(join(OUT, "military", "roi.js"));
const NOW = 100000;
const MAX_BARRIER = 200000;
const abandoned = { t: NOW - 100, loot: 50000, towers: 0, spawns: 0, barrier: 0, damage: 0, heal: 0 };
check("RAID_MIN_LOOT is 10000", RAID_MIN_LOOT === 10000);
check("raid: abandoned storage, no tower", isRaidable(abandoned, NOW, MAX_BARRIER));
check("raid: towers with energy", !isRaidable({ ...abandoned, towers: 1, towerEnergy: 500 }, NOW, MAX_BARRIER));
check("raid: empty tower", isRaidable({ ...abandoned, towers: 1, towerEnergy: 0 }, NOW, MAX_BARRIER));
check("raid: armed creeps seen", !isRaidable({ ...abandoned, damage: 30 }, NOW, MAX_BARRIER));
check("raid: safe mode", !isRaidable({ ...abandoned, safeMode: NOW + 10 }, NOW, MAX_BARRIER));
check("raid: stronghold", !isRaidable({ ...abandoned, coreLevel: 1 }, NOW, MAX_BARRIER));
check("raid: rampart too strong to dismantle", !isRaidable({ ...abandoned, lootBarrier: 300000 }, NOW, MAX_BARRIER));
check("raid: rampart a dismantler opens", isRaidable({ ...abandoned, lootBarrier: 100000 }, NOW, MAX_BARRIER));
check("raid: too little loot", !isRaidable({ ...abandoned, loot: 5000 }, NOW, MAX_BARRIER));
check("raid: stale intel", !isRaidable({ ...abandoned, t: NOW - RAID_INTEL_AGE - 1 }, NOW, MAX_BARRIER));

// Looters (Overmind DirectiveHaul): amount x 2 x route tiles / (1500 x capacity), 1 to 3
check("looters: 50k one room away, 1250 capacity", lootersNeeded(50000, 1, 1250) === 3, lootersNeeded(50000, 1, 1250));
check("looters: 1000 units", lootersNeeded(1000, 1, 1250) === 1);
check("looters: nothing left", lootersNeeded(0, 1, 1250) === 0);
// Cost: looters + a dismantler when ramparts cover the loot
check("raid cost with ramparts", raidCost(50000, 1, 2500, 1250, 3750, true) === 3 * 2500 + 3750, raidCost(50000, 1, 2500, 1250, 3750, true));
check("raid cost without ramparts", raidCost(50000, 1, 2500, 1250, 3750, false) === 3 * 2500);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
