/**
 * Offline check of modules/Pixels: pixel generation gate, CPU unlock use, pixel sales and unlock purchases
 * against a mocked Game / Memory.
 *
 *   node tests/pixels/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-pixels-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash",
            join(ROOT, "src", "modules", "Pixels.ts"), join(ROOT, "src", "utils", "throttle.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside this file (global declarations) don't prevent emitting
}

// The game's lodash is 3.10: _.sum, _.max and _.min take an iteratee
const lodash = require(join(ROOT, "node_modules", "lodash"));
const { sum, max, min } = lodash;
lodash.sum = (c, f) => (f ? lodash.sumBy(c, f) : sum(c));
lodash.max = (c, f) => (f ? lodash.maxBy(c, f) : max(c));
lodash.min = (c, f) => (f ? lodash.minBy(c, f) : min(c));
Object.assign(globalThis, {
    _: lodash,
    OK: 0, ERR_NOT_ENOUGH_RESOURCES: -6, ERR_FULL: -8,
    PIXEL: "pixel", CPU_UNLOCK: "cpuUnlock", PIXEL_CPU_COST: 10000,
    ORDER_BUY: "buy", ORDER_SELL: "sell",
});

const { pixelsModule, pixelSettings } = require(join(OUT, "modules", "Pixels.js"));
const { decisionBucket, throttle } = require(join(OUT, "utils", "throttle.js"));

let failures = 0;
function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

const NOW = 1_800_000_000_000;
const history = price => [1, 2, 3, 4].map(d => ({ date: `2026-10-0${d}`, avgPrice: price, stddevPrice: 0, volume: 100, transactions: 10 }));

/** Fresh world: full bucket, CPU average at 40% of the limit, no hostile, no market activity */
function world({ settings = "on", bucket = 10000, cpuAvg = 8, limit = 20, rooms = {}, resources = {}, credits = 0, unlocked = false, unlockedTime, orders = [], prices = {}, time = 1000, maxRooms } = {}) {
    const calls = { generatePixel: 0, unlock: 0, deals: [] };
    globalThis.Memory = { pixels: settings === "on" ? true : (settings ?? undefined), stats: { cpuAvg, counters: {} }, rooms, remoteMining: { sources: {}, lastSelect: 0, maxRooms } };
    globalThis.Game = {
        time,
        rooms: Object.fromEntries(Object.keys(rooms).map(name => [name, { name, controller: { my: true } }])),
        resources: { ...resources },
        cpu: {
            bucket, limit, unlocked, unlockedTime,
            generatePixel: () => { calls.generatePixel++; return OK; },
            unlock: () => { calls.unlock++; Game.resources.cpuUnlock--; return OK; },
        },
        market: {
            credits,
            getAllOrders: f => orders.filter(o => o.type === f.type && o.resourceType === f.resourceType),
            getHistory: r => (prices[r] === undefined ? [] : history(prices[r])),
            deal: (id, amount, roomName) => { calls.deals.push(roomName === undefined ? { id, amount } : { id, amount, roomName }); return OK; },
        },
    };
    Date.now = () => NOW;
    return calls;
}

// Settings
world({ settings: null });
check("off by default", pixelSettings(), null);
world({ settings: false });
check("false turns it off", pixelSettings(), null);
world({ settings: { sell: false, keepPixels: 5 } });
check("object keeps the other defaults", [pixelSettings().generate, pixelSettings().sell, pixelSettings().keepPixels], [true, false, 5]);

// Generation gate
let calls = world({ settings: null });
pixelsModule();
check("nothing without settings", calls.generatePixel, 0);
calls = world();
pixelsModule();
check("full bucket, low CPU: one pixel", [calls.generatePixel, Memory.stats.counters["pixels:generated"]], [1, 1]);
calls = world({ bucket: 9999 });
pixelsModule();
check("bucket not full: none", calls.generatePixel, 0);
check("default maxCpuRatio 0.8", pixelSettings().maxCpuRatio, 0.8);
calls = world({ cpuAvg: 15 });
pixelsModule();
check("CPU average 75% of the limit (shard0: 15/20): one pixel", calls.generatePixel, 1);
calls = world({ cpuAvg: 16 });
pixelsModule();
check("CPU average at 80% of the limit: none", calls.generatePixel, 0);
calls = world({ cpuAvg: 15, settings: { maxCpuRatio: 0.6 } });
pixelsModule();
check("maxCpuRatio from Memory.pixels: none above it", calls.generatePixel, 0);
calls = world({ cpuAvg: 15, maxRooms: 7 });
pixelsModule();
check("remote budget capped: none (the full bucket goes to a remote room)", [calls.generatePixel, Memory.pixelState?.refilling], [0, undefined]);
calls = world({ cpuAvg: 15, maxRooms: 0 });
pixelsModule();
check("remote budget capped at 0 rooms: none", calls.generatePixel, 0);
calls = world({ cpuAvg: 15 });
delete Memory.remoteMining;
pixelsModule();
check("no remote mining memory (uncapped): one pixel", calls.generatePixel, 1);
calls = world({ rooms: { W1N1: { enemies: { expires: 1100, safe: true } } } });
pixelsModule();
check("hostiles in an owned room: none", calls.generatePixel, 0);
calls = world({ rooms: { W1N1: { enemies: { expires: 900 } } } });
pixelsModule();
check("hostiles expected dead: one pixel", calls.generatePixel, 1);
calls = world({ settings: { generate: false } });
pixelsModule();
check("generate: false", calls.generatePixel, 0);
calls = world();
delete Game.cpu.generatePixel;
pixelsModule();
check("no generatePixel (private server): no error", calls.generatePixel, 0);

// Bucket refilling after a pixel: CPU decisions see a full bucket
calls = world();
check("real bucket before any pixel", decisionBucket(), 10000);
pixelsModule();
Game.cpu.bucket = 0;
check("refilling: decisions see a full bucket", [Memory.pixelState.refilling, decisionBucket(), throttle(0)], [true, 10000, false]);
Game.cpu.bucket = 4000;
Game.time++;
pixelsModule();
check("still refilling at 4000", decisionBucket(), 10000);
Memory.stats.cpuAvg = 17;
Game.time++;
pixelsModule();
check("CPU average above 80%: real bucket again", [Memory.pixelState.refilling, decisionBucket(), throttle(0)], [undefined, 4000, true]);
calls = world({ settings: { maxCpuRatio: 0.6 } });
pixelsModule();
Game.cpu.bucket = 10000;
Game.time++;
Memory.stats.cpuAvg = 13;
pixelsModule();
check("bucket full again: flag cleared", [Memory.pixelState.refilling, calls.generatePixel], [undefined, 1]);
calls = world();
pixelsModule();
Game.cpu.bucket = 3000;
Memory.pixels = undefined;
pixelsModule();
check("turned off while refilling: real bucket", decisionBucket(), 3000);
calls = world({ bucket: 3000 });
check("never generated: real bucket", decisionBucket(), 3000);

// Refill vs the remote CPU budget: a capped budget must never read a refill bucket as full (it would add a room)
calls = world({ cpuAvg: 12 });
pixelsModule();
Game.cpu.bucket = 6000;
Game.time++;
pixelsModule();
check("uncapped while refilling: decisions see a full bucket", decisionBucket(), 10000);
Memory.remoteMining.maxRooms = 7;
check("budget just capped (same tick): flag still set", Memory.pixelState.refilling, true);
Game.time++;
pixelsModule();
check("budget capped: refill dropped, real bucket", [Memory.pixelState.refilling, decisionBucket(), calls.generatePixel], [undefined, 6000, 1]);
Game.cpu.bucket = 10000;
Game.time++;
pixelsModule();
check("capped with a full bucket: still no pixel", [calls.generatePixel, decisionBucket()], [1, 10000]);
delete Memory.remoteMining.maxRooms;
Game.time++;
pixelsModule();
check("uncapped again: pixels again", calls.generatePixel, 2);

// CPU unlock use
calls = world({ bucket: 0, resources: { cpuUnlock: 2 } });
pixelsModule();
check("not unlocked, unlock in stock: used", [calls.unlock, Memory.stats.counters["cpuUnlock:used"]], [1, 1]);
Game.time += 200;
pixelsModule();
check("not applied yet (up to 5 minutes): not used twice", calls.unlock, 1);
Date.now = () => NOW + 11 * 60 * 1000;
Game.time += 200;
pixelsModule();
check("still not applied after 10 minutes: used again", calls.unlock, 2);
calls = world({ bucket: 0, resources: { cpuUnlock: 1 }, unlocked: true, unlockedTime: NOW + 5 * 3600 * 1000 });
pixelsModule();
check("5 h left: kept", calls.unlock, 0);
calls = world({ bucket: 0, resources: { cpuUnlock: 1 }, unlocked: true, unlockedTime: NOW + 30 * 60 * 1000 });
pixelsModule();
check("30 min left: used", calls.unlock, 1);
calls = world({ bucket: 0, resources: { cpuUnlock: 1 }, unlocked: true, unlockedTime: undefined });
pixelsModule();
check("subscription: never used", calls.unlock, 0);
calls = world({ bucket: 0, resources: { cpuUnlock: 0 } });
pixelsModule();
check("none in stock: nothing", calls.unlock, 0);
calls = world({ bucket: 0, settings: { unlock: false }, resources: { cpuUnlock: 1 } });
pixelsModule();
check("unlock: false", calls.unlock, 0);

// Pixel sales (account resource: no room name)
const buyOrders = [
    { id: "b1", type: "buy", resourceType: "pixel", price: 900, amount: 3 },
    { id: "b2", type: "buy", resourceType: "pixel", price: 1000, amount: 2 },
];
calls = world({ bucket: 0, resources: { pixel: 5 }, orders: buyOrders, prices: { pixel: 1000 } });
pixelsModule();
check("sells to the best buy order", calls.deals, [{ id: "b2", amount: 2 }]);
check("pixels:sold", Memory.stats.counters["pixels:sold"], 2);
calls = world({ bucket: 0, resources: { pixel: 5 }, orders: buyOrders, prices: { pixel: 1200 } });
pixelsModule();
check("best order under 95% of the average: no sale", calls.deals, []);
calls = world({ bucket: 0, resources: { pixel: 5 }, orders: buyOrders });
pixelsModule();
check("no price history: no sale", calls.deals, []);
calls = world({ bucket: 0, settings: { keepPixels: 4 }, resources: { pixel: 5 }, orders: buyOrders, prices: { pixel: 1000 } });
pixelsModule();
check("keepPixels: sells the surplus only", calls.deals, [{ id: "b2", amount: 1 }]);
calls = world({ bucket: 0, settings: { sell: false }, resources: { pixel: 5 }, orders: buyOrders, prices: { pixel: 1000 } });
pixelsModule();
check("sell: false", calls.deals, []);
calls = world({ bucket: 0, resources: { pixel: 5 }, orders: buyOrders, prices: { pixel: 1000 } });
pixelsModule();
calls.deals.length = 0;
Game.time += 50;
pixelsModule();
check("market every 100 ticks", calls.deals, []);
Game.time += 50;
pixelsModule();
check("market again after 100 ticks", calls.deals.length, 1);

// CPU unlock purchases
const sellOrders = [
    { id: "s1", type: "sell", resourceType: "cpuUnlock", price: 60000, amount: 10 },
    { id: "s2", type: "sell", resourceType: "cpuUnlock", price: 50000, amount: 1 },
];
calls = world({ bucket: 0, credits: 70000, unlocked: true, unlockedTime: NOW + 5 * 3600 * 1000, orders: sellOrders, prices: { cpuUnlock: 50000 } });
pixelsModule();
check("buys one unlock from the cheapest order", [calls.deals, Memory.stats.counters["cpuUnlock:bought"]], [[{ id: "s2", amount: 1 }], 1]);
calls = world({ bucket: 0, credits: 55000, orders: sellOrders, prices: { cpuUnlock: 50000 } });
pixelsModule();
check("10k credit reserve kept", calls.deals, []);
calls = world({ bucket: 0, credits: 100000, orders: sellOrders, prices: { cpuUnlock: 40000 } });
pixelsModule();
check("cheapest above 105% of the average: no purchase", calls.deals, []);
calls = world({ bucket: 0, credits: 100000, resources: { cpuUnlock: 1 }, unlocked: true, unlockedTime: NOW + 5 * 3600 * 1000, orders: sellOrders, prices: { cpuUnlock: 50000 } });
pixelsModule();
check("stock at unlockStock: no purchase", calls.deals, []);
calls = world({ bucket: 0, settings: { buyUnlocks: false }, credits: 100000, orders: sellOrders, prices: { cpuUnlock: 50000 } });
pixelsModule();
check("buyUnlocks: false", calls.deals, []);

if (failures > 0) {
    console.log(`${failures} failure(s)`);
    process.exit(1);
}
console.log("all checks passed");
