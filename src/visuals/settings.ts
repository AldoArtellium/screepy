/**
 * Visual layers on / off: `Memory.visuals = false` turns everything off, an object turns single
 * layers off (`Memory.visuals = { map: false }`); a layer not listed is on.
 *
 * While the remote CPU budget caps the remote rooms (`Memory.remoteMining.maxRooms` set), the costly
 * layers (plan overlay and world map layers) are off unless set to `true` explicitly: their CPU goes to
 * the economy first. Measured (mockup W7N3 `--preset rcl4 --cpu-limit 13`, CPU per tick): panel
 * 0.18-0.42, map 0.12-0.36, plan 0.06-0.17, spawn overlay 0.03-0.05.
 */

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

/** Layers dropped while the remote CPU budget is capped (panel and spawn overlay are kept) */
const COSTLY_LAYERS: ReadonlySet<VisualLayer> = new Set<VisualLayer>(["plan", "mapRemotes", "mapStrategy", "mapCreeps", "mapThreats"]);

/** The remote CPU budget holds remote rooms back (`maxRooms` undefined: uncapped) */
export function remoteBudgetCapped(): boolean {
    return Memory.remoteMining?.maxRooms !== undefined;
}

export function layerEnabled(layer: VisualLayer): boolean {
    const settings = Memory.visuals;
    if (settings === false) return false;
    const setting = typeof settings === "object" ? settings[layer] : undefined;
    if (setting !== undefined) return setting;
    return !(COSTLY_LAYERS.has(layer) && remoteBudgetCapped());
}
