/**
 * Offline check of military/combat: healing, attack power and damage taken by boosted bodies, and
 * whether a quad out-heals the towers that focus its front (no border drain needed).
 *
 *   node tests/combat/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-combat-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--rootDir", join(ROOT, "src"), "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash",
            join(ROOT, "src", "military", "combat.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside this file (global declarations) don't prevent emitting
}

Object.assign(globalThis, {
    MOVE: "move", WORK: "work", CARRY: "carry", ATTACK: "attack", RANGED_ATTACK: "ranged_attack", HEAL: "heal", TOUGH: "tough",
    HEAL_POWER: 12, RANGED_HEAL_POWER: 4, ATTACK_POWER: 30, RANGED_ATTACK_POWER: 10,
    TOWER_POWER_ATTACK: 600, TOWER_OPTIMAL_RANGE: 5, TOWER_FALLOFF_RANGE: 20, TOWER_FALLOFF: 0.75, TOWER_ENERGY_COST: 10,
    BOOSTS: {
        heal: { LO: { heal: 2, rangedHeal: 2 }, LHO2: { heal: 3, rangedHeal: 3 }, XLHO2: { heal: 4, rangedHeal: 4 } },
        tough: { GO: { damage: 0.7 }, GHO2: { damage: 0.5 }, XGHO2: { damage: 0.3 } },
        attack: { UH: { attack: 2 }, UH2O: { attack: 3 }, XUH2O: { attack: 4 } },
        ranged_attack: { KO: { rangedAttack: 2, rangedMassAttack: 2 } },
    },
});

const { healPower, attackPower, damageMultiplier, canTank } = require(join(OUT, "military", "combat.js"));

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail !== undefined ? `: ${detail}` : ""}`);
    if (!ok) failures++;
};

const parts = (type, n, boost, hits = 100) => Array.from({ length: n }, () => ({ type, hits, ...(boost && { boost }) }));
// RCL 6 quad bodies (2300 energy, sizing.ts): attacker 5 TOUGH 15 ATTACK 20 MOVE, healer 6 HEAL 2 RANGED 8 MOVE
const healer = boost => [...parts("heal", 6, boost), ...parts("ranged_attack", 2), ...parts("move", 8)];
const attacker = (tough, attack) => [...parts("tough", 5, tough), ...parts("attack", 15, attack), ...parts("move", 20)];

// Healing: active HEAL parts x 12 x the boost's heal multiplier
check("unboosted healer heals 72", healPower(healer()) === 72, healPower(healer()));
check("XLHO2 healer heals 288", healPower(healer("XLHO2")) === 288, healPower(healer("XLHO2")));
check("LHO2 healer heals 216", healPower(healer("LHO2")) === 216, healPower(healer("LHO2")));
const hurt = [...parts("heal", 3, "XLHO2", 0), ...parts("heal", 3, "XLHO2")];
check("destroyed HEAL parts don't heal", healPower(hurt) === 144, healPower(hurt));

// Attack: ATTACK x 30 and RANGED_ATTACK x 10, each times its boost
check("unboosted attacker: 450", attackPower(attacker()) === 450, attackPower(attacker()));
check("UH2O attacker: 1350", attackPower(attacker(undefined, "UH2O")) === 1350, attackPower(attacker(undefined, "UH2O")));
check("healer's ranged parts: 20", attackPower(healer()) === 20, attackPower(healer()));

// Damage taken: the lowest damage multiplier of the boosted TOUGH parts still standing
check("no TOUGH: full damage", damageMultiplier(healer("XLHO2")) === 1);
check("unboosted TOUGH: full damage", damageMultiplier(attacker()) === 1);
check("GHO2 TOUGH: half damage", damageMultiplier(attacker("GHO2")) === 0.5);
check("XGHO2 TOUGH: 0.3", damageMultiplier(attacker("XGHO2")) === 0.3);
const broken = [...parts("tough", 5, "GHO2", 0), ...parts("attack", 15), ...parts("move", 20)];
check("TOUGH destroyed: full damage again", damageMultiplier(broken) === 1);

// Tanking: the towers focusing the front (attackers) against the quad's healing
// shard0 W28N8: one RCL 4 tower, 600 at close range
const heal = boost => 2 * healPower(healer(boost));
check("unboosted quad can't tank one tower", !canTank(heal(), 1, damageMultiplier(attacker())), heal());
check("XLHO2 + GHO2 quad tanks one tower (300 vs 576)", canTank(heal("XLHO2"), 1, damageMultiplier(attacker("GHO2"))));
check("LHO2 + GHO2 quad tanks one tower (300 vs 432)", canTank(heal("LHO2"), 1, damageMultiplier(attacker("GHO2"))));
check("XLHO2 + GHO2 quad can't tank two towers (600 vs 576)", !canTank(heal("XLHO2"), 2, damageMultiplier(attacker("GHO2"))));
check("XLHO2 + XGHO2 quad tanks two towers (360 vs 576)", canTank(heal("XLHO2"), 2, damageMultiplier(attacker("XGHO2"))));
check("no tower: nothing to tank", canTank(0, 0, 1));

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
