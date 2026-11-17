/**
 * Offline check of visuals/remoteRows: which remote sources get a row in the world map panel (only
 * those with a problem, the worst one named) and the summary row of each home room.
 *
 *   node tests/remoteVisuals/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-remote-visuals-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash", "--rootDir", join(ROOT, "src"),
            join(ROOT, "src", "visuals", "remoteRows.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside this file (global declarations) don't prevent emitting
}

const { sourceIssue, homeRow, BAD, WARN, OK } = require(join(OUT, "visuals", "remoteRows.js"));

let failures = 0;
function check(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    if (!ok) failures++;
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`}`);
}

const fine = { attacked: false, starved: false, unserved: 0, harvesters: 1, net: 6.2, reservation: { text: "res 3.2k", color: OK } };
const issue = facts => sourceIssue({ ...fine, ...facts });

check("healthy source: no row", issue({}), undefined);
check("unreserved is not a problem", issue({ reservation: { text: "unreserved", color: "#a0a0a0" } }), undefined);
check("no reservation shown is not a problem", issue({ reservation: undefined }), undefined);
check("just lost its harvester: not yet a problem", issue({ harvesters: 0, unserved: 200 }), undefined);
check("no harvester for 300+ ticks", issue({ harvesters: 0, unserved: 301 }), { text: "no harvester", color: WARN });
check("starved", issue({ harvesters: 0, unserved: 3000, starved: true }), { text: "starved", color: BAD });
check("attacked wins over starved", issue({ attacked: true, starved: true }), { text: "attacked", color: BAD });
check("someone else's reservation", issue({ reservation: { text: "res Blindfold 2.1k", color: BAD } }), { text: "res Blindfold 2.1k", color: BAD });
check("low or stale reservation", issue({ reservation: { text: "res 800", color: WARN } }), { text: "res 800", color: WARN });
check("net loss", issue({ net: -0.4 }), { text: "loss", color: BAD });

check(
    "home row: capped, spawn share and net income",
    homeRow({ name: "W27N5", color: "#00ffff", rcl: 8, count: 6, cap: 6, busy: 0.724, net: 54.36 }).map(c => c.text),
    ["W27N5", "RCL 8", "6/6 remotes", "spawn 72%", "+54.4/t"]
);
check(
    "home row: capped count in orange, uncapped in the home color",
    [homeRow({ name: "A", color: "#00ffff", rcl: 7, count: 6, cap: 6, net: 1 })[2].color, homeRow({ name: "A", color: "#00ffff", rcl: 7, count: 4, net: 1 })[2].color],
    [WARN, "#00ffff"]
);
check(
    "home row: no spawn share yet",
    homeRow({ name: "W1N1", color: "#00ffff", rcl: 4, count: 2, net: 9 }).map(c => c.text),
    ["W1N1", "RCL 4", "2 remotes", "", "+9.0/t"]
);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
