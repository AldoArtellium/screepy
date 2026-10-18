/**
 * Room name helpers: world coordinates, rooms in range, highways, room status (heap cache).
 */

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

/** Room status (normal / novice / respawn / closed), heap cache: novice and respawn areas are walled off */
const statusCache: Map<string, { tick: number; status: string }> = new Map();

export function roomStatus(roomName: string): string {
    const cached = statusCache.get(roomName);
    if (cached && Game.time - cached.tick < 1000) return cached.status;
    let status = "normal";
    try {
        status = Game.map.getRoomStatus(roomName)?.status ?? "normal";
    } catch {
        // unknown room: keep "normal"
    }
    statusCache.set(roomName, { tick: Game.time, status });
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
