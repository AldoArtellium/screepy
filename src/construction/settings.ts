/**
 * Construction settings (Hivemind settings.default.ts constructNukers, constructPowerSpawns, constructObservers,
 * constructFactories). The factory is on, built only where the room's mineral pays a bar (resources/factory.ts
 * factoryWanted); the observer is on, it gathers room intel (modules/ObserverManager.ts); the nuker is on since
 * 2026-11-15 (filled by dispatcher/destinations.ts, fired by military/nukeStrike.ts). The bot uses no power spawn yet,
 * so it is off by default: the plan keeps its tiles, nothing is built there. `Memory.construction = { powerSpawn: true }`
 * turns it on, `{ observer: false }` or `{ nuker: false }` turns one off.
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
    observer: true,
    factory: true
};

export function constructionEnabled(setting: ConstructionSetting): boolean {
    return Memory.construction?.[setting] ?? DEFAULTS[setting];
}

/** Changes whenever a setting changes (RoomBuilder completion key) */
export function constructionSettingsKey(): string {
    return (Object.keys(DEFAULTS) as ConstructionSetting[]).map(s => (constructionEnabled(s) ? 1 : 0)).join("");
}
