/**
 * RoomVisuals - draws on every owned room: the unbuilt part of the plan (refreshed every
 * PLAN_INTERVAL ticks or when the plan changes) and the economy / room info panel (every
 * PANEL_INTERVAL ticks). Both are cached in the heap as RoomVisual exports and imported on the
 * other ticks, so a tick costs one import per layer. `Memory.visuals = false` turns it off.
 * Runs every tick (visuals last one tick): only the redraws wait while the bucket is low, the cached
 * layers are still imported; below STOP_BUCKET nothing is drawn.
 */

import { roomPlanner } from "../planner/RoomPlanner";
import { RoomPlan } from "../planner/RoomPlan";
import { log } from "../utils/logger";
import { drawPanel, sampleIncome } from "./panel";
import { drawPlan } from "./planVisual";

declare global {
    interface Memory {
        /** false: no room visuals */
        visuals?: boolean;
    }
}

const PLAN_INTERVAL = 100;
const PANEL_INTERVAL = 5;
const LOG_INTERVAL = 1000;
/** Below this bucket the layers are no longer redrawn (kept as they are) */
const REDRAW_BUCKET = 5000;
const STOP_BUCKET = 2000;

interface Layer {
    tick: number;
    data: string;
}

interface RoomCache {
    plan?: Layer & { source: RoomPlan | null };
    panel?: Layer;
}

const cache: Map<string, RoomCache> = new Map();
/** CPU used since the last log, for the average in the log line */
let cpuUsed = 0;
let cpuTicks = 0;

/** Visuals drawn in the room this tick ("" when none: export() then returns undefined) */
function exported(visual: RoomVisual): string {
    return (visual.export() as string | undefined) ?? "";
}

/** Draws on a fresh RoomVisual and returns only what was added (other modules may have drawn already) */
function capture(roomName: string, draw: (visual: RoomVisual) => void): string {
    const visual = new RoomVisual(roomName);
    const before = exported(visual).length;
    draw(visual);
    return exported(visual).slice(before);
}

function elements(data: string): number {
    return data ? data.split("\n").filter(line => line).length : 0;
}

function drawRoom(room: Room): void {
    let state = cache.get(room.name);
    if (!state) {
        state = {};
        cache.set(room.name, state);
    }

    const redraw = Game.cpu.bucket >= REDRAW_BUCKET;
    const plan = roomPlanner.getPlan(room.name);
    if (!state.plan || (redraw && (state.plan.source !== plan || Game.time - state.plan.tick >= PLAN_INTERVAL))) {
        const data = plan ? capture(room.name, visual => drawPlan(visual, room, plan)) : "";
        state.plan = { tick: Game.time, data, source: plan };
    } else if (state.plan.data) {
        room.visual.import(state.plan.data);
    }

    if (!state.panel || (redraw && Game.time - state.panel.tick >= PANEL_INTERVAL)) {
        state.panel = { tick: Game.time, data: capture(room.name, visual => drawPanel(visual, room)) };
    } else {
        room.visual.import(state.panel.data);
    }

    if (Game.time % LOG_INTERVAL === 0) {
        const all = exported(room.visual);
        log.info(
            "Visuals",
            `${room.name}: plan ${elements(state.plan.data)} elements, panel ${elements(state.panel.data)}, ` +
                `room visual ${elements(all)} elements / ${all.length} chars`
        );
    }
}

export const roomVisualsModule = (): void => {
    if (Memory.visuals === false || Game.cpu.bucket < STOP_BUCKET) return;
    const start = Game.cpu.getUsed();
    sampleIncome();
    for (const name in Game.rooms) {
        const room = Game.rooms[name];
        if (room.controller?.my) drawRoom(room);
    }
    // Rooms lost or no longer visible
    for (const name of cache.keys()) if (!Game.rooms[name]?.controller?.my) cache.delete(name);

    cpuUsed += Game.cpu.getUsed() - start;
    cpuTicks++;
    if (Game.time % LOG_INTERVAL === 0) {
        log.info("Visuals", `average CPU ${(cpuUsed / cpuTicks).toFixed(3)} over ${cpuTicks} ticks`);
        cpuUsed = 0;
        cpuTicks = 0;
    }
};
