/**
 * Which players we may attack automatically (targets.ts), pure functions (tests/militaryRoi/run.mjs).
 *
 * - Strength: the game API gives no other player's GCL, so a player's size is the number of rooms we
 *   have seen owned by them (military intel and static intel, seen within ROOMS_SEEN_AGE). A player with
 *   more rooms than we own looks stronger (likely a higher GCL, more spawns to answer with): shard0
 *   2026-10-26, Blindfold (GCL ~9, 6+ rooms seen) against our 4 rooms, after our duo destroyed its RCL 2
 *   room W25N7. A lower bound (rooms never scouted don't count), so it only errs towards attacking.
 * - Aggression: damage their creeps dealt to ours (creeps, and structures in our owned and remote rooms),
 *   from the room event log (EVENT_ATTACK, our hits back on them left out), decaying like infamy. Unlike
 *   infamy (energy value of every creep of theirs seen in our rooms: scouts, harvesters and reservers
 *   included), only real hostile acts count. A stronger player that hurt us recently is fair game again.
 * Our design.
 */

/** Rooms seen owned longer ago than this are not counted (military intel forgets hostile rooms after 50000) */
export const ROOMS_SEEN_AGE = 50000;
/** Damage (hits) from which a player counts as hostile: ~one tower shot, or a 1-ATTACK creep for 10 ticks */
export const AGGRESSION_HOSTILE = 300;
/** Aggression decays like infamy: x AGGRESSION_DECAY every AGGRESSION_DECAY_EVERY ticks, dropped below 1 */
export const AGGRESSION_DECAY = 0.95;
export const AGGRESSION_DECAY_EVERY = 1000;

/** Room event constants (literals: the module stays pure for the offline check) */
const EVENT_ATTACK_ID = 1;
const ATTACK_TYPE_HIT_BACK = 5;

export interface OwnedRoomSeen {
    room: string;
    owner?: string;
    /** Tick the owner was seen */
    seen: number;
}

/** Distinct rooms of each player seen within ROOMS_SEEN_AGE (a room listed twice counts once, the freshest owner wins) */
export function playerRoomCounts(
    seen: OwnedRoomSeen[],
    now: number,
    maxAge = ROOMS_SEEN_AGE
): { [player: string]: number } {
    const latest: { [room: string]: OwnedRoomSeen } = {};
    for (const entry of seen) {
        if (now - entry.seen > maxAge) continue;
        const previous = latest[entry.room];
        if (!previous || entry.seen > previous.seen) latest[entry.room] = entry;
    }
    const counts: { [player: string]: number } = {};
    for (const { owner } of Object.values(latest)) if (owner) counts[owner] = (counts[owner] ?? 0) + 1;
    return counts;
}

export function looksStronger(theirRooms: number, ourRooms: number): boolean {
    return theirRooms > ourRooms;
}

export function isAggressive(aggression: number): boolean {
    return aggression >= AGGRESSION_HOSTILE;
}

/** A player's room is an automatic target unless the player looks stronger and has not attacked us */
export function mayTargetPlayer(theirRooms: number, ourRooms: number, aggression: number): boolean {
    return !looksStronger(theirRooms, ourRooms) || isAggressive(aggression);
}

export interface AttackEventItem {
    event: number;
    objectId: string;
    data?: { targetId?: string; damage?: number; attackType?: number };
}

/**
 * Damage per player in one room's event log: attacks by a creep `ownerOf` knows (a player's, not ours)
 * on an object `isOurs` accepts. Hits back (our melee creep's attack answered) are ours, not theirs.
 */
export function aggressionFromEvents(
    events: AttackEventItem[],
    ownerOf: (id: string) => string | undefined,
    isOurs: (id: string) => boolean
): { [player: string]: number } {
    const damage: { [player: string]: number } = {};
    for (const { event, objectId, data } of events) {
        if (event !== EVENT_ATTACK_ID || !data?.targetId || !data.damage) continue;
        if (data.attackType === ATTACK_TYPE_HIT_BACK) continue;
        const owner = ownerOf(objectId);
        if (!owner || !isOurs(data.targetId)) continue;
        damage[owner] = (damage[owner] ?? 0) + data.damage;
    }
    return damage;
}

/** Decay every AGGRESSION_DECAY_EVERY ticks (in place), players below 1 dropped */
export function decayAggression(aggression: { [player: string]: number }, factor = AGGRESSION_DECAY): void {
    for (const player in aggression) {
        aggression[player] *= factor;
        if (aggression[player] < 1) delete aggression[player];
    }
}
