/**
 * Offline check of the boost choice (labs/boostChoice.ts) and of the reaction chain (labs/chain.ts):
 * best compound, partial boosts, tiers, TOUGH multiplier, reaction targets by RCL and threat, chain
 * decomposition with reagents imported from the other rooms' terminals.
 *
 *   node tests/boosts/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-boosts-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash",
            join(ROOT, "src", "labs", "boostChoice.ts"), join(ROOT, "src", "labs", "chain.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside these files (global declarations) don't prevent emitting
}

// Game constants used by the modules (subset of @screeps/common constants.js)
const RESOURCES = {
    RESOURCE_HYDROGEN: "H", RESOURCE_OXYGEN: "O", RESOURCE_UTRIUM: "U", RESOURCE_LEMERGIUM: "L",
    RESOURCE_KEANIUM: "K", RESOURCE_ZYNTHIUM: "Z", RESOURCE_CATALYST: "X", RESOURCE_GHODIUM: "G",
    RESOURCE_HYDROXIDE: "OH", RESOURCE_ZYNTHIUM_KEANITE: "ZK", RESOURCE_UTRIUM_LEMERGITE: "UL",
    RESOURCE_GHODIUM_HYDRIDE: "GH", RESOURCE_GHODIUM_ACID: "GH2O", RESOURCE_CATALYZED_GHODIUM_ACID: "XGH2O",
    RESOURCE_UTRIUM_HYDRIDE: "UH", RESOURCE_UTRIUM_ACID: "UH2O", RESOURCE_CATALYZED_UTRIUM_ACID: "XUH2O",
    RESOURCE_GHODIUM_OXIDE: "GO", RESOURCE_GHODIUM_ALKALIDE: "GHO2", RESOURCE_CATALYZED_GHODIUM_ALKALIDE: "XGHO2",
    RESOURCE_LEMERGIUM_OXIDE: "LO", RESOURCE_LEMERGIUM_ALKALIDE: "LHO2", RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE: "XLHO2",
    RESOURCE_KEANIUM_OXIDE: "KO", RESOURCE_KEANIUM_ALKALIDE: "KHO2", RESOURCE_CATALYZED_KEANIUM_ALKALIDE: "XKHO2",
    RESOURCE_ZYNTHIUM_OXIDE: "ZO", RESOURCE_ZYNTHIUM_ALKALIDE: "ZHO2", RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE: "XZHO2",
    RESOURCE_LEMERGIUM_HYDRIDE: "LH", RESOURCE_LEMERGIUM_ACID: "LH2O", RESOURCE_CATALYZED_LEMERGIUM_ACID: "XLH2O",
};
const reactions = {};
const react = (a, b, product) => {
    (reactions[a] ??= {})[b] = product;
    (reactions[b] ??= {})[a] = product;
};
for (const [a, b, p] of [
    ["H", "O", "OH"], ["Z", "K", "ZK"], ["U", "L", "UL"], ["ZK", "UL", "G"],
    ["G", "H", "GH"], ["GH", "OH", "GH2O"], ["GH2O", "X", "XGH2O"],
    ["U", "H", "UH"], ["UH", "OH", "UH2O"], ["UH2O", "X", "XUH2O"],
    ["G", "O", "GO"], ["GO", "OH", "GHO2"], ["GHO2", "X", "XGHO2"],
    ["L", "O", "LO"], ["LO", "OH", "LHO2"], ["LHO2", "X", "XLHO2"],
    ["K", "O", "KO"], ["KO", "OH", "KHO2"], ["KHO2", "X", "XKHO2"],
    ["Z", "O", "ZO"], ["ZO", "OH", "ZHO2"], ["ZHO2", "X", "XZHO2"],
    ["L", "H", "LH"], ["LH", "OH", "LH2O"], ["LH2O", "X", "XLH2O"],
]) react(a, b, p);
const BOOSTS = {
    work: { GH: { upgradeController: 1.5 }, GH2O: { upgradeController: 1.8 }, XGH2O: { upgradeController: 2 }, LH: { build: 1.5, repair: 1.5 } },
    tough: { GO: { damage: 0.7 }, GHO2: { damage: 0.5 }, XGHO2: { damage: 0.3 } },
    attack: { UH: { attack: 2 }, UH2O: { attack: 3 }, XUH2O: { attack: 4 } },
};
Object.assign(globalThis, RESOURCES, { REACTIONS: reactions, BOOSTS, LAB_REACTION_AMOUNT: 5, LAB_BOOST_MINERAL: 30 });

const { pickBoost } = require(join(OUT, "boostChoice.js"));
const { findChainReaction, chainDeficits, reactionTargets, importableFrom } = require(join(OUT, "chain.js"));

let failures = 0;
function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}
const stock = amounts => compound => amounts[compound] ?? 0;

// ---- pickBoost: full boosts (military)
check("full: strongest attack with stock for every part", pickBoost(BOOSTS, "attack", "attack", 10, stock({ UH: 20, UH2O: 10, XUH2O: 9 })), { compound: "UH2O", parts: 10 });
check("full: nothing when no compound covers every part", pickBoost(BOOSTS, "attack", "attack", 10, stock({ UH: 9, XUH2O: 9 })), null);
check("full: TOUGH takes the lowest damage multiplier", pickBoost(BOOSTS, "tough", "damage", 4, stock({ GO: 4, GHO2: 4, XGHO2: 4 })), { compound: "XGHO2", parts: 4 });
check("full: tier cap (name length)", pickBoost(BOOSTS, "attack", "attack", 5, stock({ UH: 5, XUH2O: 5 }), 2), { compound: "UH", parts: 5 });
check("full: no part, no boost", pickBoost(BOOSTS, "attack", "attack", 0, stock({ UH: 50 })), null);
check("full: effect the part type lacks", pickBoost(BOOSTS, "work", "upgradeController", 3, stock({ LH: 10 })), null);

// ---- pickBoost: partial boosts (upgraders)
check("partial: boosts what the stock allows", pickBoost(BOOSTS, "work", "upgradeController", 20, stock({ GH: 12 }), undefined, 5), { compound: "GH", parts: 12 });
check("partial: below the minimum, nothing", pickBoost(BOOSTS, "work", "upgradeController", 20, stock({ GH: 4 }), undefined, 5), null);
check("partial: a small body needs every part, not the minimum", pickBoost(BOOSTS, "work", "upgradeController", 3, stock({ GH: 3 }), undefined, 5), { compound: "GH", parts: 3 });
check("partial: best total gain (12 x 0.5 < 8 x 1)", pickBoost(BOOSTS, "work", "upgradeController", 20, stock({ GH: 12, XGH2O: 8 }), undefined, 5), { compound: "XGH2O", parts: 8 });
check("partial: more parts of the weaker tier win (20 x 0.5 > 6 x 1)", pickBoost(BOOSTS, "work", "upgradeController", 20, stock({ GH: 40, XGH2O: 6 }), undefined, 5), { compound: "GH", parts: 20 });

// ---- reactionTargets: upgrade compounds by RCL, military only with a mission or a threat
const names = targets => targets.map(([compound]) => compound);
check("targets: RCL 6 without threat makes GH only", names(reactionTargets(6, false, false)), ["GH"]);
check("targets: RCL 7 without threat makes GH2O only", names(reactionTargets(7, false, false)), ["GH2O"]);
check("targets: RCL 8 nothing for upgrading", names(reactionTargets(8, false, false)), []);
check("targets: a threat adds the military compounds after GH", names(reactionTargets(6, false, true)), ["GH", "XLHO2", "XGHO2", "XUH2O", "XKHO2", "XLH2O"]);
check("targets: a mission puts them first", names(reactionTargets(6, true, true)), ["XLHO2", "XGHO2", "XUH2O", "XKHO2", "XLH2O", "GH"]);

// ---- chain: GH from base minerals
const none = () => 0;
check("chain: G and H there -> GH", findChainReaction("GH", 3000, 1, stock({ G: 3000, H: 3000 }), none), "GH");
// Which of ZK and UL comes first follows the REACTIONS table order
check("chain: no G -> a first step, ZK or UL", ["ZK", "UL"].includes(findChainReaction("GH", 3000, 1, stock({ H: 9000, Z: 5000, K: 5000, U: 5000, L: 5000 }), none)), true);
check("chain: ZK there -> UL", findChainReaction("GH", 3000, 1, stock({ H: 9000, ZK: 3000, U: 5000, L: 5000 }), none), "UL");
check("chain: ZK and UL there -> G", findChainReaction("GH", 3000, 1, stock({ H: 9000, ZK: 3000, UL: 3000 }), none), "G");
// W29N7 (H, K, Z) and W27N5 (H, O, U, L): before, a room stopped at ZK or UL for good
check("chain: U and L only in another room -> UL, imported", findChainReaction("GH", 3000, 1, stock({ H: 9000, ZK: 3000 }), stock({ U: 10000, L: 3000 })), "UL");
check("chain: ZK only in another room -> G, imported", findChainReaction("GH", 3000, 1, stock({ H: 9000, UL: 3000 }), stock({ ZK: 2000 })), "G");
check("chain: nowhere -> nothing (the market buys base minerals)", findChainReaction("GH", 3000, 1, stock({ H: 9000, ZK: 3000 }), none), null);
check("chain: too little to import -> nothing", findChainReaction("GH", 3000, 1, stock({ H: 9000, ZK: 3000 }), stock({ U: 100, L: 100 })), null);

// ---- importable: what the other rooms hold, except the reagents of their own reaction
// Two rooms both on G (ZK + UL) wait for each other's reagent, which the terminal transfers never send
// (a reagent of the reaction under way is "low" in its room): it must not count as importable
const others = [
    { amount: stock({ ZK: 3000, Z: 4000, K: 4000 }), reaction: ["ZK", "UL"] },
    { amount: stock({ U: 2000, L: 1000 }), reaction: undefined },
];
const imported = importableFrom(others);
check("importable: a reagent another room is using is not importable", imported("ZK"), 0);
check("importable: its other resources are", imported("Z"), 4000);
check("importable: summed over the rooms", [imported("U"), imported("L")], [2000, 1000]);
check("chain: G waits for ZK in use elsewhere -> ZK from imported Z and K instead", findChainReaction("GH", 3000, 1, stock({ H: 9000, UL: 3000 }), imported), "ZK");

// ---- deficits: reagents pushed down the chain, stock deducted
const deficit = chainDeficits([["GH", 3000]], stock({ GH: 1000, G: 500 }));
check("deficits: GH 2000 missing, G 1500, ZK and UL 1500", [deficit.GH, deficit.G, deficit.ZK, deficit.UL, deficit.Z], [2000, 1500, 1500, 1500, 1500]);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
