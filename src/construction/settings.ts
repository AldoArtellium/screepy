/**
 * Construction settings (Hivemind settings.default.ts constructNukers, constructPowerSpawns, constructObservers,
 * constructFactories). The factory is on, built only where the room's mineral pays a bar (resources/factory.ts
 * factoryWanted); the observer is on, it gathers room intel (modules/ObserverManager.ts). The bot fills or fires
 * neither the nuker nor the power spawn yet, so they are off by default: the plan keeps their tiles, nothing is built
 * there. `Memory.construction = { nuker: true }` turns one on, `{ observer: false }` turns the observer off.
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
