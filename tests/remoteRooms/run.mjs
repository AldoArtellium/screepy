/**
 * Offline check of remote/remoteRooms: rooms a remote path never crosses (other players' rooms and
 * remotes, source keeper rooms, rooms another player mines or reserves). Cases from shard0 on 2026-10-26.
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

const { contestingPlayer, isContested, isRemoteBlocked, noteContest, pruneContests } = require(join(OUT, "remote", "remoteRooms.js"));

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

// shard0 2026-10-26: W28N4:43:10 mined by Blindfold (harvester on the container, its reserver) while our
// 3 reservers fought the reservation back: blocked although the reservation is ours right now
check("contested room with our reservation", isRemoteBlocked("W28N4", { reserver: ME }, ME, true));
check("contested room never scouted", isRemoteBlocked("W28N4", undefined, ME, true));

const sighting = (creeps, extra = {}) => ({ creeps, ...extra });
check("Blindfold's harvester on the source", contestingPlayer(sighting([{ owner: "Blindfold", harvests: true, claims: false }]), ME) === "Blindfold");
check("Blindfold's reserver at the controller", contestingPlayer(sighting([{ owner: "Blindfold", harvests: false, claims: true }]), ME) === "Blindfold");
check("Blindfold's reservation", contestingPlayer(sighting([], { reserver: "Blindfold" }), ME) === "Blindfold");
check("a player's creep passing through", contestingPlayer(sighting([{ owner: "Blindfold", harvests: false, claims: false }]), ME) === undefined);
check("invader reservation", contestingPlayer(sighting([], { reserver: "Invader" }), ME) === undefined);
check("invader creeps", contestingPlayer(sighting([{ owner: "Invader", harvests: true, claims: true }]), ME) === undefined);
check("source keeper", contestingPlayer(sighting([{ owner: "Source Keeper", harvests: true, claims: false }]), ME) === undefined);
check("our reservation", contestingPlayer(sighting([], { reserver: ME }), ME) === undefined);
check("owned room is never contested", contestingPlayer(sighting([{ owner: "Blindfold", harvests: true, claims: false }], { owner: "Blindfold" }), ME) === undefined);

const entries = {};
check("first sighting is new", noteContest(entries, "W28N4", "Blindfold", 1000, 19000) === true);
check("contested right after", isContested(entries.W28N4, 1001));
check("next sighting is not new", noteContest(entries, "W28N4", "Blindfold", 5000, 21000) === false);
check("ttl kept, last sighting moved", entries.W28N4.ttl === 19000 && entries.W28N4.seen === 5000);
check("still contested 18999 ticks after the last sighting", isContested(entries.W28N4, 5000 + 18999));
check("free 19000 ticks after the last sighting", !isContested(entries.W28N4, 5000 + 19000));
check("contested room blocked through isRemoteBlocked", isRemoteBlocked("W28N4", { reserver: ME }, ME, isContested(entries.W28N4, 6000)));
check("sighting after expiry is new again", noteContest(entries, "W28N4", "Blindfold", 30000, 20000) === true);
entries.W27N4 = { player: "Blindfold", seen: 0, ttl: 20000 };
pruneContests(entries, 25000);
check("prune drops expired entries only", !entries.W27N4 && !!entries.W28N4);
check("unknown room is not contested", !isContested(undefined, 1000));

// Released rooms (after our squad destroyed the player's room they were mined from): shard0 2026-10-27,
// W24N7 reserved and mined by Blindfold from W25N7, W24N8's only reachable remote
const { releaseFrom, RELEASE_TTL, RELEASE_CREEP_GRACE } = require(join(OUT, "remote", "remoteRooms.js"));
const released = { player: "Blindfold", since: 10000, until: 10000 + RELEASE_TTL };
check("release lasts RELEASE_TTL", RELEASE_TTL >= 5000);
check("released right after", releaseFrom(released, 10001)?.player === "Blindfold");
check("over after RELEASE_TTL", releaseFrom(released, 10000 + RELEASE_TTL) === undefined);
check("their leftover creeps ignored at first", releaseFrom(released, 10000 + RELEASE_CREEP_GRACE - 1)?.creeps === true);
check("their creeps count again after the grace", releaseFrom(released, 10000 + RELEASE_CREEP_GRACE)?.creeps === false);
const early = releaseFrom(released, 10100);
const late = releaseFrom(released, 10000 + RELEASE_CREEP_GRACE + 100);
check("their reservation does not contest", contestingPlayer(sighting([], { reserver: "Blindfold" }), ME, early) === undefined);
check("their reservation still not, later", contestingPlayer(sighting([], { reserver: "Blindfold" }), ME, late) === undefined);
check("their leftover harvester does not contest", contestingPlayer(sighting([{ owner: "Blindfold", harvests: true, claims: false }]), ME, early) === undefined);
check("a new harvester after the grace contests", contestingPlayer(sighting([{ owner: "Blindfold", harvests: true, claims: false }]), ME, late) === "Blindfold");
check("another player still contests", contestingPlayer(sighting([], { reserver: "asdpof" }), ME, early) === "asdpof");
check("their reservation does not block the room", !isRemoteBlocked("W24N7", { reserver: "Blindfold" }, ME, false, "Blindfold"));
check("another player's reservation still blocks", isRemoteBlocked("W24N7", { reserver: "asdpof" }, ME, false, "Blindfold"));
check("their owned room still blocks", isRemoteBlocked("W25N7", { owner: "Blindfold" }, ME, false, "Blindfold"));

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
