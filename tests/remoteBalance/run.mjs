/**
 * Offline check of remote/remoteBalance and the steady window test of utils/history: a source that
 * loses energy over enough steady windows is excluded, one that pays or lacks data is kept, the
 * exclusion expires; a source selected for full windows that never get steady and loses energy is
 * excluded too (reason "unsteady"), unless a raid or its container build explains it; the history
 * balance encoding round-trips.
 *
 *   node tests/remoteBalance/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-remotebalance-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--rootDir", join(ROOT, "src"), "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash",
            join(ROOT, "src", "remote", "remoteBalance.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside these files (global declarations) don't prevent emitting
}

const { measuredNet, unsteadyNet, updateExclusions, BALANCE_WINDOWS, UNSTEADY_WINDOWS, EXCLUDE_TICKS, MIN_NET_PER_1000 } = require(
    join(OUT, "remote", "remoteBalance.js")
);
const { steadyWindow, windowFlags, decodeBalance, WINDOW_FULL, WINDOW_THREAT, WINDOW_BUILDING } = require(join(OUT, "utils", "history.js"));

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
    if (!ok) failures++;
};

const KEY = "W29N5:8:31";
const HOME = "W29N7";
/** Windows of 1000 ticks, one source balance each ([delivered, cost, steady, home]) */
const windows = (...balances) =>
    balances.map((b, i) => ({
        tick: 1000 * (i + 1),
        ticks: 1000,
        sources: b ? { [KEY]: { harvested: b[0] + 400, delivered: b[0], cost: b[1], steady: b[2] ?? true, home: b[3] ?? HOME } } : {}
    }));

// shard0: delivered 1528, cost 2160 per 1000 ticks
const losing = windows([1500, 2100], [1550, 2200], [1530, 2180]);
const m = measuredNet(losing, KEY);
check("losing source measured", m !== undefined && m.home === HOME && m.net < 0, m && `${m.net.toFixed(0)}/1000 ticks`);

let excluded = {};
let added = updateExclusions(excluded, losing, 5000, () => EXCLUDE_TICKS);
check("negative over 3 steady windows -> excluded", added.includes(KEY) && excluded[KEY]?.until === 5000 + EXCLUDE_TICKS, JSON.stringify(excluded[KEY]));
check("excluded for its home only", excluded[KEY]?.home === HOME);
check("reason: measured", excluded[KEY]?.reason === "measured");

// Already excluded: not judged again (until unchanged)
added = updateExclusions(excluded, losing, 6000, () => EXCLUDE_TICKS);
check("already excluded -> not extended", added.length === 0 && excluded[KEY].until === 5000 + EXCLUDE_TICKS);

// Expiry
updateExclusions(excluded, windows(null, null, null), 5000 + EXCLUDE_TICKS, () => EXCLUDE_TICKS);
check("expired -> dropped", excluded[KEY] === undefined);

// Retried after expiry: the windows of the exclusion period don't hold it, no new exclusion before 3 steady windows
excluded = {};
added = updateExclusions(excluded, windows([1500, 2100], [1500, 2100], null, [1500, 2100]), 30000, () => EXCLUDE_TICKS);
check("retry: not enough windows since -> kept", added.length === 0);

// Paying source (W27N6:3:40: +588)
excluded = {};
added = updateExclusions(excluded, windows([2500, 1900], [2400, 1850], [2600, 1900]), 5000);
check("positive -> kept", added.length === 0);

// Just under the threshold
excluded = {};
const low = MIN_NET_PER_1000 - 10;
added = updateExclusions(excluded, windows([2000, 2000 - low], [2000, 2000 - low], [2000, 2000 - low]), 5000);
check(`net below ${MIN_NET_PER_1000}/1000 -> excluded`, added.length === 1);

// One window with a big spawn burst, the others pay: the sum decides
excluded = {};
added = updateExclusions(excluded, windows([2000, 3500], [2000, 800], [2000, 900]), 5000);
check("one costly window among paying ones -> kept (sum over the windows)", added.length === 0);

// Not enough data
const cases = [
    ["2 windows only", windows([1500, 2100], [1500, 2100])],
    ["a window with a raid (not steady)", windows([1500, 2100], [200, 2100, false], [1500, 2100])],
    ["newest window not steady (container build)", windows([1500, 2100], [1500, 2100], [300, 2400, false])],
    ["home changed", windows([1500, 2100], [1500, 2100, true, "W29N5"], [1500, 2100])],
    ["not mined in a window", windows([1500, 2100], null, [1500, 2100])],
    ["old entries without steady field", windows([1500, 2100, false, ""], [1500, 2100, false, ""], [1500, 2100, false, ""])]
];
for (const [name, w] of cases) {
    excluded = {};
    added = updateExclusions(excluded, w, 5000);
    check(`${name} -> kept`, added.length === 0);
}
check("BALANCE_WINDOWS is 3", BALANCE_WINDOWS === 3);

// --- Unsteady rule: full windows never steady ---
const FAR = "W27N6:43:32";
const FAR_HOME = "W27N5";
/** Windows of 1000 ticks for the far source ([delivered, cost, {full, threat, building, steady, home, ticks}]) */
const flagged = (...balances) =>
    balances.map((b, i) => ({
        tick: 1000 * (i + 1),
        ticks: b?.[2]?.ticks ?? 1000,
        sources: b
            ? {
                  [FAR]: {
                      harvested: 0,
                      delivered: b[0],
                      cost: b[1],
                      steady: b[2]?.steady ?? false,
                      home: b[2]?.home ?? FAR_HOME,
                      full: b[2]?.full ?? true,
                      threat: b[2]?.threat ?? false,
                      building: b[2]?.building ?? false
                  }
              }
            : {}
    }));
// shard0: harvested 231, delivered 0, cost 843 per 1000 ticks, 0/3 steady
const far = flagged([0, 1300], [0, 0], [0, 1229]);
const u = unsteadyNet(far, FAR);
check("unsteady: far source measured", u !== undefined && u.home === FAR_HOME && Math.round(u.net) === -843, u && `${u.net.toFixed(0)}/1000 ticks`);
excluded = {};
added = updateExclusions(excluded, far, 5000, () => EXCLUDE_TICKS);
check(
    "unsteady: 3 full windows, never steady, net negative -> excluded",
    added.includes(FAR) && excluded[FAR]?.reason === "unsteady" && excluded[FAR].home === FAR_HOME && excluded[FAR].net === -843 &&
        excluded[FAR].until === 5000 + EXCLUDE_TICKS,
    JSON.stringify(excluded[FAR])
);
// Selected with nothing spawned, harvested or delivered: zeros, net 0, kept
excluded = {};
added = updateExclusions(excluded, flagged([0, 0], [0, 0], [0, 0]), 5000);
check("unsteady: nothing spent (net 0) -> kept", added.length === 0);
const unsteadyKept = [
    ["net positive (served part of the time, W29N5:8:31)", flagged([1800, 1500], [1500, 1700], [1900, 1600])],
    ["2 windows only", flagged([0, 1300], [0, 1229])],
    ["a window with a threat", flagged([0, 1300], [0, 1300, { threat: true }], [0, 1229])],
    ["newest window with a threat", flagged([0, 1300], [0, 1300], [0, 1229, { threat: true }])],
    ["container site making progress in a window", flagged([0, 1300], [0, 1300, { building: true }], [0, 1229])],
    ["container site making progress in the newest window", flagged([0, 1300], [0, 1300], [200, 1229, { building: true }])],
    ["selected part of a window (dropped by the budget)", flagged([0, 1300], [0, 1300, { full: false }], [0, 1229])],
    ["a steady window among them", flagged([0, 1300], [1500, 1300, { steady: true }], [0, 1229])],
    ["home changed", flagged([0, 1300, { home: "W28N7" }], [0, 1300], [0, 1229])],
    ["not selected in a window", flagged([0, 1300], null, [0, 1229])],
    ["window cut by a global reset (not full)", flagged([0, 1300], [0, 300, { ticks: 400, full: false }], [0, 1229])],
    [
        "windows written without flags",
        far.map(w => ({ ...w, sources: { [FAR]: { ...w.sources[FAR], full: undefined, threat: undefined, building: undefined } } }))
    ]
];
for (const [name, w] of unsteadyKept) {
    excluded = {};
    added = updateExclusions(excluded, w, 5000);
    check(`unsteady: ${name} -> kept`, added.length === 0);
}
// 3 steady windows paying: the measured rule decides (kept), the unsteady rule never overrides it
excluded = {};
added = updateExclusions(excluded, flagged([2500, 1900, { steady: true }], [2400, 1850, { steady: true }], [2600, 1900, { steady: true }]), 5000);
check("steady and paying -> kept by the measured rule", added.length === 0);
// Older windows don't matter: only the last UNSTEADY_WINDOWS
excluded = {};
added = updateExclusions(excluded, flagged([3000, 1000, { steady: true }], [0, 1300], [0, 0], [0, 1229]), 5000);
check("unsteady: judged on the last windows only", added.includes(FAR));
check("UNSTEADY_WINDOWS is 3", UNSTEADY_WINDOWS === 3);

// Steady window test (utils/history.ts)
const samples = over => ({ home: HOME, homeChanged: false, samples: 100, harvester: 100, container: 100, threat: 0, reserved: 100, unreserved: 0, ...over });
check("steady: full window", steadyWindow(samples({}), 1000) === true);
check("steady: harvester gap of 8%", steadyWindow(samples({ harvester: 92 }), 1000) === true);
check("not steady: harvester missing 20%", steadyWindow(samples({ harvester: 80 }), 1000) === false);
check("not steady: container built midway", steadyWindow(samples({ container: 40 }), 1000) === false);
check("not steady: raid", steadyWindow(samples({ threat: 3 }), 1000) === false);
check("not steady: first reservation midway", steadyWindow(samples({ reserved: 50, unreserved: 50 }), 1000) === false);
check("steady: neutral source never reserved", steadyWindow(samples({ reserved: 0, unreserved: 100 }), 1000) === true);
check("not steady: selected for half the window", steadyWindow(samples({ samples: 50, harvester: 50, container: 50, reserved: 50 }), 1000) === false);
check("not steady: home changed", steadyWindow(samples({ homeChanged: true }), 1000) === false);
check("not steady: window cut by a global reset", steadyWindow(samples({ samples: 40, harvester: 40, container: 40, reserved: 40 }), 400) === false);
check("not steady: no samples", steadyWindow(undefined, 1000) === false);

// Window flags (utils/history.ts)
check("flags: full window", windowFlags(samples({}), 1000) === WINDOW_FULL);
check("flags: no samples", windowFlags(undefined, 1000) === 0);
check("flags: selected half the window", (windowFlags(samples({ samples: 50 }), 1000) & WINDOW_FULL) === 0);
check("flags: home changed", (windowFlags(samples({ homeChanged: true }), 1000) & WINDOW_FULL) === 0);
check("flags: global reset", (windowFlags(samples({ samples: 40 }), 400) & WINDOW_FULL) === 0);
check("flags: threat", windowFlags(samples({ threat: 2 }), 1000) === (WINDOW_FULL | WINDOW_THREAT));
check("flags: site progressed", windowFlags(samples({ siteFirst: 1200, siteLast: 4550 }), 1000) === (WINDOW_FULL | WINDOW_BUILDING));
check("flags: site stalled", windowFlags(samples({ siteFirst: 4550, siteLast: 4550 }), 1000) === WINDOW_FULL);
check("flags: site finished", windowFlags(samples({ siteFirst: 4550, siteLast: 4550, siteDone: true }), 1000) === (WINDOW_FULL | WINDOW_BUILDING));

// Encoding
const decoded = decodeBalance("W29N5:8:31=1hj,16g,1o0,1,W29N7;W28N4:43:10=a,b,c");
check(
    "balance decoding (new and old fields)",
    decoded[KEY].harvested === parseInt("1hj", 36) && decoded[KEY].steady && decoded[KEY].home === HOME &&
        decoded["W28N4:43:10"].steady === false && decoded["W28N4:43:10"].home === "" && decoded["W28N4:43:10"].cost === 12 &&
        decoded[KEY].full === undefined
);
const withFlags = decodeBalance("W27N6:43:32=0,0,z3,0,W27N5,1;W29N5:8:31=a,b,c,0,W29N7,5;W28N5:37:13=a,b,c,1,W27N5,0");
check(
    "balance decoding (flags)",
    withFlags[FAR].full === true && withFlags[FAR].threat === false && withFlags[FAR].building === false && withFlags[FAR].cost === parseInt("z3", 36) &&
        withFlags[KEY].full === true && withFlags[KEY].building === true && withFlags["W28N5:37:13"].full === false
);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
