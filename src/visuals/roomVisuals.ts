/**
 * RoomVisuals - draws on every owned room: the unbuilt part of the plan (refreshed every
 * PLAN_INTERVAL ticks or when the plan changes), the economy / room info panel (every
 * panelInterval() ticks) and the spawn overlay (every tick); on the world map the remote mining and
 * strategy layers (every mapInterval() ticks). Cached layers are kept in the heap as exports and
 * imported on the other ticks, so a tick costs one import per layer. `Memory.visuals = false` turns
 * it off, `Memory.visuals = { mapRemotes: false, ... }` single layers (`settings.ts`). The map texts go
 * to a panel over the center of the first owned room's sector (`mapPanel.ts`; `mapPanel: false` puts
 * them back on the rooms), the rest through the shared label placer (`mapLabels.ts`).
 * Runs every tick (visuals last one tick): only the redraws wait while the bucket is low, the cached
 * layers are still imported; below STOP_BUCKET nothing is drawn. Under CPU pressure (remote budget capped or
 * CPU average above 85% of the limit) the plan and map creeps are off and the map and panel are redrawn
 * less often, the map at once when a watched room gains or loses hostiles (`settings.ts`). The module logs its CPU per layer (map redraws and cached map imports
 * apart) every LOG_INTERVAL ticks.
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
import { drawMapThreats, threatSignature } from "./mapThreats";
import { drawPanel, sampleIncome } from "./panel";
import { drawPlan } from "./planVisual";
import { layerEnabled, mapInterval, panelInterval, visualsEnabled } from "./settings";
import { drawSpawns } from "./spawnVisual";

const PLAN_INTERVAL = 100;
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
let mapCache: (Layer & { threats: string }) | undefined;
/** World map redraws since the last log */
let mapRedraws = 0;
/** CPU used since the last log, for the average in the log line */
let cpuUsed = 0;
let cpuTicks = 0;
/** CPU per layer since the last log (map = redraws of every world map layer, mapImport = cached map imports) */
const layerCpu: Record<"plan" | "panel" | "spawn" | "map" | "mapImport", number> = {
    plan: 0,
    panel: 0,
    spawn: 0,
    map: 0,
    mapImport: 0
};

/** Runs a layer and adds its CPU to the layer's total */
function timed(layer: keyof typeof layerCpu, run: () => void): void {
    const start = Game.cpu.getUsed();
    run();
    layerCpu[layer] += Game.cpu.getUsed() - start;
}

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
    const state = cache.get(room.name) ?? {};
    cache.set(room.name, state);

    const redraw = decisionBucket() >= REDRAW_BUCKET;
    timed("plan", () => drawPlanLayer(room, state, redraw));
    timed("panel", () => drawPanelLayer(room, state, redraw));
    if (layerEnabled("spawn")) timed("spawn", () => drawSpawns(room.visual, room));

    if (Game.time % LOG_INTERVAL === 0) {
        const all = exported(room.visual);
        log.info(
            "Visuals",
            `${room.name}: plan ${elements(state.plan?.data ?? "")} elements, panel ${elements(state.panel?.data ?? "")}, ` +
                `room visual ${elements(all)} elements / ${all.length} chars`
        );
    }
}

function drawPlanLayer(room: Room, state: RoomCache, redraw: boolean): void {
    const plan = roomPlanner.getPlan(room.name);
    if (!layerEnabled("plan")) {
        state.plan = undefined;
    } else if (!state.plan || (redraw && (state.plan.source !== plan || Game.time - state.plan.tick >= PLAN_INTERVAL))) {
        const data = plan ? capture(room.name, visual => drawPlan(visual, room, plan)) : "";
        state.plan = { tick: Game.time, data, source: plan };
    } else if (state.plan.data) {
        room.visual.import(state.plan.data);
    }
}

function drawPanelLayer(room: Room, state: RoomCache, redraw: boolean): void {
    if (!layerEnabled("panel")) {
        state.panel = undefined;
    } else if (!state.panel || (redraw && Game.time - state.panel.tick >= panelInterval())) {
        state.panel = { tick: Game.time, data: capture(room.name, visual => drawPanel(visual, room)) };
    } else {
        room.visual.import(state.panel.data);
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
    // A room gaining or losing hostiles is redrawn at once, whatever the interval
    const threatState = threats ? threatSignature() : "";
    const due = !mapCache || Game.time - mapCache.tick >= mapInterval() || mapCache.threats !== threatState;
    if (!mapCache || (redraw && due)) timed("map", () => redrawMap(remotes, strategy, creeps, threats, threatState));
    else if (mapCache.data) timed("mapImport", () => Game.map.visual.import(mapCache!.data));
    if (Game.time % LOG_INTERVAL === 0 && mapCache) {
        log.info("Visuals", `map ${elements(mapCache.data)} elements / ${mapCache.data.length} chars, ${mapRedraws} redraws`);
        mapRedraws = 0;
    }
}

function redrawMap(remotes: boolean, strategy: boolean, creeps: boolean, threats: boolean, threatState: string): void {
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
    mapCache = { tick: Game.time, data: visual.export() ?? "", threats: threatState };
    mapRedraws++;
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
        const perLayer = Object.entries(layerCpu)
            .map(([layer, cpu]) => `${layer} ${(cpu / cpuTicks).toFixed(3)}`)
            .join(", ");
        log.info("Visuals", `average CPU ${(cpuUsed / cpuTicks).toFixed(3)} over ${cpuTicks} ticks (${perLayer})`);
        cpuUsed = 0;
        cpuTicks = 0;
        for (const layer in layerCpu) layerCpu[layer as keyof typeof layerCpu] = 0;
    }
};
