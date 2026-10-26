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

export function isRemoteBlocked(
    roomName: string,
    info: RemoteRoomInfo | undefined,
    me: string | undefined,
    contested = false
): boolean {
    if (isKeeperRoom(roomName) || info?.hasSourceKeepers) return true;
    if (contested) return true;
    if (!info) return false;
    if (info.owner && info.owner !== me) return true;
    return !!info.reserver && info.reserver !== me && info.reserver !== "Invader";
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

/** The player contesting a room we don't own: their reservation, or their creeps mining or reserving it */
export function contestingPlayer(sighting: RoomSighting, me: string | undefined): string | undefined {
    if (sighting.owner) return undefined;
    if (isPlayer(sighting.reserver, me)) return sighting.reserver;
    return sighting.creeps.find(c => isPlayer(c.owner, me) && (c.harvests || c.claims))?.owner;
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
