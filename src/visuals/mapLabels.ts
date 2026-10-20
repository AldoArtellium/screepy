/**
 * World map labels shared by every map layer: each layer queues its texts with a priority and the
 * positions it accepts, nearest first; `flush` places them by priority (then queue order) at the
 * first position whose box overlaps no label placed yet nor a blocked area (the map panel), in world
 * coordinates so labels spilling into a neighbour room are seen too. A label with no free position
 * is drawn at its first one when `force` is set, else left out (the layer's dots and lines still
 * show the state).
 */

import { parseRoomName, roomNameFromCoords } from "../utils/rooms";

/**
 * Character widths in font units (Arial metrics: "7.4/t · 54t · 1H" at font 6 sums to 37.7 tiles,
 * 38 measured on the client map)
 */
const NARROW = " .,:;'|!()[]/·ijlftI";
const CHAR_WIDTHS: { [char: string]: number } = { r: 0.333, w: 0.722, m: 0.833, W: 0.944, M: 0.833, "%": 0.889 };
function charWidth(char: string): number {
    if (CHAR_WIDTHS[char] !== undefined) return CHAR_WIDTHS[char];
    if (NARROW.includes(char)) return 0.278;
    if (char >= "0" && char <= "9") return 0.556;
    if (char >= "A" && char <= "Z") return 0.72;
    return 0.53;
}
/** Room tiles per room on the world grid */
const ROOM_SIZE = 50;
const PADDING = 0.6;

export const LABEL_BACKDROP = "#101010";

/** Text style on a dark backdrop, readable on any terrain */
export function labelStyle(color: string, fontSize: number, opacity = 0.85): MapTextStyle {
    return { color, fontSize, backgroundColor: LABEL_BACKDROP, backgroundPadding: PADDING, opacity };
}

/** Label priorities: higher is placed first */
export const LABEL_PRIORITY = {
    owned: 50,
    threat: 40,
    home: 35,
    reservation: 20,
    source: 10,
    creep: 5
};

/** Area on the world grid, in world tiles */
export interface Box {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

interface Label {
    text: string;
    candidates: RoomPosition[];
    style: MapTextStyle;
    priority: number;
    force: boolean;
    order: number;
}

/** Width of a text without backdrop (room tiles) */
export function textWidth(text: string, fontSize: number): number {
    let width = 0;
    for (const char of text) width += charWidth(char);
    return width * fontSize;
}

/** Width and height of a label with its backdrop (room tiles) */
export function labelSize(text: string, fontSize: number): { width: number; height: number } {
    return { width: textWidth(text, fontSize) + 2 * PADDING, height: fontSize + 2 * PADDING };
}

/** World tile of a room position */
export function toWorld(pos: RoomPosition): { x: number; y: number } | undefined {
    const room = parseRoomName(pos.roomName);
    if (!room) return undefined;
    return { x: room.wx * ROOM_SIZE + pos.x, y: room.wy * ROOM_SIZE + pos.y };
}

/** Room position of a world tile, rounded (room positions are whole tiles) */
export function fromWorld(worldX: number, worldY: number): RoomPosition {
    const x = Math.round(worldX);
    const y = Math.round(worldY);
    const wx = Math.floor(x / ROOM_SIZE);
    const wy = Math.floor(y / ROOM_SIZE);
    return new RoomPosition(x - wx * ROOM_SIZE, y - wy * ROOM_SIZE, roomNameFromCoords(wx, wy));
}

/** Text centered on the position (a backdrop centers map texts vertically too) */
function boxAt(pos: RoomPosition, width: number, height: number): Box | undefined {
    const world = toWorld(pos);
    if (!world) return undefined;
    return { x1: world.x - width / 2, x2: world.x + width / 2, y1: world.y - height / 2, y2: world.y + height / 2 };
}

function overlaps(a: Box, b: Box): boolean {
    return a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
}

/** Horizontal center that keeps a label of this width inside the room when it fits */
export function clampX(x: number, width: number): number {
    const half = Math.min(width / 2 + 1, 25);
    return Math.round(Math.max(half, Math.min(49 - half, x)));
}

export class MapLabels {
    private labels: Label[] = [];
    private blocked: Box[] = [];

    /** Queues a text; candidates nearest first */
    add(text: string, candidates: RoomPosition[], style: MapTextStyle, priority: number, force = false): void {
        if (candidates.length === 0) return;
        this.labels.push({ text, candidates, style, priority, force, order: this.labels.length });
    }

    /** Keeps labels out of an area (world tiles) */
    block(box: Box): void {
        this.blocked.push(box);
    }

    /** Places and draws every queued label; returns how many were left out */
    flush(visual: MapVisual): number {
        const placed: Box[] = [...this.blocked];
        let skipped = 0;
        this.labels.sort((a, b) => b.priority - a.priority || a.order - b.order);
        for (const label of this.labels) {
            const { width, height } = labelSize(label.text, label.style.fontSize ?? 10);
            let chosen: { pos: RoomPosition; box: Box } | undefined;
            for (const pos of label.candidates) {
                const box = boxAt(pos, width, height);
                if (box && placed.every(other => !overlaps(box, other))) {
                    chosen = { pos, box };
                    break;
                }
            }
            if (!chosen && label.force) {
                const pos = label.candidates[0];
                const box = boxAt(pos, width, height);
                if (box) chosen = { pos, box };
            }
            if (!chosen) {
                skipped++;
                continue;
            }
            placed.push(chosen.box);
            visual.text(label.text, chosen.pos, label.style);
        }
        this.labels = [];
        this.blocked = [];
        return skipped;
    }
}
