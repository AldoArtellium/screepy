/**
 * Construction settings (Hivemind settings.default.ts constructNukers, constructPowerSpawns, constructObservers,
 * constructFactories). The nuker is on since 2026-11-15 (filled by dispatcher/destinations.ts, fired by
 * military/nukeStrike.ts) and the factory, built only where the room's mineral pays a bar (resources/factory.ts
 * factoryWanted); the bot uses none of the others yet, so they are off by default: the plan keeps their tiles,
 * nothing is built there. `Memory.construction = { powerSpawn: true }` turns one on, `{ nuker: false }` off.
 */

export type ConstructionSetting = "nuker" | "powerSpawn" | "observer" | "factory";

declare global {
    interface Memory {
        /** Optional endgame structures to build (default: none) */
        construction?: { [setting in ConstructionSetting]?: boolean };
    }
}

const DEFAULTS: { [setting in ConstructionSetting]: boolean } = {
    nuker: true,
    powerSpawn: false,
    observer: false,
    factory: true
};

export function constructionEnabled(setting: ConstructionSetting): boolean {
    return Memory.construction?.[setting] ?? DEFAULTS[setting];
}

/** Changes whenever a setting changes (RoomBuilder completion key) */
export function constructionSettingsKey(): string {
    return (Object.keys(DEFAULTS) as ConstructionSetting[]).map(s => (constructionEnabled(s) ? 1 : 0)).join("");
}
