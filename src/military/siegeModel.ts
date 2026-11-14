/**
 * Controller siege model (pure: no Game globals, checked offline by tests/militarySiege/run.mjs).
 *
 * Engine rules (screeps engine processor/intents/creeps/attackController.js, controllers/tick.js): each
 * CLAIM part removes CONTROLLER_CLAIM_DOWNGRADE (300) ticks from the downgrade timer and blocks the owner's
 * upgrades (and our next attack) CONTROLLER_ATTACK_BLOCKED_UPGRADE (1000) ticks; when the timer runs out the
 * level drops and the timer gets CONTROLLER_DOWNGRADE[newLevel] / 2 added to what is left (an overshoot
 * carries over, several levels can drop at once); at level 0 the room is neutral. A CLAIM creep lives 600
 * ticks: one attacker per 1000-tick cycle. Our design.
 */

/** CONTROLLER_DOWNGRADE (engine constants), here so the model runs offline */
export const DOWNGRADE_TICKS: { [level: number]: number } = {
    1: 20000,
    2: 10000,
    3: 20000,
    4: 40000,
    5: 80000,
    6: 120000,
    7: 150000,
    8: 200000
};

/** CONTROLLER_CLAIM_DOWNGRADE: timer ticks removed per CLAIM part */
export const CLAIM_DOWNGRADE = 300;
/** CONTROLLER_ATTACK_BLOCKED_UPGRADE: ticks between two attacks */
export const ATTACK_CYCLE = 1000;
/** A siege longer than this is not started (each cycle costs a claimer, each 1500 ticks a guard) */
export const SIEGE_MAX_TICKS = 60000;
/** Cost of a CLAIM part and its MOVE part */
export const CLAIM_PAIR_COST = 650;
/** MAX_CREEP_SIZE / 2: CLAIM + MOVE pairs */
const MAX_CLAIM_PARTS = 25;
/** Guard lifetime (CREEP_LIFE_TIME) */
export const GUARD_LIFE = 1500;
/** Ticks per room of a siege creep's travel */
export const TRAVEL_PER_ROOM = 50;
/** Ticks an attacker may be early at the controller (it waits there; it lives 600 ticks) */
export const ATTACKER_MARGIN = 50;

/** CLAIM parts of the controller attacker a base of this energy capacity builds (one MOVE each) */
export function siegeClaimParts(capacity: number): number {
    return Math.max(0, Math.min(MAX_CLAIM_PARTS, Math.floor(capacity / CLAIM_PAIR_COST)));
}

/** Spawn cost of a controller attacker with `parts` CLAIM parts */
export function claimerCost(parts: number): number {
    return parts * CLAIM_PAIR_COST;
}

/**
 * Ticks until the controller reaches level 0 when its owner never upgrades again and we attack it every
 * ATTACK_CYCLE ticks starting now with `claimParts` CLAIM parts (Infinity without CLAIM parts or level)
 */
export function siegeTicks(level: number, ticksToDowngrade: number, claimParts: number): number {
    if (level <= 0) return 0;
    if (claimParts <= 0 || !DOWNGRADE_TICKS[level]) return Infinity;
    let timer = ticksToDowngrade;
    let elapsed = 0;
    for (;;) {
        // Attack at `elapsed`
        timer -= claimParts * CLAIM_DOWNGRADE;
        let left = ATTACK_CYCLE;
        for (;;) {
            while (timer <= 0 && level > 0) {
                level--;
                if (level === 0) return elapsed;
                timer += DOWNGRADE_TICKS[level] / 2;
            }
            if (timer > left) {
                timer -= left;
                elapsed += left;
                break;
            }
            elapsed += timer;
            left -= timer;
            timer = 0;
        }
    }
}

/** Energy of a siege: a claimer every ATTACK_CYCLE ticks, a guard every GUARD_LIFE ticks */
export function siegeCost(ticks: number, claimer: number, guard: number): number {
    if (!isFinite(ticks)) return Infinity;
    return Math.ceil(ticks / ATTACK_CYCLE) * claimer + Math.ceil(ticks / GUARD_LIFE) * guard;
}

/**
 * Ticks a siege creep needs from a base `routeRooms` rooms away, spawning included: TRAVEL_PER_ROOM per room
 * of the route plus one more for the walk inside the base and the target room
 */
export function arrivalTicks(routeRooms: number, bodyParts: number, spawnTimePerPart = 3): number {
    return (routeRooms + 1) * TRAVEL_PER_ROOM + bodyParts * spawnTimePerPart;
}

/** The controller attacker should spawn now: it stands next to the controller when the upgrade block ends */
export function attackerDue(nextAttack: number, now: number, arrival: number, margin = ATTACKER_MARGIN): boolean {
    return nextAttack - now <= arrival + margin;
}

/** The guard's replacement should spawn now: it arrives as the current one dies */
export function guardDue(ticksToLive: number, arrival: number): boolean {
    return ticksToLive < arrival;
}
