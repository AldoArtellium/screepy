/**
 * Offline check of military/targetChoice: a squad goes for armed towers and the invader core, then
 * spawns, then empty towers, extensions, storage / terminal, loot ramparts and the rest; within the best
 * class present, the cheapest to break ((cover + own hits) / dps + range), ties to the closest.
 *
 *   node tests/militaryTargets/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-militarytargets-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--rootDir", join(ROOT, "src"), "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash",
            join(ROOT, "src", "military", "targetChoice.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside this file (global declarations) don't prevent emitting
}

const { chooseTarget, targetClass, targetCost, barrierCost, TARGET_CLASS, MIN_TOWER_ENERGY } = require(join(OUT, "military", "targetChoice.js"));

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
    if (!ok) failures++;
};

const DPS = 1500; // RCL 7 quad, unboosted: 2 attackers of 25 ATTACK x 30
const t = (id, cls, hits, coverHits, range) => ({ id, cls, hits, coverHits, range });
const pick = (targets, dps = DPS) => chooseTarget(targets, dps)?.id ?? null;

// Classes
check("class: tower with energy is armed", targetClass("tower", MIN_TOWER_ENERGY) === TARGET_CLASS.armed);
check("class: tower below 10 energy is empty", targetClass("tower", MIN_TOWER_ENERGY - 1) === TARGET_CLASS.emptyTower);
check("class: invader core is armed", targetClass("invaderCore") === TARGET_CLASS.armed);
check("class: spawn", targetClass("spawn") === TARGET_CLASS.spawn);
check("class: extension", targetClass("extension") === TARGET_CLASS.extension);
check("class: storage and terminal", targetClass("storage") === TARGET_CLASS.store && targetClass("terminal") === TARGET_CLASS.store);
check("class: anything else last", targetClass("lab") === TARGET_CLASS.other && TARGET_CLASS.other > TARGET_CLASS.lootRampart);

// Class order wins over cost
check(
    "armed tower beats a closer, open spawn",
    pick([t("spawn", TARGET_CLASS.spawn, 5000, 0, 2), t("tower", TARGET_CLASS.armed, 3000, 3_000_000, 20)]) === "tower"
);
check(
    "spawn beats a closer empty tower",
    pick([t("empty", TARGET_CLASS.emptyTower, 3000, 0, 1), t("spawn", TARGET_CLASS.spawn, 5000, 1_000_000, 15)]) === "spawn"
);
check(
    "empty tower beats extensions",
    pick([t("ext", TARGET_CLASS.extension, 1000, 0, 1), t("empty", TARGET_CLASS.emptyTower, 3000, 0, 10)]) === "empty"
);
check(
    "loot rampart only after storage",
    pick([t("loot", TARGET_CLASS.lootRampart, 10000, 0, 1), t("store", TARGET_CLASS.store, 10000, 0, 30)]) === "store"
);

// Within a class: cost (shard0: a tower behind 10M chosen over one behind 100k a few tiles further)
const close = t("close", TARGET_CLASS.armed, 3000, 10_000_000, 5);
const far = t("far", TARGET_CLASS.armed, 3000, 100_000, 12);
check("cost: (cover + hits) / dps + range", targetCost(far, DPS) === 103_000 / DPS + 12, targetCost(far, DPS));
check("weakly covered far tower beats a heavily covered close one", pick([close, far]) === "far");
check("order of the list does not matter", pick([far, close]) === "far");
// Cheap covers: the range decides
check("open towers: the closest", pick([t("a", 0, 3000, 0, 9), t("b", 0, 3000, 0, 4)]) === "b");

// Ties go to the closest: 100 hits / 100 dps + 5 = 200 / 100 + 4 = 6
const tieFar = t("tieFar", TARGET_CLASS.spawn, 100, 0, 5);
const tieClose = t("tieClose", TARGET_CLASS.spawn, 200, 0, 4);
check("tie: same cost", targetCost(tieFar, 100) === targetCost(tieClose, 100));
check("tie goes to the closest", pick([tieFar, tieClose], 100) === "tieClose");
check("tie goes to the closest (other order)", pick([tieClose, tieFar], 100) === "tieClose");

// Edge cases
check("no target", chooseTarget([], DPS) === null);
check("dps 0 is treated as 1", Number.isFinite(targetCost(far, 0)));

// Barrier costs towards the controller: 1..254, by hits relative to the strongest barrier
check("barrier: strongest costs 254", barrierCost(300_000_000, 300_000_000) === 254);
check("barrier: weakest costs at least 1", barrierCost(1, 300_000_000) === 1);
check("barrier: half", barrierCost(150, 300) === 127, barrierCost(150, 300));
check("barrier: no max", barrierCost(0, 0) === 1);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
