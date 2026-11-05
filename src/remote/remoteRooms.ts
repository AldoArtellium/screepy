/**
 * Rooms a remote path never crosses (pure, offline check: tests/remoteRooms/run.mjs), used by
 * RemoteMining.ts for the path search and to search a cached path again.
 *
 * Another player's room or remote (reserved by them), as The International's remotesManager
 * (remoteTypeWeights: enemy and enemyRemote are Infinity); invader reservations don't count (RoomIntel
 * tracks their danger). And source keeper rooms, by name or intel (not in TI or Hivemind, whose remote
 * paths only avoid the lairs): shard0 2026-10-26, W28N7's path to W27N7 went round doorknobnob's W28N8
 * through W26N6, its reservers got ERR_NO_PATH from cartographer (keeper tiles avoided) every tick and
 * the two sources (171 and 196 tiles) harvested nothing.
 *
 * Contested rooms (not in TI or Hivemind): another player mines or reserves the room. The intel snapshot
 * only shows their reservation while they hold it, so a room we kept reserving looked free: shard0
 * 2026-10-26, W28N4:43:10 (one free tile, 151 tiles from W28N7) had Blindfold's harvester on its container
 * and Blindfold's reserver, our 3 reservers fought the reservation back and forth and nothing was
 * harvested. RoomIntel remembers the player for CONTEST_TTL ticks (+-10%) from the last sighting.
 */

import { isKeeperRoom } from "../utils/rooms";

export interface RemoteRoomInfo {
    owner?: string;
    reserver?: string;
    hasSourceKeepers?: boolean;
}

/** A player seen mining or reserving a room we don't own: last sighting and how long it counts */
export interface ContestEntry {
    player: string;
    seen: number;
    ttl: number;
}

/** Ticks a contested room stays blocked after the last sighting (jittered +-10% by the caller) */
export const CONTEST_TTL = 20000;

const NPCS = ["Invader", "Source Keeper"];

function isPlayer(username: string | undefined, me: string | undefined): username is string {
    return !!username && username !== me && !NPCS.includes(username);
}

export function isContested(entry: ContestEntry | undefined, time: number): boolean {
    return !!entry && time - entry.seen < entry.ttl;
}

/** `releasedFrom`: the player whose reservation no longer blocks the room (releaseFrom) */
export function isRemoteBlocked(
    roomName: string,
    info: RemoteRoomInfo | undefined,
    me: string | undefined,
    contested = false,
    releasedFrom?: string
): boolean {
    if (isKeeperRoom(roomName) || info?.hasSourceKeepers) return true;
    if (contested) return true;
    if (!info) return false;
    if (info.owner && info.owner !== me) return true;
    return !!info.reserver && info.reserver !== me && info.reserver !== "Invader" && info.reserver !== releasedFrom;
}

/**
 * A room released from a player (not in TI or Hivemind): our squad destroyed the room they mined or
 * reserved it from (military.ts, military/roi.ts releasedRooms). Their reservation runs on for up to
 * CONTROLLER_RESERVE_MAX ticks and their creeps there for up to a creep life: counted as a contest, they
 * kept the room blocked for CONTEST_TTL more (shard0 W24N7, Blindfold's from W25N7). For RELEASE_TTL
 * ticks their reservation is no contest (our reserver attacks it) and, for RELEASE_CREEP_GRACE ticks,
 * neither are their creeps; a creep of theirs mining after that contests the room again.
 */
export interface ReleaseEntry {
    player: string;
    since: number;
    until: number;
    /** A seize (remoteSeize.ts): their creeps are ignored for as long as it lasts, renewed while held */
    seize?: boolean;
}

export const RELEASE_TTL = 20000;
/** CREEP_LIFE_TIME (a literal: the module stays pure for the offline check) */
export const RELEASE_CREEP_GRACE = 1500;

/** The released player, and whether their creeps are still ignored; undefined once over */
export function releaseFrom(entry: ReleaseEntry | undefined, time: number): { player: string; creeps: boolean } | undefined {
    if (!entry || time >= entry.until) return undefined;
    return { player: entry.player, creeps: !!entry.seize || time - entry.since < RELEASE_CREEP_GRACE };
}

/**
 * Remote seizes (our design, 2026-11-05; not in TI or Hivemind, which never mine another player's
 * remote). shard0 after the CPU unlock: the CPU budget was lifted and the remotes stayed at 7 sources in
 * 5 rooms, every other room within reach being another player's remote (Blindfold W24N7, W27N4, W28N4;
 * doorknobnob W27N7, W27N8) or a keeper room. A seize releases such a room without razing the base it is
 * mined from: their reservation and creeps stop contesting it, remote defense kills their creeps there
 * (remoteDefense.ts), our reserver attacks their reservation, the selection mines it. Any player, a
 * stronger one included, while their aggression stays under the hostile threshold; once they fight
 * back the seize is lost and the room left alone for SEIZE_FAILURE_MEMORY ticks.
 */
/** Ticks a seize lasts without renewal (renewed every check while held) */
export const SEIZE_TTL = 3000;
/** Ticks the remote selection gets to mine a seized room before the seize is dropped as unused */
export const SEIZE_SELECT_GRACE = 3000;
/** A lost seize is not tried again for this long */
export const SEIZE_FAILURE_MEMORY = 20000;
/** Linear distance of a seized room from our closest owned room that can spawn its defense */
export const SEIZE_RANGE = 2;

export interface SeizeFacts {
    room: string;
    /** The player reserving or mining it */
    player: string;
    /** That player's aggression (military intel, hits dealt to us, decaying) */
    aggression: number;
    sources: number;
    /** Linear distance to our closest owned room that can defend it */
    distance: number;
    keeper: boolean;
    /** The controller has an owner */
    owned: boolean;
    /** Tick of the last lost seize of the room */
    failedAt?: number;
}

/** Another player's remote we may take: a player, not fighting us, a minable room within reach */
export function seizeCandidate(facts: SeizeFacts, now: number, hostileThreshold: number): boolean {
    if (NPCS.includes(facts.player)) return false;
    if (facts.owned || facts.keeper || facts.sources <= 0) return false;
    if (facts.distance > SEIZE_RANGE) return false;
    if (facts.aggression >= hostileThreshold) return false;
    return facts.failedAt === undefined || now - facts.failedAt >= SEIZE_FAILURE_MEMORY;
}

/** New seizes within the cap: most sources first, then the closest (candidates already filtered) */
export function pickSeizes(candidates: SeizeFacts[], active: string[], max: number): string[] {
    const free = max - active.length;
    if (free <= 0) return [];
    return candidates
        .filter(c => !active.includes(c.room))
        .sort((a, b) => b.sources - a.sources || a.distance - b.distance)
        .slice(0, free)
        .map(c => c.room);
}

/** hold: renew it; lost: they fought back; unused: the remote selection left the room out */
export function seizeStatus(state: {
    aggression: number;
    threshold: number;
    since: number;
    now: number;
    mined: boolean;
}): "hold" | "lost" | "unused" {
    if (state.aggression >= state.threshold) return "lost";
    if (!state.mined && state.now - state.since >= SEIZE_SELECT_GRACE) return "unused";
    return "hold";
}

/** What RoomIntel sees in a room it doesn't own */
export interface RoomSighting {
    /** Controller owner (an owned room is blocked anyway, never contested) */
    owner?: string;
    reserver?: string;
    /**
     * Other players' creeps: `harvests` = an active WORK part next to a source, `claims` = an active
     * CLAIM part next to the controller. Creeps only passing through don't count.
     */
    creeps: { owner: string; harvests: boolean; claims: boolean }[];
}

/**
 * The player contesting a room we don't own: their reservation, or their creeps mining or reserving it;
 * a released player's reservation (and creeps, during the grace) don't count
 */
export function contestingPlayer(
    sighting: RoomSighting,
    me: string | undefined,
    released?: { player: string; creeps: boolean }
): string | undefined {
    if (sighting.owner) return undefined;
    if (isPlayer(sighting.reserver, me) && sighting.reserver !== released?.player) return sighting.reserver;
    return sighting.creeps.find(
        c => isPlayer(c.owner, me) && (c.harvests || c.claims) && !(released?.creeps && c.owner === released.player)
    )?.owner;
}

/**
 * Records a sighting: a new (or expired) entry gets the jittered `ttl`, a live one only moves its last
 * sighting (same player or not), so the lifetime is not drawn again every tick
 */
export function noteContest(
    entries: { [room: string]: ContestEntry },
    roomName: string,
    player: string,
    time: number,
    ttl: number
): boolean {
    const entry = entries[roomName];
    if (isContested(entry, time)) {
        entry.seen = time;
        entry.player = player;
        return false;
    }
    entries[roomName] = { player, seen: time, ttl };
    return true;
}

/** Drops the expired entries */
export function pruneContests(entries: { [room: string]: ContestEntry }, time: number): void {
    for (const roomName in entries) if (!isContested(entries[roomName], time)) delete entries[roomName];
}
