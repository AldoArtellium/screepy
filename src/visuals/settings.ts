/**
 * Visual layers on / off: `Memory.visuals = false` turns everything off, an object turns single
 * layers off (`Memory.visuals = { map: false }`); a layer not listed is on.
 */

export type VisualLayer = "panel" | "plan" | "spawn" | "mapRemotes" | "mapStrategy";

declare global {
    interface Memory {
        /** false: no visuals; an object: layers set to false are not drawn */
        visuals?: boolean | { [layer in VisualLayer]?: boolean };
    }
}

export function visualsEnabled(): boolean {
    return Memory.visuals !== false;
}

export function layerEnabled(layer: VisualLayer): boolean {
    const settings = Memory.visuals;
    if (settings === false) return false;
    if (settings === undefined || settings === true) return true;
    return settings[layer] !== false;
}
