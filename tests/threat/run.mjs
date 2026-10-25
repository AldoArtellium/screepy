/**
 * Offline check of defense/threatModel: the threat order of the creeps doorknobnob sent to shard0 W28N7
 * (2026-10-24, bodies from the room history) and a few edge cases.
 *
 *   node tests/threat/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-threat-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash",
            join(ROOT, "src", "defense", "threatModel.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside these files (global declarations) don't prevent emitting
}

const { threatScore, ownThreat } = require(join(OUT, "threatModel.js"));

// Powers as creepPower gives them: WORK 50 (dismantle), ATTACK 30, RANGED_ATTACK 10, HEAL 12
const idle = { active: false, critical: false, patientThreat: 0 };
const dismantler = { ...idle, power: 8 * 50, heal: 0 }; // 8 WORK 8 MOVE
const decoy = { ...idle, power: 50, heal: 0 }; // WORK MOVE
const blocker = { ...idle, power: 0, heal: 0 }; // MOVE
const medic = { ...idle, power: 0, heal: 4 * 12 }; // 4 HEAL 4 MOVE
const sniper = { ...idle, power: 6 * 10, heal: 0 }; // 6 RANGED_ATTACK 6 MOVE

let failures = 0;
function check(label, ok, detail) {
    console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
    if (!ok) failures++;
}
const score = (c) => threatScore(c);

const working = { ...dismantler, active: true };
const decoyOnRampart = { ...decoy, active: true };
check("dismantler on a rampart > decoy on a rampart", score(working) > score(decoyOnRampart), `${score(working)} vs ${score(decoyOnRampart)}`);
check("dismantler walking in > decoy on a rampart", score(dismantler) > score(decoyOnRampart), `${score(dismantler)} vs ${score(decoyOnRampart)}`);
check("dismantler on a rampart > dismantler walking in", score(working) > score(dismantler));
check("next to the spawn > elsewhere", score({ ...working, critical: true }) > score(working));
check("blocker scores 0", score(blocker) === 0);
check("idle medic: its heal only", score(medic) === 48);
const busyMedic = { ...medic, patientThreat: ownThreat(working) };
check("medic of a working dismantler > decoy on a rampart", score(busyMedic) > score(decoyOnRampart), `${score(busyMedic)}`);
check("working dismantler > its medic", score(working) > score(busyMedic), `${score(working)} vs ${score(busyMedic)}`);
check("sniper shooting > idle sniper", score({ ...sniper, active: true }) > score(sniper));
check("boosted dismantler (XZH2O x4) > plain", score({ ...working, power: working.power * 4 }) > score(working));

console.log(failures ? `${failures} failure(s)` : "all checks passed");
process.exit(failures ? 1 : 0);
