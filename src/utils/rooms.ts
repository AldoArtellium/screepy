/**
 * Room name helpers: world coordinates, rooms in range, highways, source keeper rooms, room status (heap cache).
 */

import { jitter } from "./jitter";

/** World coordinates of a room (W0 = -1, E0 = 0; N0 = -1, S0 = 0), null for an invalid name */
export function parseRoomName(roomName: string): { wx: number; wy: number } | null {
    const match = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName);
    if (!match) return null;
    const x = Number(match[2]);
    const y = Number(match[4]);
    return { wx: match[1] === "W" ? -x - 1 : x, wy: match[3] === "N" ? -y - 1 : y };
}

export function roomNameFromCoords(wx: number, wy: number): string {
    const x = wx < 0 ? -wx - 1 : wx;
    const y = wy < 0 ? -wy - 1 : wy;
    return `${wx < 0 ? "W" : "E"}${x}${wy < 0 ? "N" : "S"}${y}`;
}

export function isHighway(roomName: string): boolean {
    const match = /^[WE](\d+)[NS](\d+)$/.exec(roomName);
    return !!match && (Number(match[1]) % 10 === 0 || Number(match[2]) % 10 === 0);
}

/**
 * Source keeper room by its name: the 8 rooms around a sector center (coordinates 4-6 within the sector,
 * the center 5,5 excepted). cartographer avoids the tiles within 5 of their sources and minerals, so a
 * path PathFinder found through one gets ERR_NO_PATH from cartographer (shard0 2026-10-25/26: the W27N9
 * quad in W26N5, W28N7's reservers to W27N7 in W26N6).
 */
export function isKeeperRoom(roomName: string): boolean {
    const match = /^[WE](\d+)[NS](\d+)$/.exec(roomName);
    if (!match) return false;
    const x = Number(match[1]) % 10;
    const y = Number(match[2]) % 10;
    return x >= 4 && x <= 6 && y >= 4 && y <= 6 && !(x === 5 && y === 5);
}

/** Room status (normal / novice / respawn / closed), heap cache: novice and respawn areas are walled off */
const statusCache: Map<string, { until: number; status: string }> = new Map();

export function roomStatus(roomName: string): string {
    const cached = statusCache.get(roomName);
    if (cached && cached.until > Game.time) return cached.status;
    let status = "normal";
    try {
        status = Game.map.getRoomStatus(roomName)?.status ?? "normal";
    } catch {
        // unknown room: keep "normal"
    }
    statusCache.set(roomName, { until: Game.time + jitter(1000), status });
    return status;
}

/**
 * Rooms within a linear range (center excluded) with the same status as the center room (rooms of
 * another status are behind walls: paths there fail after exploring the whole search budget)
 */
export function roomsInRange(centerRoom: string, range: number): string[] {
    const center = parseRoomName(centerRoom);
    if (!center) return [];
    const status = roomStatus(centerRoom);
    const rooms: string[] = [];
    for (let dx = -range; dx <= range; dx++) {
        for (let dy = -range; dy <= range; dy++) {
            if (dx === 0 && dy === 0) continue;
            const roomName = roomNameFromCoords(center.wx + dx, center.wy + dy);
            if (roomStatus(roomName) === status) rooms.push(roomName);
        }
    }
    return rooms;
}
