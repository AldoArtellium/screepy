/**
 * Compact path encoding for Memory: `room:x:y:` then one direction digit (1-8, TOP..TOP_LEFT) per
 * step, in world coordinates so steps across room exits (x 49 -> 0...) decode to the same
 * positions. A step that isn't to an adjacent world tile starts a new `|room:x:y:` segment.
 * ~1 char per tile instead of ~12 for "W7N3,12,34;".
 */

/** [dx, dy] by direction constant (1 = TOP ... 8 = TOP_LEFT) */
const OFFSETS: [number, number][] = [[0, 0], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];

/** World coordinates of a room's (0, 0) tile: E0 starts at 0, W0 at -50; S0 at 0, N0 at -50 */
function roomOrigin(roomName: string): [number, number] {
    const match = /^([WE])(\d+)([NS])(\d+)$/.exec(roomName);
    if (!match) throw new Error(`Bad room name ${roomName}`);
    const x = match[1] === "E" ? Number(match[2]) : -Number(match[2]) - 1;
    const y = match[3] === "S" ? Number(match[4]) : -Number(match[4]) - 1;
    return [x * 50, y * 50];
}

function roomAt(worldX: number, worldY: number): string {
    const rx = Math.floor(worldX / 50);
    const ry = Math.floor(worldY / 50);
    return `${rx >= 0 ? `E${rx}` : `W${-rx - 1}`}${ry >= 0 ? `S${ry}` : `N${-ry - 1}`}`;
}

export function encodePath(path: { x: number; y: number; roomName: string }[]): string {
    let out = "";
    let last: [number, number] | null = null;
    for (const pos of path) {
        const [ox, oy] = roomOrigin(pos.roomName);
        const world: [number, number] = [ox + pos.x, oy + pos.y];
        const [sx, sy] = last ? [world[0] - last[0], world[1] - last[1]] : [0, 0];
        const dir = OFFSETS.findIndex(([dx, dy], i) => i > 0 && dx === sx && dy === sy);
        if (dir > 0) out += dir;
        else out += `${out ? "|" : ""}${pos.roomName}:${pos.x}:${pos.y}:`;
        last = world;
    }
    return out;
}

export function decodePath(packed: string): RoomPosition[] {
    const path: RoomPosition[] = [];
    if (!packed) return path;
    for (const segment of packed.split("|")) {
        const [roomName, x, y, steps] = segment.split(":");
        const [ox, oy] = roomOrigin(roomName);
        let wx = ox + Number(x);
        let wy = oy + Number(y);
        path.push(new RoomPosition(Number(x), Number(y), roomName));
        for (let i = 0; i < steps.length; i++) {
            const [dx, dy] = OFFSETS[steps.charCodeAt(i) - 48];
            wx += dx;
            wy += dy;
            const room = roomAt(wx, wy);
            const [rx, ry] = roomOrigin(room);
            path.push(new RoomPosition(wx - rx, wy - ry, room));
        }
    }
    return path;
}
