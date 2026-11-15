/**
 * Offline check of resources/factoryPlan: level 0 recipes, compression only when the bar pays and
 * above the kept stock and the labs' deficit, decompression for the labs, batteries back to energy.
 * Prices from shard0 on 2026-11-15 (14-day averages and best buy orders).
 *
 *   node tests/factory/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-factory-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--rootDir", join(ROOT, "src"), "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash",
            join(ROOT, "src", "resources", "factoryPlan.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside this file (global declarations) don't prevent emitting
}

const { levelZeroRecipes, chooseFactoryJob, compressionPays, recipeMargin, requestedComponents, KEEP_MINERAL } = require(join(OUT, "resources", "factoryPlan.js"));

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail !== undefined ? `: ${JSON.stringify(detail)}` : ""}`);
    if (!ok) failures++;
};

// Subset of COMMODITIES (@screeps/common constants.js)
const COMMODITIES = {
    keanium_bar: { amount: 100, cooldown: 20, components: { K: 500, energy: 200 } },
    reductant: { amount: 100, cooldown: 20, components: { H: 500, energy: 200 } },
    oxidant: { amount: 100, cooldown: 20, components: { O: 500, energy: 200 } },
    lemergium_bar: { amount: 100, cooldown: 20, components: { L: 500, energy: 200 } },
    K: { amount: 500, cooldown: 10, components: { keanium_bar: 100, energy: 200 } },
    U: { amount: 500, cooldown: 10, components: { utrium_bar: 100, energy: 200 } },
    battery: { amount: 50, cooldown: 10, components: { energy: 600 } },
    energy: { amount: 500, cooldown: 10, components: { battery: 50 } },
    wire: { amount: 20, cooldown: 8, components: { utrium_bar: 20, silicon: 100, energy: 40 } },
    composite: { level: 1, amount: 20, cooldown: 50, components: { utrium_bar: 20, zynthium_bar: 20, energy: 20 } },
};
const recipes = levelZeroRecipes(COMMODITIES);
check("level 1 recipes are left out", !recipes.some(r => r.product === "composite"));
check("level 0 recipes are kept", recipes.some(r => r.product === "keanium_bar") && recipes.some(r => r.product === "wire"));

// shard0 2026-11-15: [average, best buy]
const market = {
    K: [61.23, 52.81], H: [299.29, 673.77], O: [480.22, 237.85], L: [567.55, 643.59], U: [44.77, 29.71],
    energy: [12.64, 96.7], keanium_bar: [737.16, 637.89], reductant: [3145.44, 3137.41], oxidant: [2969.9, 2070.23],
    lemergium_bar: [3844.74, 3519.74], utrium_bar: [617.37, 581.42], battery: [819.89, 909],
};
const prices = {
    inputValue: r => (market[r] ? Math.max(...market[r]) : undefined),
    productValue: r => (market[r] ? Math.min(...market[r]) : undefined),
};
const state = (stock, deficit = {}) => ({ ...prices, stock: r => stock[r] ?? 0, labDeficit: r => deficit[r] ?? 0 });

const kMargin = recipeMargin(recipes.find(r => r.product === "keanium_bar"), prices);
check("keanium bar pays (638 x 100 against 500 K at 61 + 200 energy at 97)", kMargin >= 1.2, kMargin?.toFixed(2));
check("reductant does not pay (H sells at 674)", !compressionPays(recipes, "H", prices));
check("oxidant does not pay", !compressionPays(recipes, "O", prices));
check("lemergium bar does not pay (+9% only)", !compressionPays(recipes, "L", prices));
check("keanium bar pays", compressionPays(recipes, "K", prices));
check("no bar for energy", !compressionPays(recipes, "energy", prices));

// W28N7: 35k K, 46k energy
const w28n7 = chooseFactoryJob(recipes, state({ K: 35095, energy: 46144, H: 16145, O: 16092 }));
check("W28N7 compresses its K surplus above the kept stock", w28n7?.product === "keanium_bar" && w28n7.batches === Math.floor((35095 - KEEP_MINERAL) / 500), w28n7);
const deficit = chooseFactoryJob(recipes, state({ K: 35095, energy: 46144 }, { K: 12000 }));
check("no compression of a mineral the labs lack", deficit === null, deficit);
const small = chooseFactoryJob(recipes, state({ K: 20400, energy: 46144 }));
check("less than one batch above the kept stock: nothing", small === null, small);
const lowEnergy = chooseFactoryJob(recipes, state({ K: 35095, energy: 20100 }));
check("no compression that takes energy below the floor", lowEnergy === null, lowEnergy);
const fewEnergy = chooseFactoryJob(recipes, state({ K: 35095, energy: 21000 }));
check("compression limited by the energy above the floor", fewEnergy?.batches === 5, fewEnergy);
const hOnly = chooseFactoryJob(recipes, state({ H: 90000, energy: 100000 }));
check("H surplus is not compressed at these prices", hOnly === null, hOnly);
const noPrice = chooseFactoryJob(recipes, { stock: r => ({ K: 90000, energy: 100000 })[r] ?? 0, labDeficit: () => 0, inputValue: () => undefined, productValue: () => undefined });
check("no compression without prices", noPrice === null, noPrice);

// Hysteresis: a margin of 1.15 starts nothing but keeps a compression under way
const edge = { inputValue: r => ({ K: 100, energy: 10 })[r], productValue: r => (r === "keanium_bar" ? 598 : undefined) };
const edgeState = { ...edge, stock: r => ({ K: 35095, energy: 46144 })[r] ?? 0, labDeficit: () => 0 };
check("margin 1.15 starts no compression", chooseFactoryJob(recipes, edgeState) === null);
check("margin 1.15 keeps the compression under way", chooseFactoryJob(recipes, edgeState, "keanium_bar")?.product === "keanium_bar");

// Decompression for the labs, batteries for energy
const unpack = chooseFactoryJob(recipes, state({ utrium_bar: 1000, energy: 50000 }, { U: 1200 }));
check("a looted utrium bar is decompressed for the labs' U deficit", unpack?.product === "U" && unpack.batches === 3, unpack);
const noNeed = chooseFactoryJob(recipes, state({ utrium_bar: 1000, energy: 50000 }));
check("no decompression without a lab deficit", noNeed === null, noNeed);
const battery = chooseFactoryJob(recipes, state({ battery: 120, energy: 4000 }));
check("batteries back to energy below 10k", battery?.product === "energy" && battery.batches === 2, battery);
const noBattery = chooseFactoryJob(recipes, state({ energy: 900000 }));
check("energy is never compressed into batteries", noBattery === null, noBattery);

// Components for 500 ticks of production
const fill = requestedComponents(recipes.find(r => r.product === "keanium_bar"), 30);
check("factory filled for 500 ticks (25 batches of 20 ticks)", fill.K === 12500 && fill.energy === 5000, fill);
const last = requestedComponents(recipes.find(r => r.product === "keanium_bar"), 3);
check("factory filled for what the job has left", last.K === 1500, last);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
