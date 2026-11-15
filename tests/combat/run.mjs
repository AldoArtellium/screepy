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

const { healPower, attackPower, activePower, towerPower, damageMultiplier, canTank, damageOver, towerShots, sampleRefill } = require(join(OUT, "military", "combat.js"));

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

// Active parts weighted by their boost of one effect (defense: dismantle, fatigue, ...)
check("XLHO2 healer: 6 HEAL x 4 heal", activePower({ body: healer("XLHO2") }, "heal", "heal") === 24);
check("destroyed parts left out", activePower({ body: hurt }, "heal", "heal") === 12);
check("other effect of a boosted part: 1 each", activePower({ body: healer("XLHO2") }, "heal", "fatigue") === 6);

// Tower falloff (towers of both sides): 1 up to range 5, 0.25 from range 20
check("tower power at range 3: 1", towerPower(3) === 1);
check("tower power at range 20: 0.25", towerPower(20) === 0.25);
check("tower power at range 30: 0.25", towerPower(30) === 0.25);
check("tower power at range 10: 0.75", towerPower(10) === 0.75, towerPower(10));

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

// Damage over several ticks: a tower only for the shots its energy and its refills pay (quad.ts canEscape)
check("9 energy, no refill seen: no shot", towerShots(9, undefined, 11) === 0);
check("10 energy: one shot", towerShots(10, undefined, 11) === 1);
check("790 energy: 79 shots", towerShots(790, undefined, 11) === 79);
check("creeps every tick, towers capped", damageOver([{ damage: 600, ticks: 2 }, { damage: 90, ticks: Infinity }], 11) === 1200 + 990);

// Refills: mockup W8N3 `--enemy-refill 1` gives 5 every 5 ticks, seen every other tick by the drainer
let fed = sampleRefill(undefined, 100, 0);
check("first sample: nothing measured", fed.burst === 0 && fed.rate === 0);
check("same tick: unchanged", sampleRefill(fed, 100, 50) === fed);
fed = sampleRefill(fed, 101, 5);
check("refill of 5 a tick after the first sample", fed.burst === 5 && fed.rate === 5 && fed.refilled === 101, JSON.stringify(fed));
fed = sampleRefill(fed, 103, 5);
check("no refill: burst and rate kept", fed.burst === 5 && fed.rate === 5 && fed.energy === 5);
fed = sampleRefill(fed, 105, 0);
fed = sampleRefill(fed, 106, 5);
check("5 more after 5 ticks: 1 a tick", fed.burst === 5 && fed.rate === 1, JSON.stringify(fed));
check("samples too far apart: no refill measured", sampleRefill(fed, 120, 700).burst === 5);
const filler = sampleRefill(sampleRefill(undefined, 200, 10), 201, 810);
check("a filler's carry at once: burst 800", filler.burst === 800);
check("tower seen fed by a filler: fires every tick", towerShots(10, filler, 23) >= 23);

// An unboosted quad member 8 tiles from the exit (+3 margin, 11 ticks), healed 144 a tick: the W8N3 tower fed
// 1 a tick holds 2 shots (one shot retreated it at full hits until its members aged, 2026-11-15)
const escapeNet = (energy, refill, ticks) => damageOver([{ damage: 600, ticks: towerShots(energy, refill, ticks) }], ticks) - 144 * ticks;
check("fed 1 a tick, attacker 4000 hits: stays", 4000 > escapeNet(5, fed, 11), escapeNet(5, fed, 11));
check("fed 1 a tick, healer 1600 hits 20 tiles in: stays", 1600 > escapeNet(5, fed, 23), escapeNet(5, fed, 23));
check("full tower: retreats", 4000 <= escapeNet(790, undefined, 11), escapeNet(790, undefined, 11));
check("filler-fed tower at 10: retreats", 4000 <= escapeNet(10, filler, 11), escapeNet(10, filler, 11));

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
