/**
 * Offline check of military/boostNeed: a squad only gets the boosts the target calls for, the
 * cheapest set (spawn energy + compounds, with replacements) whose squad holds against the room's
 * threat with a margin; strongest boosts when nothing holds (forced attacks), none or all on demand.
 *
 *   node tests/squadBoosts/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-squadboosts-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--rootDir", join(ROOT, "src"), "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash",
            join(ROOT, "src", "military", "boostNeed.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside this file (global declarations) don't prevent emitting
}

const { chooseSquad, BOOST_MARGIN } = require(join(OUT, "military", "boostNeed.js"));

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
    if (!ok) failures++;
};

// Compounds (BOOSTS): multiplier, tier; cost per part = 30 units x price + 20 energy
const COMPOUNDS = {
    heal: [["LO", 2, 1], ["LHO2", 3, 2], ["XLHO2", 4, 3]],
    tough: [["GO", 0.7, 1], ["GHO2", 0.5, 2], ["XGHO2", 0.3, 3]],
    attack: [["UH", 2, 1], ["UH2O", 3, 2], ["XUH2O", 4, 3]],
};
/** Boost options of an effect: none first, then the compounds in stock for `parts` parts */
function options(effect, parts, stock, price = () => 1) {
    const list = [{ compound: null, multiplier: 1, cost: 0, tier: 0 }];
    for (const [compound, multiplier, tier] of COMPOUNDS[effect]) {
        if ((stock[compound] ?? 0) >= parts * 30) list.push({ compound, multiplier, cost: 30 * price(compound) + 20, tier });
    }
    return list;
}

// Bodies at 2300 energy (sizing.ts): duo attacker 23 ATTACK, duo healer 7 HEAL; quad attacker 3 TOUGH
// 10 ATTACK (13 MOVE), quad healer 6 HEAL 2 RANGED (8 MOVE)
function shapes(stock, price) {
    const duo = {
        type: "duo", spawnCost: 2300 * 2, heal: 7 * 12, damage: 23 * 30, frontTough: 0, frontOther: 46,
        parts: { heal: 7, tough: 0, attack: 23 },
    };
    const quad = {
        type: "quad", spawnCost: 2300 * 4, heal: 2 * 6 * 12, damage: 10 * 30, frontTough: 3, frontOther: 23,
        parts: { heal: 12, tough: 6, attack: 20 },
    };
    for (const s of [duo, quad]) {
        s.options = {
            heal: options("heal", s.parts.heal, stock, price),
            tough: options("tough", s.parts.tough, stock, price),
            attack: options("attack", s.parts.attack, stock, price),
        };
    }
    return [duo, quad];
}

const FULL = { LO: 9000, LHO2: 9000, XLHO2: 9000, GO: 9000, GHO2: 9000, XGHO2: 9000, UH: 9000, UH2O: 9000, XUH2O: 9000 };
const threat = (towers, creeps = 0, heal = 0) => ({
    close: towers * 600 + creeps,
    edge: towers * 150 + creeps,
    minDamage: heal * 1.2,
});

// 1. A room without tower, a weak defender (50 damage): the unboosted duo holds, nothing to boost
{
    const c = chooseSquad(shapes(FULL), threat(0, 50), false);
    check("no tower: feasible", c.feasible, JSON.stringify(c));
    check("no tower: no boost", !c.compounds.heal && !c.compounds.tough && !c.compounds.attack, JSON.stringify(c.compounds));
    check("no tower: no boost cost", c.boostCost === 0, c.boostCost);
}

// 1b. One tower drained from the edge: never dearer than the unboosted quad (2 x 9200)
{
    const c = chooseSquad(shapes(FULL), threat(1), false);
    check("1 tower at the edge: feasible", c.feasible, JSON.stringify(c));
    check("1 tower at the edge: at most the unboosted quad", c.cost <= 18400, `${c.type} ${JSON.stringify(c.compounds)} ${c.cost}`);
}

// 2. RCL 4, one tower refilled (shard0 W28N8): its 600 x margin must be out-healed on the front, TOUGH
//    included (combat.ts canTank; soaking it with HEAL alone cost 6 creeps in the mockup instead of 2),
//    the cheapest set that does, never ATTACK (the quad's damage is not judged)
{
    const c = chooseSquad(shapes(FULL), threat(1), true);
    check("1 refilled tower: feasible", c.feasible, JSON.stringify(c));
    check("1 refilled tower: heal boosted", !!c.compounds.heal, JSON.stringify(c.compounds));
    check("1 refilled tower: TOUGH boosted", !!c.compounds.tough, JSON.stringify(c.compounds));
    const toughTaken = COMPOUNDS.tough.find(e => e[0] === c.compounds.tough)?.[1] ?? 1;
    check("1 refilled tower: tanks the tower", c.heal >= 600 * BOOST_MARGIN * toughTaken, `${c.heal} vs ${600 * BOOST_MARGIN * toughTaken}`);
    check("1 refilled tower: no ATTACK boost", !c.compounds.attack, JSON.stringify(c.compounds));
    check("1 refilled tower: not the strongest everywhere", !(c.compounds.heal === "XLHO2" && c.compounds.tough === "XGHO2"), JSON.stringify(c.compounds));
}

// 3. Only T3 in stock: the boost is the T3 one when needed
{
    const c = chooseSquad(shapes({ XLHO2: 9000, XGHO2: 9000 }), threat(1), true);
    check("T3 only: feasible", c.feasible, JSON.stringify(c));
    check("T3 only: XLHO2", c.compounds.heal === "XLHO2", JSON.stringify(c.compounds));
}

// 4. Nothing holds even at the strongest (3 refilled towers): strongest boosts, infeasible
{
    const c = chooseSquad(shapes(FULL), threat(3), true);
    check("3 refilled towers: infeasible", !c.feasible, JSON.stringify(c));
    check("3 refilled towers: strongest boosts kept", c.compounds.heal === "XLHO2" && c.compounds.tough === "XGHO2", JSON.stringify(c.compounds));
}

// 5. A cheap T1 beats a T3 that also holds: with prices, T3 at 20 energy a unit, T1 at 2
{
    const price = compound => (compound.startsWith("X") ? 20 : compound.length === 2 ? 2 : 6);
    const c = chooseSquad(shapes(FULL, price), threat(0, 200), false);
    check("200 creep damage: feasible", c.feasible, JSON.stringify(c));
    check("200 creep damage: no T3", ![c.compounds.heal, c.compounds.tough, c.compounds.attack].some(x => x?.startsWith("X")), JSON.stringify(c.compounds));
}

// 6. Duo against a healer: its attacker must beat the enemy heal x 1.2 (ATTACK boost)
{
    const c = chooseSquad(shapes(FULL), threat(0, 50, 800), false);
    check("duo vs 800 heal: duo", c.type === "duo", JSON.stringify(c));
    check("duo vs 800 heal: ATTACK boosted", !!c.compounds.attack, JSON.stringify(c.compounds));
}

// 7. Modes: "max" boosts everything available, "none" nothing
{
    const max = chooseSquad(shapes(FULL), threat(1), false, { mode: "max" });
    check("mode max: strongest heal", max.compounds.heal === "XLHO2", JSON.stringify(max.compounds));
    const none = chooseSquad(shapes(FULL), threat(1), true, { mode: "none" });
    check("mode none: no boost", !none.compounds.heal && !none.compounds.tough, JSON.stringify(none.compounds));
}

// 8. Escalation: a floor keeps at least the boosts already chosen, a bigger margin asks for more
{
    const price = compound => (compound.startsWith("X") ? 20 : compound.length === 2 ? 2 : 6);
    const base = chooseSquad(shapes(FULL, price), threat(1), true);
    const floor = chooseSquad(shapes(FULL, price), threat(1), true, { floor: base.compounds, margin: BOOST_MARGIN * 1.5 });
    const gain = (effect, compound) => {
        const entry = COMPOUNDS[effect].find(e => e[0] === compound);
        if (!entry) return 0;
        return effect === "tough" ? 1 - entry[1] : entry[1] - 1;
    };
    const stronger = ["heal", "tough"].every(e => gain(e, floor.compounds[e]) >= gain(e, base.compounds[e]));
    check("escalation: never weaker than before", stronger, `${JSON.stringify(base.compounds)} -> ${JSON.stringify(floor.compounds)}`);
    check("escalation: more boosts", floor.boostCost > base.boostCost, `${base.boostCost} -> ${floor.boostCost}`);
}

// 8b. A floor compound out of stock: its tier or above, never weaker
{
    const c = chooseSquad(shapes({ LO: 9000, XLHO2: 9000, XGHO2: 9000 }), threat(1), true, { floor: { heal: "LHO2", tough: "GHO2" } });
    check("floor out of stock: no LO", c.compounds.heal === "XLHO2", JSON.stringify(c.compounds));
    check("floor out of stock: no weaker TOUGH", c.compounds.tough === "XGHO2", JSON.stringify(c.compounds));
}

// 8c. A forced duo is judged on its front creep (old feasibility), not dropped
{
    const [duo] = shapes(FULL);
    duo.soak = true;
    duo.frontTough = 5;
    duo.frontOther = 30;
    const c = chooseSquad([duo], threat(2), false);
    check("forced duo: feasible through its front", c.feasible && c.type === "duo", JSON.stringify(c));
}

// 9. No labs / no stock: the unboosted squad, feasible or not
{
    const c = chooseSquad(shapes({}), threat(1), false);
    check("no stock: unboosted and feasible", c.feasible && c.boostCost === 0, JSON.stringify(c));
}

if (failures > 0) {
    console.log(`${failures} failure(s)`);
    process.exit(1);
}
console.log("all checks passed");
