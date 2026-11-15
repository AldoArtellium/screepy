/**
 * Safe mode timing of attacks on player rooms (pure, offline check `node tests/safeMode/run.mjs`; our
 * design, 2026-11-15). shard0 2026-11-14: Blindfold safe-moded W25N7 31 ticks after our quad came in and
 * doorknobnob W26N7 the tick our remote defenders crossed it; each charge costs them a whole mission of
 * ours. A safe mode is followed by a cooldown (CONTROLLER_SAFE_MODE_COOLDOWN, 50000 ticks from its start)
 * during which none can be activated: ~30000 ticks after it ends where the room has no safe mode at all.
 *
 * - active: safe mode on, nothing to do until it ends;
 * - window: no safe mode can come before SAFE_WINDOW_MIN ticks (cooldown, or no charge left): squads go;
 * - closing: the cooldown ends within SAFE_WINDOW_MIN, a squad would meet a fresh safe mode: wait;
 * - armed: a charge can be used at any time: a cheap armed bait goes first to burn it (bait.ts), squads
 *   only once MAX_BAIT_FAILURES baits came back without one (the owner does not react to a bait).
 */

export type SafeModePhase = "active" | "window" | "closing" | "armed";
export type AttackMode = "squad" | "bait" | "wait";

/** Ticks a squad needs without a safe mode: forming (~600 for a quad), the trip and the fight */
export const SAFE_WINDOW_MIN = 5000;
/** Baits that came back without a safe mode before a squad goes anyway */
export const MAX_BAIT_FAILURES = 2;

export interface SafeModeFacts {
    /** Tick the safe mode ends */
    safeMode?: number;
    /** Tick the safe mode cooldown ends */
    safeModeCooldown?: number;
    /** Charges left (unknown on records older than 2026-11-15) */
    safeModeAvailable?: number;
}

export function safeModePhase(facts: SafeModeFacts, now: number): SafeModePhase {
    if ((facts.safeMode ?? 0) > now) return "active";
    if (facts.safeModeAvailable === undefined || facts.safeModeAvailable === 0) return "window";
    const cooldown = (facts.safeModeCooldown ?? 0) - now;
    if (cooldown >= SAFE_WINDOW_MIN) return "window";
    return cooldown > 0 ? "closing" : "armed";
}

export function attackMode(phase: SafeModePhase, baitFailures: number): AttackMode {
    if (phase === "window") return "squad";
    if (phase === "armed") return baitFailures >= MAX_BAIT_FAILURES ? "squad" : "bait";
    return "wait";
}

/**
 * Engaged targets added back while a slot is free: those with a mission, never one under safe mode
 * (`safeModed`). Before, any target with a mission came back, so a safe-moded target kept its quad poking
 * (shard0 W25N7 2026-11-14, ~310 ticks until the drain watch). A room whose last spawn fell stays: its
 * towers, loot ramparts or controller blocker are still to clear before the success (military.ts).
 */
export function refillEngaged<T extends { room: string }>(
    next: T[],
    entries: T[],
    max: number,
    hasMission: (room: string) => boolean,
    safeModed: (room: string) => boolean
): T[] {
    const result = [...next];
    for (const entry of entries) {
        if (result.length >= max) break;
        if (!result.includes(entry) && hasMission(entry.room) && !safeModed(entry.room)) result.push(entry);
    }
    return result;
}
