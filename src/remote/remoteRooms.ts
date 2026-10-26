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
 */

import { isKeeperRoom } from "../utils/rooms";

export interface RemoteRoomInfo {
    owner?: string;
    reserver?: string;
    hasSourceKeepers?: boolean;
}

export function isRemoteBlocked(roomName: string, info: RemoteRoomInfo | undefined, me: string | undefined): boolean {
    if (isKeeperRoom(roomName) || info?.hasSourceKeepers) return true;
    if (!info) return false;
    if (info.owner && info.owner !== me) return true;
    return !!info.reserver && info.reserver !== me && info.reserver !== "Invader";
}
