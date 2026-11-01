/**
 * Offline check of highway/powerPlan: attackers, healers and haulers a power bank takes from our rooms
 * (Hivemind's sizing), the second wave when it outlives the first, and the return that decides it.
 *
 *   node tests/power/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-power-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--rootDir", join(ROOT, "src"), "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash",
            join(ROOT, "src", "highway", "powerPlan.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside this file (global declarations) don't prevent emitting
}

const { planPowerBank, choosePowerBank } = require(join(OUT, "highway", "powerPlan.js"));

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
    if (!ok) failures++;
};

// RCL 7 bodies (5600 energy): 25 ATTACK + 25 MOVE (3250), 18 HEAL + 18 MOVE (5400), 33 CARRY + 17 MOVE (2500)
const rcl7 = { attack: 25, heal: 18, carry: 33, attackerCost: 3250, healerCost: 5400, haulerCost: 2500 };
const homeA = { name: "W29N7", travel: 100, ...rcl7 };
const homeB = { name: "W28N7", travel: 150, ...rcl7 };
const now = 10000;
const bank = (extra = {}) => ({ id: "p", room: "W30N7", x: 20, y: 20, power: 3000, hits: 2000000, decayAt: now + 5000, free: 4, ...extra });
const price = () => 20;

// Fresh bank: one attacker is enough within its time, two healers hold its hit back (375 vs 2 x 216),
// 3 haulers carry 1.2 x the power, the attacker pair needs a second wave (2667 ticks to kill, 1400 of life)
let plan = planPowerBank(bank(), [homeA, homeB], price, now, 1);
check("fresh bank: 1 attacker from the closest room", plan?.attackers === 1 && plan?.homes.join() === "W29N7", JSON.stringify(plan));
check("fresh bank: 2 healers, 3 haulers", plan?.healers === 2 && plan?.haulers === 3);
check("fresh bank: 2 waves, 2667 ticks", plan?.waves === 2 && plan?.timeToKill === 2667);
check("fresh bank: roi = 3000 x 20 / 35600", Math.abs((plan?.roi ?? 0) - 60000 / 35600) < 1e-9);

// Late bank: 2 attackers in one wave cost the same
plan = planPowerBank(bank({ decayAt: now + 2000 }), [homeA, homeB], price, now, 1);
check("late bank: 2 attackers, 4 healers, 1 wave", plan?.attackers === 2 && plan?.healers === 4 && plan?.waves === 1, JSON.stringify(plan));

// Very late: 4 attackers, more than 2 per room, so both rooms spawn
plan = planPowerBank(bank({ decayAt: now + 1200 }), [homeA, homeB], price, now, 1);
check("very late bank: 4 attackers from 2 rooms", plan?.attackers === 4 && plan?.homes.join() === "W29N7,W28N7" && plan?.travel === 150,
    JSON.stringify(plan));

// Left out: too late, too small, one free tile when two attackers are needed, no return, no room
check("too late: none", planPowerBank(bank({ decayAt: now + 600 }), [homeA, homeB], price, now, 1) === null);
check("small bank: none", planPowerBank(bank({ power: 1000 }), [homeA], price, now, 1) === null);
check("one free tile for two attackers: none", planPowerBank(bank({ decayAt: now + 2000, free: 1 }), [homeA, homeB], price, now, 1) === null);
check("return below minRoi: none", planPowerBank(bank(), [homeA], () => 5, now, 1) === null);
check("no room: none", planPowerBank(bank(), [], price, now, 1) === null);

// Choice: the best return, banks without a room left out
const homesFor = room => (room === "W30N2" ? [] : [homeA, homeB]);
const best = choosePowerBank(
    [bank({ id: "small", power: 1500 }), bank({ id: "big", power: 4500 }), bank({ id: "lonely", power: 5000, room: "W30N2" })],
    homesFor, price, now, 1
);
check("picks the best paying bank", best?.id === "big", JSON.stringify(best));

if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
}
console.log("\nall checks passed");
