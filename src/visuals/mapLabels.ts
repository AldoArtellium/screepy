/**
 * World map labels shared by every map layer: each layer queues its texts with a priority and the
 * positions it accepts, nearest first; `flush` places them by priority (then queue order) at the
 * first position whose box overlaps no label placed yet, in world coordinates so labels spilling
 * into a neighbour room are seen too. A label with no free position is drawn at its first one when
 * `force` is set, else left out (the layer's dots and lines still show the state).
 */

import { parseRoomName } from "../utils/rooms";

/** Map text width per character, in room tiles per font unit (measured on the map at font 6) */
const CHAR_WIDTH = 0.42;
/** Room tiles per room on the world grid (a room is 50 tiles, a 1-tile gap keeps labels apart) */
const ROOM_SIZE = 50;

export const LABEL_BACKDROP = "#101010";

/** Text style on a dark backdrop, readable on any terrain */
export function labelStyle(color: string, fontSize: number, opacity = 0.85): MapTextStyle {
    return { color, fontSize, backgroundColor: LABEL_BACKDROP, backgroundPadding: 0.6, opacity };
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

interface Box {
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

/** Width and height of a label (room tiles) */
export function labelSize(text: string, fontSize: number): { width: number; height: number } {
    const padding = 2 * 0.6;
    return { width: text.length * CHAR_WIDTH * fontSize + padding, height: fontSize + padding };
}

/** Text centered horizontally on x, the box mostly above y (map texts sit on their baseline) */
function boxAt(pos: RoomPosition, width: number, height: number): Box | undefined {
    const room = parseRoomName(pos.roomName);
    if (!room) return undefined;
    const x = room.wx * ROOM_SIZE + pos.x;
    const y = room.wy * ROOM_SIZE + pos.y;
    return { x1: x - width / 2, x2: x + width / 2, y1: y - height * 0.75, y2: y + height * 0.25 };
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

    /** Queues a text; candidates nearest first */
    add(text: string, candidates: RoomPosition[], style: MapTextStyle, priority: number, force = false): void {
        if (candidates.length === 0) return;
        this.labels.push({ text, candidates, style, priority, force, order: this.labels.length });
    }

    /** Places and draws every queued label; returns how many were left out */
    flush(visual: MapVisual): number {
        const placed: Box[] = [];
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
        return skipped;
    }
}
