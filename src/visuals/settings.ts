/**
 * Visual layers on / off: `Memory.visuals = false` turns everything off, an object turns single
 * layers off (`Memory.visuals = { map: false }`); a layer not listed is on.
 *
 * Under CPU pressure (`cpuPressure`: the remote CPU budget caps the remote rooms, or the CPU average is
 * above 85% of the limit) the plan overlay and the map creeps are off unless set to `true` explicitly,
 * the other world map layers are redrawn every MAP_INTERVAL_REDUCED ticks instead of MAP_INTERVAL and
 * the panel every PANEL_INTERVAL_REDUCED instead of PANEL_INTERVAL (the cached export is imported in
 * between). shard0 sits at 80-95% of its CPU limit, often uncapped (the budget turns spare CPU into
 * remote rooms): gating on the cap alone left the visuals at full cost there. Measured (mockup W7N3
 * `--preset rcl4 --cpu-limit 13`, CPU per tick): panel 0.18-0.42, map 0.12-0.36, plan 0.06-0.17, spawn
 * overlay 0.03-0.05.
 */

import { cpuPressure } from "../remote/remoteIncome";

export type VisualLayer =
    | "panel"
    | "plan"
    | "spawn"
    | "mapRemotes"
    | "mapStrategy"
    | "mapCreeps"
    | "mapThreats"
    | "mapPanel";

declare global {
    interface Memory {
        /** false: no visuals; an object: layers set to false are not drawn */
        visuals?: boolean | { [layer in VisualLayer]?: boolean };
    }
}

export function visualsEnabled(): boolean {
    return Memory.visuals !== false;
}

/** Layers dropped under CPU pressure (the other map layers and the panel are redrawn less often) */
const COSTLY_LAYERS: ReadonlySet<VisualLayer> = new Set<VisualLayer>(["plan", "mapCreeps"]);

/** World map and panel redraw intervals in ticks, normal / under CPU pressure */
const MAP_INTERVAL = 20;
const MAP_INTERVAL_REDUCED = 200;
const PANEL_INTERVAL = 5;
const PANEL_INTERVAL_REDUCED = 20;

export function layerEnabled(layer: VisualLayer): boolean {
    const settings = Memory.visuals;
    if (settings === false) return false;
    const setting = typeof settings === "object" ? settings[layer] : undefined;
    if (setting !== undefined) return setting;
    return !(COSTLY_LAYERS.has(layer) && cpuPressure());
}

export function mapInterval(): number {
    return cpuPressure() ? MAP_INTERVAL_REDUCED : MAP_INTERVAL;
}

export function panelInterval(): number {
    return cpuPressure() ? PANEL_INTERVAL_REDUCED : PANEL_INTERVAL;
}
