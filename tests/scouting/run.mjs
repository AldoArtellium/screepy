/**
 * Offline check of utils/scouting: which owned room scouts a room (one scout per room, not one per home in
 * range), and the ownership rescout age under CPU pressure. Homes of shard0 on 2026-10-25.
 *
 *   node tests/scouting/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-scouting-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--rootDir", join(ROOT, "src"), "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash",
            join(ROOT, "src", "utils", "scouting.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside this file (global declarations) don't prevent emitting
}

const { scoutHomeOf, ownershipRescoutAge } = require(join(OUT, "utils", "scouting.js"));

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
    if (!ok) failures++;
};

// West-north rooms only: Wx Ny -> (x, y)
const coords = name => {
    const m = /^W(\d+)N(\d+)$/.exec(name);
    return [Number(m[1]), Number(m[2])];
};
const distance = (a, b) => {
    const [ax, ay] = coords(a);
    const [bx, by] = coords(b);
    return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
};

const homes = [
    { name: "W24N8", range: 5 },
    { name: "W27N5", range: 5 },
    { name: "W28N7", range: 5 },
    { name: "W29N7", range: 5 },
];
check("W28N8 goes to W28N7 (closest)", scoutHomeOf("W28N8", homes, distance) === "W28N7", scoutHomeOf("W28N8", homes, distance));
check("W27N9 tie W28N7 / W29N7: first by name", scoutHomeOf("W27N9", homes, distance) === "W28N7", scoutHomeOf("W27N9", homes, distance));
check("W28N6 tie W27N5 / W28N7 / W29N7: first by name", scoutHomeOf("W28N6", homes, distance) === "W27N5", scoutHomeOf("W28N6", homes, distance));
check("W22N8 goes to W24N8", scoutHomeOf("W22N8", homes, distance) === "W24N8");
// A home whose range does not cover the room never gets it
const short = [{ name: "W27N5", range: 3 }, { name: "W24N8", range: 5 }];
check("out of the closest home's range: the next home", scoutHomeOf("W27N9", short, distance) === "W24N8", scoutHomeOf("W27N9", short, distance));
check("out of every range: none", scoutHomeOf("W10N10", homes, distance) === undefined);

// Every room in range of the 4 homes gets exactly one home
let rooms = 0;
let assigned = 0;
for (let x = 18; x <= 35; x++) {
    for (let y = 1; y <= 14; y++) {
        const room = `W${x}N${y}`;
        if (!homes.some(h => distance(h.name, room) <= h.range)) continue;
        rooms++;
        if (scoutHomeOf(room, homes, distance)) assigned++;
    }
}
check("every room in range has one home", rooms === assigned, `${assigned}/${rooms}`);

check("ownership rescout age 10000 normally", ownershipRescoutAge(10000, false) === 10000);
check("ownership rescout age x3 under CPU pressure", ownershipRescoutAge(10000, true) === 30000);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
