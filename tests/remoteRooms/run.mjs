/**
 * Offline check of remote/remoteRooms: rooms a remote path never crosses (other players' rooms and
 * remotes, source keeper rooms). Cases from shard0 on 2026-10-26.
 *
 *   node tests/remoteRooms/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-remoterooms-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--rootDir", join(ROOT, "src"), "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash",
            join(ROOT, "src", "remote", "remoteRooms.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside this file (global declarations) don't prevent emitting
}

const { isRemoteBlocked } = require(join(OUT, "remote", "remoteRooms.js"));

let failures = 0;
const check = (name, ok) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
    if (!ok) failures++;
};
const ME = "Aldo";

// shard0 2026-10-26: W28N7's path to W27N7 went round W28N8 through the keeper room W26N6 (never scouted):
// reservers got ERR_NO_PATH from cartographer every tick, nothing was harvested
check("keeper room W26N6, never scouted", isRemoteBlocked("W26N6", undefined, ME));
check("keeper room W26N4 with an invader stronghold", isRemoteBlocked("W26N4", {}, ME));
check("keeper flag from intel", isRemoteBlocked("W27N7", { hasSourceKeepers: true }, ME));
check("sector center W25N5 is not a keeper room", !isRemoteBlocked("W25N5", {}, ME));
check("another player's room", isRemoteBlocked("W28N8", { owner: "doorknobnob" }, ME));
check("another player's remote", isRemoteBlocked("W27N8", { reserver: "doorknobnob" }, ME));
check("invader reservation is not blocked", !isRemoteBlocked("W28N4", { reserver: "Invader" }, ME));
check("our room", !isRemoteBlocked("W28N7", { owner: ME }, ME));
check("our reservation", !isRemoteBlocked("W28N6", { reserver: ME }, ME));
check("unknown plain room", !isRemoteBlocked("W28N6", undefined, ME));

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
