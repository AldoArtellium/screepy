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
            join(ROOT, "src", "remote", "keepers.ts"),
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

// Remote seizes (2026-11-05): another player's remote taken while they don't fight back
const { SEIZE_SELECT_GRACE, SEIZE_TTL, pickSeizes, seizeCandidate, seizeStatus } = require(join(OUT, "remote", "remoteRooms.js"));
const seized = { player: "doorknobnob", since: 20000, until: 20000 + SEIZE_TTL, seize: true };
check("a seize ignores their creeps after the release grace", releaseFrom(seized, 20000 + RELEASE_CREEP_GRACE + 500)?.creeps === true);
check("a seize is a release of their reservation", !isRemoteBlocked("W27N8", { reserver: "doorknobnob" }, ME, false, releaseFrom(seized, 20001)?.player));
check("their creeps don't contest a seized room", contestingPlayer(
    { reserver: "doorknobnob", creeps: [{ owner: "doorknobnob", harvests: true, claims: false }] }, ME, releaseFrom(seized, 20000 + 2000)) === undefined);

const facts = { room: "W27N8", player: "doorknobnob", aggression: 0, sources: 2, distance: 1, keeper: false, owned: false };
check("doorknobnob's remote next to ours is a seize candidate", seizeCandidate(facts, 30000, 300));
check("a stronger player's remote too (Blindfold)", seizeCandidate({ ...facts, room: "W24N7", player: "Blindfold" }, 30000, 300));
check("not once they fought back", !seizeCandidate({ ...facts, aggression: 300 }, 30000, 300));
check("not an owned room", !seizeCandidate({ ...facts, owned: true }, 30000, 300));
check("not a keeper room", !seizeCandidate({ ...facts, keeper: true }, 30000, 300));
check("not without source", !seizeCandidate({ ...facts, sources: 0 }, 30000, 300));
check("not out of reach", !seizeCandidate({ ...facts, distance: 3 }, 30000, 300));
check("not an invader reservation", !seizeCandidate({ ...facts, player: "Invader" }, 30000, 300));
check("not soon after a lost seize", !seizeCandidate({ ...facts, failedAt: 25000 }, 30000, 300));
check("again long after a lost seize", seizeCandidate({ ...facts, failedAt: 1000 }, 30000, 300));

const cands = [
    { ...facts, room: "W27N7", sources: 1, distance: 1 },
    { ...facts, room: "W28N4", player: "Blindfold", sources: 2, distance: 2 },
    { ...facts, room: "W27N8", sources: 2, distance: 1 }
];
check("most sources first, then closest", JSON.stringify(pickSeizes(cands, [], 2)) === JSON.stringify(["W27N8", "W28N4"]));
check("active seizes count against the cap", JSON.stringify(pickSeizes(cands, ["W24N7"], 2)) === JSON.stringify(["W27N8"]));
check("an active seize is not picked again", JSON.stringify(pickSeizes(cands, ["W27N8"], 3)) === JSON.stringify(["W28N4", "W27N7"]));
check("cap reached", pickSeizes(cands, ["A", "B"], 2).length === 0);

check("held while mined and quiet", seizeStatus({ aggression: 0, threshold: 300, since: 1000, now: 9000, mined: true }) === "hold");
check("held while the selection may still pick it", seizeStatus({ aggression: 0, threshold: 300, since: 1000, now: 1000 + SEIZE_SELECT_GRACE - 1, mined: false }) === "hold");
check("unused once the selection left it out", seizeStatus({ aggression: 0, threshold: 300, since: 1000, now: 1000 + SEIZE_SELECT_GRACE, mined: false }) === "unused");
check("lost once they fight back", seizeStatus({ aggression: 300, threshold: 300, since: 1000, now: 2000, mined: true }) === "lost");

// Source keeper mining (2026-11-14, spec sk-mining): shard0's remotes ran out (6 sources) while W26N4-6,
// W25N4, W24N4 (keeper rooms) and W25N5 (sector center, 3 sources) stayed unused
const keepers = require(join(OUT, "remote", "keepers.js"));
const {
    KEEPER_MIN_RCL, KEEPER_RANGE, keeperRoomCandidate, isSectorCenter, isKeeperOrCenter,
    keeperTarget, keeperDangers, inKeeperDanger, killerNeeded, LAIR_WARNING, KEEPER_FLEE_RANGE,
} = keepers;
const skFacts = { rcl: 7, capacity: 5600, distance: 1, stronghold: false };
check("keeper room next to an RCL 7 base is a candidate", keeperRoomCandidate(skFacts));
check("RCL 7 is the least", KEEPER_MIN_RCL === 7 && !keeperRoomCandidate({ ...skFacts, rcl: 6 }));
check("RCL 8 too", keeperRoomCandidate({ ...skFacts, rcl: 8 }));
check("2 rooms away", KEEPER_RANGE === 2 && keeperRoomCandidate({ ...skFacts, distance: 2 }));
check("not 3 rooms away", !keeperRoomCandidate({ ...skFacts, distance: 3 }));
check("not with an active invader stronghold", !keeperRoomCandidate({ ...skFacts, stronghold: true }));
// Mockup W7N3 rcl7 2026-11-14: at 3300 capacity (extensions still building) the killer came out at 36 parts and died 3 times
check("not before the home can spawn the least killer (3900)", !keeperRoomCandidate({ ...skFacts, capacity: 3300 }) && !keeperRoomCandidate({ ...skFacts, capacity: 3899 }));
check("3900 capacity is enough", keeperRoomCandidate({ ...skFacts, capacity: 3900 }));
// Killer body (engine: heal cancels a melee attack, a keeper hits back 300 per melee hit: ATTACK19 HEAL6 MOVE25
// loses in 9 ticks; at range 3 a keeper deals 100 per tick): RANGED + HEAL grown with the energy
const { killerParts } = keepers;
check("no killer under 3900", killerParts(3899) === undefined);
check("3900: RANGED12 HEAL5 MOVE17", JSON.stringify(killerParts(3900)) === JSON.stringify({ ranged: 12, heal: 5, move: 17 }));
check("4100 (mockup W7N3 rcl7): RANGED13 HEAL5", JSON.stringify(killerParts(4100)) === JSON.stringify({ ranged: 13, heal: 5, move: 18 }));
check("5600 (RCL 7): RANGED17 HEAL7", JSON.stringify(killerParts(5600)) === JSON.stringify({ ranged: 17, heal: 7, move: 24 }));
check("RCL 8: RANGED18 HEAL7, 50 parts at most", JSON.stringify(killerParts(12900)) === JSON.stringify({ ranged: 18, heal: 7, move: 25 }));

// A keeper room mined by the home is no longer blocked for that home; any other keeper room still is
check("keeper room held by the home is not blocked", !isRemoteBlocked("W26N5", { hasSourceKeepers: true }, ME, false, undefined, true));
check("keeper room not held stays blocked", isRemoteBlocked("W26N5", { hasSourceKeepers: true }, ME, false, undefined, false));
check("a held keeper room that is contested stays blocked", isRemoteBlocked("W26N5", {}, ME, true, undefined, true));
check("held flag changes nothing for a plain room", isRemoteBlocked("W27N8", { reserver: "doorknobnob" }, ME, false, undefined, true));

check("W25N5 is a sector center", isSectorCenter("W25N5") && isSectorCenter("E15S35"));
check("W26N5 is not a sector center", !isSectorCenter("W26N5") && !isSectorCenter("W20N5"));
check("keeper rooms and centers carry 4000 sources", isKeeperOrCenter("W26N5") && isKeeperOrCenter("W25N5") && !isKeeperOrCenter("W27N5"));
check("intel keepers count too", isKeeperOrCenter("W27N5", true));

// The killer's target: a live keeper by its guarded sources first (closest), else the lair whose keeper comes first
const pos = { x: 20, y: 20 };
const lairs = [
    { id: "a", x: 14, y: 47, ticksToSpawn: 120 },
    { id: "b", x: 15, y: 7, ticksToSpawn: 35 },
    { id: "c", x: 27, y: 12, ticksToSpawn: undefined }
];
check("live keeper first", keeperTarget(pos, [{ id: "k1", x: 30, y: 12 }], lairs)?.id === "k1");
check("closest live keeper", keeperTarget(pos, [{ id: "k1", x: 40, y: 40 }, { id: "k2", x: 22, y: 22 }], lairs)?.id === "k2");
check("no keeper: lair spawning first", JSON.stringify(keeperTarget(pos, [], lairs)) === JSON.stringify({ kind: "lair", id: "b" }));
check("a lair without timer comes last", keeperTarget(pos, [], [{ id: "c", x: 27, y: 12 }, { id: "a", x: 14, y: 47, ticksToSpawn: 280 }])?.id === "a");
check("equal timers: closest lair", keeperTarget(pos, [], [{ id: "a", x: 14, y: 47, ticksToSpawn: 50 }, { id: "b", x: 15, y: 7, ticksToSpawn: 50 }])?.id === "b");
check("nothing to guard", keeperTarget(pos, [], []) === undefined);

// Civilians step out of range 3 of a live keeper or of a lair about to spawn
check("flee range 3, lair warning 10", KEEPER_FLEE_RANGE === 3 && LAIR_WARNING === 10);
const dangers = keeperDangers([{ x: 10, y: 10 }], [{ x: 30, y: 30, ticksToSpawn: 10 }, { x: 40, y: 5, ticksToSpawn: 11 }, { x: 5, y: 40 }]);
check("live keeper and lair at 10 ticks are dangers", dangers.length === 2);
check("within 3 of a keeper", inKeeperDanger({ x: 13, y: 12 }, dangers));
check("4 tiles away is safe", !inKeeperDanger({ x: 14, y: 10 }, dangers));
check("within 3 of a lair spawning in 10", inKeeperDanger({ x: 32, y: 31 }, dangers));
check("next to a lair spawning in 11 is safe", !inKeeperDanger({ x: 40, y: 6 }, keeperDangers([], [{ x: 40, y: 5, ticksToSpawn: 11 }])));
// Mockup W7N3 rcl7 2026-11-14: W6N4:15:43 lost 7 harvesters: its keeper spawned 4 tiles away and walked to
// the source, the harvester on the container (out of range 3 of the lair) only fled once hit, too slow
const guardedSources = [{ x: 15, y: 43 }, { x: 15, y: 4 }];
const soon = keeperDangers([], [{ x: 14, y: 47, ticksToSpawn: 8 }], guardedSources);
check("a lair spawning soon makes its source a danger", inKeeperDanger({ x: 16, y: 42 }, soon) && !inKeeperDanger({ x: 15, y: 8 }, soon));
const later = keeperDangers([], [{ x: 14, y: 47, ticksToSpawn: 40 }], guardedSources);
check("a lair far from spawning does not", !inKeeperDanger({ x: 16, y: 42 }, later));

// Killer relief: a successor once no killer outlives its arrival (spawn time + travel)
check("no killer: one needed", killerNeeded([], 150));
check("one spawning: none needed", !killerNeeded([{ spawning: true, ticksToLive: undefined }], 150));
check("an old killer arriving later than its end: successor", killerNeeded([{ spawning: false, ticksToLive: 140 }], 150));
check("a young killer: none", !killerNeeded([{ spawning: false, ticksToLive: 900 }], 150));
check("an old one and its successor: none", !killerNeeded([{ spawning: false, ticksToLive: 100 }, { spawning: true }], 150));

// Harvesters only once a killer holds the room. shard0 2026-11-14 (deploy 16:35): with "spawning or alive"
// W27N5 sent 4 harvesters (spawned in 69 ticks) to W26N4:6:37 ahead of its killer (150 ticks): 24 remote
// harvesters in 700 ticks, storage 49k -> 21k
const { keeperRoomHeld } = keepers;
check("no killer: not held", !keeperRoomHeld([]));
check("a spawning killer does not hold the room", !keeperRoomHeld([{ spawning: true, inRoom: false }]));
check("a killer on its way does not", !keeperRoomHeld([{ spawning: false, inRoom: false }]));
check("a killer in the room holds it", keeperRoomHeld([{ spawning: false, inRoom: true }]));
check("the old killer still there holds it while its successor spawns", keeperRoomHeld([{ spawning: false, inRoom: true }, { spawning: true, inRoom: false }]));

// A source's container: the path's container tile, else any container next to the source. shard0 2026-11-14
// W26N4: full containers at 6,36 and 46,15 next to their sources while the paths start at 7,36 / 46,13
// (sites): the sources counted no container, no hauler came, 1.4-3.6k energy piled on the ground
const { pickSourceContainer } = require(join(OUT, "remote", "remoteRooms.js"));
const src = { x: 6, y: 37 };
check("the path's tile first", pickSourceContainer(src, { x: 7, y: 36 }, [{ id: "a", x: 6, y: 36 }, { id: "b", x: 7, y: 36 }]) === "b");
check("else a container next to the source", pickSourceContainer(src, { x: 7, y: 36 }, [{ id: "a", x: 6, y: 36 }]) === "a");
check("not one 2 tiles away", pickSourceContainer(src, { x: 7, y: 36 }, [{ id: "c", x: 8, y: 37 }]) === undefined);
check("the one closest to the path's tile", pickSourceContainer(src, { x: 7, y: 36 }, [{ id: "a", x: 5, y: 38 }, { id: "d", x: 7, y: 37 }]) === "d");
check("no path tile: next to the source", pickSourceContainer(src, undefined, [{ id: "a", x: 6, y: 36 }]) === "a");

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
