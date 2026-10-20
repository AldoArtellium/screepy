/**
 * Construction settings (Hivemind settings.default.ts constructNukers, constructPowerSpawns, constructObservers,
 * constructFactories). The bot fills, fires or uses none of these structures yet, so they are off by default: the plan
 * keeps their tiles, nothing is built there. `Memory.construction = { nuker: true }` turns one on.
 */

export type ConstructionSetting = "nuker" | "powerSpawn" | "observer" | "factory";

declare global {
    interface Memory {
        /** Optional endgame structures to build (default: none) */
        construction?: { [setting in ConstructionSetting]?: boolean };
    }
}

const DEFAULTS: { [setting in ConstructionSetting]: boolean } = {
    nuker: false,
    powerSpawn: false,
    observer: false,
    factory: false
};

export function constructionEnabled(setting: ConstructionSetting): boolean {
    return Memory.construction?.[setting] ?? DEFAULTS[setting];
}

/** Changes whenever a setting changes (RoomBuilder completion key) */
export function constructionSettingsKey(): string {
    return (Object.keys(DEFAULTS) as ConstructionSetting[]).map(s => (constructionEnabled(s) ? 1 : 0)).join("");
}
