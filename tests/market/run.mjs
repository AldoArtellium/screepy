/**
 * Offline check of market/pricing: sell order price, repricing of our own sell orders undercut by a
 * competitor, instant sells while credits are low and the price cap of forced buys. Cases from shard0
 * on 2026-10-25 (H: our order at 627.86, competitors at 620.30, best buy 562.74, history 256.72).
 *
 *   node tests/market/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-market-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--rootDir", join(ROOT, "src"), "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash",
            join(ROOT, "src", "market", "pricing.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside this file (global declarations) don't prevent emitting
}

const { sellOrderPrice, repricedSellPrice, instantSellPays, prefersInstantSell, forcedBuyPays, FORCED_BUY_MAX_RATIO } = require(join(OUT, "market", "pricing.js"));

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
    if (!ok) failures++;
};

// shard0 H history (big volumes traded low) and a market whose history matches its order book
const h = { total: 1e7, average: 256.72, stdDev: 40 };
const m = { total: 1e7, average: 600, stdDev: 20 };

// Sell order price: below the cheapest competitor, at least average + dev / 2, at most the greedy price
const greedy = h.average * 1.5 + h.stdDev * 2;
check("H offer is capped at the greedy price", sellOrderPrice(h, 620.304) === greedy, sellOrderPrice(h, 620.304)?.toFixed(3));
const offer = sellOrderPrice(m, 620.304);
check("offer undercuts the cheapest competitor by 1%", Math.abs(offer - 620.304 * 0.99) < 1e-6, offer?.toFixed(3));
check("offer without competitor is the greedy price", sellOrderPrice(m, undefined) === m.average * 1.5 + m.stdDev * 2);
check("competitors below average + dev / 2: offer at that minimum", sellOrderPrice(m, 600) === 610);

// Repricing our order: only down, only when a competitor is below us
const repriced = repricedSellPrice(627.861, m, 620.304);
check("order at 627.86 undercut at 620.30 is lowered", repriced !== null && repriced < 620.304, repriced?.toFixed(3));
check("an order already cheapest is kept", repricedSellPrice(615, m, 620.304) === null);
check("never raised (a raise costs a fee)", repricedSellPrice(300, h, 620.304) === null);
check("lowered to average + dev / 2 at most", repricedSellPrice(627.861, m, 605) === 610);
check("no competitor: kept", repricedSellPrice(627.861, m, undefined) === null);
check("a tiny gap is not worth a change", repricedSellPrice(610.5, m, 610.4) === null);

// Sell now rather than list
check("H: best buy 562 beats the 465 order price", prefersInstantSell(562.739, h, 620.304, false));
check("best buy 580 below a 614 order price: list", !prefersInstantSell(580, { ...m, average: 500 }, 620.304, false));
check("same while credits are low: sell now", prefersInstantSell(580, { ...m, average: 500 }, 620.304, true));
check("buy below the minimum: never", !prefersInstantSell(300, m, 620.304, false));

// Instant sell: average + dev / 2 normally, the average while credits are below the reserve
check("best buy 562 pays with credits", instantSellPays(562.739, h, false));
check("buy at 270 does not pay with credits", !instantSellPays(270, h, false));
check("buy at 270 pays while credits are low", instantSellPays(270, h, true));
check("buy below average never pays", !instantSellPays(250, h, true));

// Forced buys (stock below 5k): at most FORCED_BUY_MAX_RATIO x the average
const l = { total: 1e6, average: 700.2, stdDev: 30 };
check("L at 793.9 (1.13 x average) is bought", forcedBuyPays(793.912, l, 700), `ratio ${FORCED_BUY_MAX_RATIO}`);
check("L at 3000 is not bought", !forcedBuyPays(3000, l, 700));
check("no history: not bought", !forcedBuyPays(10, null, undefined));
// H: history average 256.7 dragged down, buyers pay 562, sellers ask 620: the order book is the reference
check("H at 620 bought (best buy 562 above the average)", forcedBuyPays(620.304, h, 562.739));
check("H at 900 not bought", !forcedBuyPays(900, h, 562.739));
check("without buy orders the average is the reference", !forcedBuyPays(620.304, h, undefined));

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
