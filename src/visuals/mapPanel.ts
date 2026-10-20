/**
 * World map panel: the map layers' texts gathered in a table drawn over the 3x3 source keeper rooms
 * at the center of a sector (never ours: remote mining and expansion skip keeper rooms), so the
 * rooms we use only keep dots, lines and short tags. Sections in the order the layers add them: a
 * title line (cells side by side) and rows whose cells line up in columns, on one dark backdrop.
 */

import { Box, fromWorld, LABEL_BACKDROP, textWidth } from "./mapLabels";
import { parseRoomName } from "../utils/rooms";

const TITLE_FONT = 6;
const FONT = 5;
/** Line heights (tiles) */
const TITLE_LINE = 8;
const ROW_LINE = 6;
/** Space between columns and around the content (tiles) */
const GAP = 2.5;
const MARGIN = 3;

export interface Cell {
    text: string;
    color: string;
}

interface Section {
    title: Cell[];
    rows: Cell[][];
}

/** World tile at the top-left of the 3x3 rooms at the center of the room's sector */
export function sectorCenter(roomName: string): { x: number; y: number } | undefined {
    const room = parseRoomName(roomName);
    if (!room) return undefined;
    // Rooms 4-6 of the sector on each axis; W and N numbers grow away from 0, world coordinates don't
    const axis = (w: number): number => {
        const n = w < 0 ? -w - 1 : w;
        const base = n - (n % 10);
        return Math.min(...[4, 5, 6].map(k => (w < 0 ? -(base + k) - 1 : base + k)));
    };
    return { x: axis(room.wx) * 50, y: axis(room.wy) * 50 };
}

function textStyle(color: string, fontSize: number): MapTextStyle {
    return { color, fontSize, align: "left", opacity: 0.95 };
}

export class MapPanel {
    private sections: Section[] = [];

    /** Adds a section and returns its rows, filled by the caller */
    section(title: Cell[]): Cell[][] {
        const rows: Cell[][] = [];
        this.sections.push({ title, rows });
        return rows;
    }

    /** Draws the panel from a world tile; returns its area, undefined when empty */
    draw(visual: MapVisual, origin: { x: number; y: number }): Box | undefined {
        const sections = this.sections.filter(s => s.title.length > 0 || s.rows.length > 0);
        this.sections = [];
        if (sections.length === 0) return undefined;

        const layouts = sections.map(section => {
            const columns: number[] = [];
            for (const row of section.rows)
                row.forEach((cell, i) => (columns[i] = Math.max(columns[i] ?? 0, textWidth(cell.text, FONT))));
            const rowsWidth = columns.reduce((sum, w) => sum + w + GAP, 0);
            const titleWidth = section.title.reduce((sum, cell) => sum + textWidth(cell.text, TITLE_FONT) + GAP, 0);
            const height = (section.title.length > 0 ? TITLE_LINE : 0) + section.rows.length * ROW_LINE;
            return { section, columns, width: Math.max(rowsWidth, titleWidth), height };
        });
        const width = Math.max(...layouts.map(l => l.width)) + 2 * MARGIN;
        const height = layouts.reduce((sum, l) => sum + l.height + GAP, 0) - GAP + 2 * MARGIN;
        const box = { x1: origin.x + 1, y1: origin.y + 1, x2: origin.x + 1 + width, y2: origin.y + 1 + height };
        visual.rect(fromWorld(box.x1, box.y1), width, height, {
            fill: LABEL_BACKDROP,
            opacity: 0.8,
            stroke: "#505050",
            strokeWidth: 0.4
        });

        // Texts sit on their baseline (no backdrop of their own)
        let y = box.y1 + MARGIN;
        for (const { section, columns } of layouts) {
            if (section.title.length > 0) {
                let x = box.x1 + MARGIN;
                for (const cell of section.title) {
                    visual.text(cell.text, fromWorld(x, y + TITLE_FONT * 0.8), textStyle(cell.color, TITLE_FONT));
                    x += textWidth(cell.text, TITLE_FONT) + GAP;
                }
                y += TITLE_LINE;
            }
            for (const row of section.rows) {
                let x = box.x1 + MARGIN;
                row.forEach((cell, i) => {
                    if (cell.text) visual.text(cell.text, fromWorld(x, y + FONT * 0.8), textStyle(cell.color, FONT));
                    x += columns[i] + GAP;
                });
                y += ROW_LINE;
            }
            y += GAP;
        }
        return box;
    }
}
