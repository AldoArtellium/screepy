/**
 * Offline check of remote/defenseModel: the response to the backend's invader raids for the bodies
 * core/bodyBuilder gives at a few energy capacities, and the energy gate before the storage.
 *
 *   node tests/remoteDefense/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-remotedefense-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash",
            join(ROOT, "src", "remote", "defenseModel.ts"), join(ROOT, "src", "core", "bodyBuilder.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside these files (global declarations) don't prevent emitting
}

// The game's lodash is 3.10: _.sum takes an iteratee
const lodash = require(join(ROOT, "node_modules", "lodash"));
const sum = lodash.sum;
lodash.sum = (collection, iteratee) => (iteratee ? lodash.sumBy(collection, iteratee) : sum(collection));
Object.assign(globalThis, {
    _: lodash,
    MOVE: "move", WORK: "work", CARRY: "carry", ATTACK: "attack", RANGED_ATTACK: "ranged_attack",
    HEAL: "heal", TOUGH: "tough", CLAIM: "claim",
    BODYPART_COST: { move: 50, work: 100, carry: 50, attack: 80, ranged_attack: 150, heal: 250, tough: 10, claim: 600 },
    MAX_CREEP_SIZE: 50, ATTACK_POWER: 30, RANGED_ATTACK_POWER: 10, HEAL_POWER: 12,
});

const {
    blinkyBody, boostedResponse, brawlerWins, defenseCandidates, defenseResponse, miniBrawlerBody, skipsEnergyGate,
} = require(join(OUT, "remote", "defenseModel.js"));

// Same bodies as remoteDefense.ts (energy limit 90% of the capacity)
const blinky = (cap, maxRanged) => blinkyBody(cap * 0.9, maxRanged);
const brawler = cap => miniBrawlerBody(cap * 0.9);
const respond = (enemies, cap) => defenseResponse(enemies, brawler(cap), blinky(cap, 6), blinky(cap));

// BOOSTS multipliers of the compounds a remote defender can get (TOUGH: damage taken)
const COMPOUNDS = {
    heal: { LO: 2, LHO2: 3, XLHO2: 4 },
    rangedAttack: { KO: 2, KHO2: 3, XKHO2: 4 },
    attack: { UH: 2, UH2O: 3, XUH2O: 4 },
    tough: { GO: 0.7, GHO2: 0.5, XGHO2: 0.3 },
};
const tierOf = c => (c.length <= 2 ? 1 : c.length === 4 ? 2 : 3);
/** remoteDefense.ts boostStock from a stock { compound: amount }, every compound at `price` energy per unit */
const stockOf = (amounts, price = 1) => (effect, parts) =>
    Object.entries(COMPOUNDS[effect])
        .filter(([compound]) => Math.floor((amounts[compound] ?? 0) / 30) >= parts)
        .map(([compound, multiplier]) => ({ compound, multiplier, cost: 30 * price + 20, tier: tierOf(compound) }));
const boosted = (enemies, cap, amounts, labs = 3) => boostedResponse(enemies, defenseCandidates(cap * 0.9), stockOf(amounts), labs);
const describe = d => (d ? `${d.response} ${JSON.stringify(d.compounds)}${d.tough ? ` tough ${d.tough}` : ""}` : null);

const base = { damage: 0, heal: 0, ranged: false, rangedDamage: 0, hits: 0, fastMelee: false, hasInvaderCore: false, players: false };
// Backend raid bodies (scripts/mockup/sim.cjs RAID_BODIES); boosted: UH attack x2, KO ranged x2, GO tough x0.5 damage
const smallMelee = { ...base, damage: 40, rangedDamage: 10, hits: 1000, fastMelee: true, ranged: true };
const smallMeleeBoosted = { ...base, damage: 80, rangedDamage: 20, hits: 1200, fastMelee: true, ranged: true };
const smallRanged = { ...base, damage: 30, rangedDamage: 30, hits: 1000, ranged: true };
const meleeOnly = { ...base, damage: 30, hits: 500, fastMelee: true };

let failures = 0;
function check(label, actual, expected) {
    const ok = Array.isArray(expected) ? expected.includes(actual) : actual === expected;
    console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${actual}${ok ? "" : ` (expected ${expected})`}`);
    if (!ok) failures++;
}

// shard0 W28N5 (2026-10-20): an RCL 3 home (800 capacity) sent nothing against a lone smallMelee
check("smallMelee, 800 capacity", respond(smallMelee, 800), "miniBrawler");
check("smallMelee, 1300 capacity", respond(smallMelee, 1300), "miniBrawler");
check("smallMelee from a player, 800 capacity", respond({ ...smallMelee, players: true }, 800), null);
check("boosted smallMelee, 800 capacity", respond(smallMeleeBoosted, 800), null);
check("smallRanged, 800 capacity (no melee to close in on)", respond(smallRanged, 800), ["blinkyPair", null]);
check("melee only, 550 capacity (Hivemind rule)", respond(meleeOnly, 550), "miniBrawler");
check("invader core", respond({ ...base, hasInvaderCore: true }, 800), "attacker");

// Mockup W7N4: with its ATTACK parts in front, an 800-energy brawler lost them in the first 300 damage
// and died leaving the smallMelee at 310 hits
check("smallMelee vs ATTACK-first brawler", brawlerWins(smallMelee, ["attack", "attack", "attack", "move", "move", "move", "move", "heal"]), false);
check("smallMelee vs MOVE-first brawler", brawlerWins(smallMelee, ["move", "move", "move", "move", "attack", "attack", "attack", "heal"]), true);
check("brawler body at 800 capacity", brawler(800).join(","), "move,move,move,move,attack,attack,attack,heal");

// shard0 W29N6 (2026-10-26): boosted smallMelee* + smallHealer* held W29N7's remotes (RCL 6, 2300
// capacity, 3 labs); no step wins unboosted (5 RANGED_ATTACK per blinky: 100 damage vs 120 heal)
const w29n6 = { ...base, damage: 80, heal: 120, rangedDamage: 20, hits: 2086, fastMelee: true, ranged: true };
const shard0Stock = { XLHO2: 1583, GHO2: 1040, UH2O: 806, KO: 39, GO: 1600, LO: 600 };
const mockupStock = { XLHO2: 2000, GHO2: 1000, UH2O: 1000, KO: 1000, XKHO2: 1000 };
check("W29N6 pair, 2300 capacity, unboosted", respond(w29n6, 2300), null);
check("W29N6 pair, no compound in stock", describe(boosted(w29n6, 2300, {})), null);
check("W29N6 pair, no lab", describe(boosted(w29n6, 2300, shard0Stock, 0)), null);
// Their heal counts x1.5 (180): 5 plain ATTACK (150) never win, even with the brawler's HEAL boosted
// (mockup: an XLHO2 brawler fought the pair for 1000 ticks without a kill); 5 ATTACK x3 do
check("W29N6 pair, shard0 stock", describe(boosted(w29n6, 2300, shard0Stock)), 'miniBrawler {"attack":"UH2O"}');
check("W29N6 pair, mockup stock", describe(boosted(w29n6, 2300, mockupStock)), 'miniBrawler {"attack":"UH2O"}');
check("W29N6 pair, HEAL compounds only", describe(boosted(w29n6, 2300, { XLHO2: 1000 })), null);
// Without HEAL / ATTACK compounds: blinkies need a RANGED_ATTACK one (5 parts each)
check("W29N6 pair, RANGED_ATTACK and TOUGH compounds only", describe(boosted(w29n6, 2300, { KO: 1000, XKHO2: 1000, GHO2: 1000 })), [
    'miniBlinky {"rangedAttack":"XKHO2","tough":"GHO2"} tough 4', 'blinky {"rangedAttack":"XKHO2"}', 'blinkyPair {"rangedAttack":"KO"}',
]);
check("W29N6 pair, RANGED_ATTACK compounds only", describe(boosted(w29n6, 2300, { KO: 1000, XKHO2: 1000 })), [
    'blinky {"rangedAttack":"XKHO2"}', 'blinkyPair {"rangedAttack":"KO"}',
]);
check("W29N6 pair, shard0 stock without XLHO2 / UH2O (KO for 1 part)", describe(boosted(w29n6, 2300, { ...shard0Stock, XLHO2: 0, UH2O: 0 })), null);
// Two compounds, one lab: none
check("W29N6 pair, one lab, RANGED_ATTACK + TOUGH needed", describe(boosted({ ...w29n6, damage: 300 }, 2300, { XKHO2: 1000, XGHO2: 1000 }, 1)), null);
// Dosing: the lowest tier that wins when compounds cost the same (UH loses: 120 x 1.5 damage taken
// for 18 ticks; UH2O is enough, XUH2O stays)
check("W29N6 pair, every ATTACK tier", describe(boosted(w29n6, 2300, { UH: 3000, UH2O: 3000, XUH2O: 3000 })), 'miniBrawler {"attack":"UH2O"}');
// A weaker pair (unboosted smallMelee + smallHealer at 1300 capacity): no step wins plain, T1 is enough
const plainPair = { ...base, damage: 40, heal: 60, rangedDamage: 10, hits: 2000, fastMelee: true, ranged: true };
check("plain pair, 1300 capacity, unboosted", respond(plainPair, 1300), null);
check("plain pair, 1300 capacity, every ATTACK tier", describe(boosted(plainPair, 1300, { UH: 3000, UH2O: 3000, XUH2O: 3000 })), 'miniBrawler {"attack":"UH"}');
// Players are never fought at range 1 by the brawler; a boosted blinky answers if it wins
check("W29N6-shaped player pair, mockup stock", boosted({ ...w29n6, players: true }, 2300, mockupStock)?.response ?? null,
    ["blinky", "blinkyPair", "miniBlinky"]);
check("invader core: never boosted", describe(boosted({ ...w29n6, hasInvaderCore: true }, 2300, mockupStock)), null);
check("boosted TOUGH blinky body", blinkyBody(2070, undefined, 4).filter(p => p === "tough").length, 4);

check("energy gate skipped: invaders, no storage", skipsEnergyGate(false, smallMelee), true);
check("energy gate kept: invaders, storage", skipsEnergyGate(true, smallMelee), false);
check("energy gate kept: player, no storage", skipsEnergyGate(false, { ...smallMelee, players: true }), false);

console.log(failures ? `${failures} failure(s)` : "all checks passed");
process.exit(failures ? 1 : 0);
