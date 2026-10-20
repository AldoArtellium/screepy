/**
 * RoomVisuals - draws on every owned room: the unbuilt part of the plan (refreshed every
 * PLAN_INTERVAL ticks or when the plan changes), the economy / room info panel (every
 * PANEL_INTERVAL ticks) and the spawn overlay (every tick); on the world map the remote mining and
 * strategy layers (every MAP_INTERVAL ticks). Cached layers are kept in the heap as exports and
 * imported on the other ticks, so a tick costs one import per layer. `Memory.visuals = false` turns
 * it off, `Memory.visuals = { mapRemotes: false, ... }` single layers (`settings.ts`). The map texts go
 * to a panel over the center of the first owned room's sector (`mapPanel.ts`; `mapPanel: false` puts
 * them back on the rooms), the rest through the shared label placer (`mapLabels.ts`).
 * Runs every tick (visuals last one tick): only the redraws wait while the bucket is low, the cached
 * layers are still imported; below STOP_BUCKET nothing is drawn.
 */

import { roomPlanner } from "../planner/RoomPlanner";
import { RoomPlan } from "../planner/RoomPlan";
import { log } from "../utils/logger";
import { decisionBucket } from "../utils/throttle";
import { drawMapCreeps } from "./mapCreeps";
import { MapLabels } from "./mapLabels";
import { MapPanel, sectorCenter } from "./mapPanel";
import { drawMapRemotes } from "./mapRemotes";
import { drawMapStrategy } from "./mapStrategy";
import { drawMapThreats } from "./mapThreats";
import { drawPanel, sampleIncome } from "./panel";
import { drawPlan } from "./planVisual";
import { layerEnabled, visualsEnabled } from "./settings";
import { drawSpawns } from "./spawnVisual";

const PLAN_INTERVAL = 100;
const PANEL_INTERVAL = 5;
const MAP_INTERVAL = 20;
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
let mapCache: Layer | undefined;
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

    const redraw = decisionBucket() >= REDRAW_BUCKET;
    const plan = roomPlanner.getPlan(room.name);
    if (!layerEnabled("plan")) {
        state.plan = undefined;
    } else if (!state.plan || (redraw && (state.plan.source !== plan || Game.time - state.plan.tick >= PLAN_INTERVAL))) {
        const data = plan ? capture(room.name, visual => drawPlan(visual, room, plan)) : "";
        state.plan = { tick: Game.time, data, source: plan };
    } else if (state.plan.data) {
        room.visual.import(state.plan.data);
    }

    if (!layerEnabled("panel")) {
        state.panel = undefined;
    } else if (!state.panel || (redraw && Game.time - state.panel.tick >= PANEL_INTERVAL)) {
        state.panel = { tick: Game.time, data: capture(room.name, visual => drawPanel(visual, room)) };
    } else {
        room.visual.import(state.panel.data);
    }

    if (layerEnabled("spawn")) drawSpawns(room.visual, room);

    if (Game.time % LOG_INTERVAL === 0) {
        const all = exported(room.visual);
        log.info(
            "Visuals",
            `${room.name}: plan ${elements(state.plan?.data ?? "")} elements, panel ${elements(state.panel?.data ?? "")}, ` +
                `room visual ${elements(all)} elements / ${all.length} chars`
        );
    }
}

/** World map layers, cached together (Game.map.visual holds nothing else) */
function drawMap(): void {
    const remotes = layerEnabled("mapRemotes");
    const strategy = layerEnabled("mapStrategy");
    const creeps = layerEnabled("mapCreeps");
    const threats = layerEnabled("mapThreats");
    if (!remotes && !strategy && !creeps && !threats) {
        mapCache = undefined;
        return;
    }
    const redraw = decisionBucket() >= REDRAW_BUCKET;
    if (!mapCache || (redraw && Game.time - mapCache.tick >= MAP_INTERVAL)) {
        const visual = Game.map.visual;
        visual.clear();
        const labels = new MapLabels();
        // The panel sits on the center of the first owned room's sector
        const firstOwned = Object.keys(Game.rooms)
            .filter(name => Game.rooms[name].controller?.my)
            .sort()[0];
        const origin = firstOwned && layerEnabled("mapPanel") ? sectorCenter(firstOwned) : undefined;
        const panel = origin ? new MapPanel() : undefined;
        if (remotes) drawMapRemotes(visual, labels, panel);
        if (strategy) drawMapStrategy(visual, labels, panel);
        if (threats) drawMapThreats(visual, labels, panel);
        if (creeps) drawMapCreeps(visual, labels);
        const area = panel && origin ? panel.draw(visual, origin) : undefined;
        if (area) labels.block(area);
        labels.flush(visual);
        mapCache = { tick: Game.time, data: visual.export() ?? "" };
    } else if (mapCache.data) {
        Game.map.visual.import(mapCache.data);
    }
    if (Game.time % LOG_INTERVAL === 0) {
        log.info("Visuals", `map ${elements(mapCache.data)} elements / ${mapCache.data.length} chars`);
    }
}

export const roomVisualsModule = (): void => {
    if (!visualsEnabled() || decisionBucket() < STOP_BUCKET) return;
    const start = Game.cpu.getUsed();
    sampleIncome();
    for (const name in Game.rooms) {
        const room = Game.rooms[name];
        if (room.controller?.my) drawRoom(room);
    }
    // Rooms lost or no longer visible
    for (const name of cache.keys()) if (!Game.rooms[name]?.controller?.my) cache.delete(name);
    drawMap();

    cpuUsed += Game.cpu.getUsed() - start;
    cpuTicks++;
    if (Game.time % LOG_INTERVAL === 0) {
        log.info("Visuals", `average CPU ${(cpuUsed / cpuTicks).toFixed(3)} over ${cpuTicks} ticks`);
        cpuUsed = 0;
        cpuTicks = 0;
    }
};
