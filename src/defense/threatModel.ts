/**
 * Threat score of a hostile creep from plain numbers (no game objects: offline check
 * node tests/threat/run.mjs). See defense/threat.ts for how the inputs are read from a room.
 */

/** Touching one of our structures: dismantling or hitting it */
export const ACTIVE_FACTOR = 2;
/** Within CRITICAL_RANGE of a spawn, the storage, a tower or the controller */
export const CRITICAL_FACTOR = 1.5;
export const CRITICAL_RANGE = 3;
/** Share of its most threatening patient's threat a healer carries */
export const MEDIC_SHARE = 0.5;

export interface ThreatInput {
    /** Attack power (ATTACK, RANGED_ATTACK, CLAIM, WORK as dismantle), boosts included */
    power: number;
    /** Heal power (HEAL_POWER per part), boosts included */
    heal: number;
    /** In reach of one of our structures (range 1, 3 with ranged parts) */
    active: boolean;
    /** Within CRITICAL_RANGE of a spawn, the storage, a tower or the controller */
    critical: boolean;
    /** Highest own threat among the other hostiles within 3 (healers only) */
    patientThreat: number;
}

/** Threat without the healing share: what this creep does to us by itself */
export function ownThreat(input: ThreatInput): number {
    return input.power * (input.active ? ACTIVE_FACTOR : 1) * (input.critical ? CRITICAL_FACTOR : 1);
}

export function threatScore(input: ThreatInput): number {
    const healing = input.heal > 0 ? input.heal + MEDIC_SHARE * input.patientThreat : 0;
    return ownThreat(input) + healing;
}
