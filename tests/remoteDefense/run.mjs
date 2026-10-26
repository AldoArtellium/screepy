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

const { buildBody } = require(join(OUT, "core", "bodyBuilder.js"));
const { brawlerWins, defenseResponse, meleeOrder, skipsEnergyGate, unarmedPlayers } = require(join(OUT, "remote", "defenseModel.js"));

// Same bodies as remoteDefense.ts (MoveMode.PLAINS = 1, energy limit 90% of the capacity)
const common = cap => ({ moveMode: 1, moveBufferRatio: 0.4, energyLimit: cap * 0.9 });
const blinky = (cap, maxRanged) =>
    buildBody({ weights: { ranged_attack: 7, heal: 3 }, partLimits: maxRanged ? { ranged_attack: maxRanged } : undefined, ...common(cap) });
const brawler = cap => meleeOrder(buildBody({ weights: { attack: 2, heal: 1 }, partLimits: { attack: 5 }, ...common(cap) }));
const respond = (enemies, cap) => defenseResponse(enemies, brawler(cap), blinky(cap, 6), blinky(cap));

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

// shard0 W28N4 (2026-10-26): Blindfold's reserver (CLAIM, damage 0) drew a remoteDefender from W28N7
const unarmedPlayer = { ...base, hits: 1300, players: true };
check("player reserver / harvester (unarmed), 1300 capacity", respond(unarmedPlayer, 1300), null);
check("unarmed player creeps", unarmedPlayers(unarmedPlayer), true);
check("player healer is armed", unarmedPlayers({ ...unarmedPlayer, heal: 24 }), false);
check("player with ATTACK is armed", unarmedPlayers({ ...unarmedPlayer, damage: 30 }), false);
check("invader core with a player reserver", respond({ ...unarmedPlayer, hasInvaderCore: true }, 800), "attacker");
check("unarmed invader (no player) unchanged", respond({ ...base, hits: 500 }, 800), "miniBrawler");

// Mockup W7N4: with its ATTACK parts in front, an 800-energy brawler lost them in the first 300 damage
// and died leaving the smallMelee at 310 hits
check("smallMelee vs ATTACK-first brawler", brawlerWins(smallMelee, ["attack", "attack", "attack", "move", "move", "move", "move", "heal"]), false);
check("smallMelee vs MOVE-first brawler", brawlerWins(smallMelee, ["move", "move", "move", "move", "attack", "attack", "attack", "heal"]), true);
check("brawler body at 800 capacity", brawler(800).join(","), "move,move,move,move,attack,attack,attack,heal");

check("energy gate skipped: invaders, no storage", skipsEnergyGate(false, smallMelee), true);
check("energy gate kept: invaders, storage", skipsEnergyGate(true, smallMelee), false);
check("energy gate kept: player, no storage", skipsEnergyGate(false, { ...smallMelee, players: true }), false);

console.log(failures ? `${failures} failure(s)` : "all checks passed");
process.exit(failures ? 1 : 0);
