/**
 * Why we would attack a room automatically (targets.ts): only for what serves our growth, never for its
 * loot or for the creeps of its owner we saw. Pure functions (tests/militaryRoi/run.mjs).
 *
 * - aggressor: the player hurt us (playerThreat.ts aggression): AGGRESSION_HOSTILE for a player no
 *   stronger than us, AGGRESSION_RETALIATE for a stronger one (we only answer a real attack there).
 * - expansion: the player reserves our expansion target from that room, or claimed it.
 * - territory: its fall frees remote sources we can mine: none while the remote CPU budget is full.
 * - stronghold (targets.ts): the remote sources it blocks, by the same budget rule.
 * - encroacher: a small room (RCL <= ENCROACHER_MAX_RCL, ENCROACHER_MAX_TOWERS towers, no armed creep
 *   seen) within ENCROACHER_RANGE of one of ours, whatever its owner's size, until that owner answers
 *   (AGGRESSION_HOSTILE): shard0 2026-10-27, Blindfold (8 rooms, GCL 8) rebuilt W25N7 at RCL 3 next to
 *   W24N8 and reserved W24N7, the only remote W24N8 reaches in its respawn area. Razed once at tick
 *   78579596 with no answer in 28000 ticks; it is attacked again while it is small, before more towers.
 * Loot and infamy only add to the value of a target that has a reason (roi.ts).
 * shard0 2026-10-26 (tick 78586437), before: 5 missions in ~25000 ticks, 17 creeps lost, 2 rooms
 * destroyed (Blindfold's W25N7, rebuilt since; DoctorCat92's W29N3 for 300 loot), no player had hurt us
 * and the remote budget held 6 of 6 rooms, so the freed sources that priced the targets were unusable.
 * Our design.
 */

import { AGGRESSION_HOSTILE } from "./playerThreat";
import { RESERVATION_FRESH, RoomHolding } from "./roi";

export type StrategicReason = "aggressor" | "expansion" | "territory" | "stronghold" | "encroacher";

/** Linear distance of an encroaching room from our closest owned room */
export const ENCROACHER_RANGE = 2;
/** Encroaching rooms are only attacked while small: a few hundred hits of tower damage, no labs */
export const ENCROACHER_MAX_RCL = 3;
export const ENCROACHER_MAX_TOWERS = 1;

export interface EncroachFacts {
    /** Linear distance to our closest owned room */
    distance: number;
    rcl?: number;
    towers: number;
    /** Damage per tick of the hostile creeps seen in the room (military intel) */
    damage: number;
}

/** A small player room next to ours, without armed creeps */
export function isEncroacher(facts: EncroachFacts): boolean {
    return (
        facts.distance <= ENCROACHER_RANGE &&
        (facts.rcl ?? 0) <= ENCROACHER_MAX_RCL &&
        facts.towers <= ENCROACHER_MAX_TOWERS &&
        facts.damage === 0
    );
}

/** Damage (hits) a stronger player must deal us before we answer (~10 tower shots) */
export const AGGRESSION_RETALIATE = 3000;
/** Remote sources a free remote room slot takes (rooms have 1 or 2 sources) */
export const SOURCES_PER_ROOM = 2;

/** Remote room slots left by the CPU budget (`maxRooms` undefined: uncapped) */
export function spareRemoteRooms(maxRooms: number | undefined, minedRooms: number): number {
    if (maxRooms === undefined) return Infinity;
    return Math.max(0, maxRooms - minedRooms);
}

/** Freed remote sources we could mine with the budget's spare room slots */
export function usableSources(freed: number, spareRooms: number): number {
    return Math.max(0, Math.min(freed, spareRooms * SOURCES_PER_ROOM));
}

export function isAggressor(aggression: number, stronger: boolean): boolean {
    return aggression >= (stronger ? AGGRESSION_RETALIATE : AGGRESSION_HOSTILE);
}

/**
 * The player claimed our expansion target, or reserves it from `target` (its strictly closest room: on
 * a tie another of its rooms keeps reserving it, as in roi.ts freedSources)
 */
export function blocksExpansion(
    target: string,
    owner: string,
    expansionRoom: string | undefined,
    rooms: RoomHolding[],
    distance: (a: string, b: string) => number,
    now: number
): boolean {
    if (!expansionRoom) return false;
    if (target === expansionRoom) return true;
    const holding = rooms.find(r => r.room === expansionRoom);
    if (!holding || holding.owner || holding.reserver !== owner) return false;
    if (now - (holding.scouted ?? now) > RESERVATION_FRESH) return false;
    const toTarget = distance(expansionRoom, target);
    return rooms
        .filter(r => r.owner === owner && r.room !== target)
        .every(r => distance(expansionRoom, r.room) > toTarget);
}

export interface PlayerFacts {
    /** Damage the player dealt us (decaying) */
    aggression: number;
    /** More rooms seen than we own (playerThreat.ts looksStronger) */
    stronger: boolean;
    /** Freed remote sources we could mine (usableSources) */
    usableSources: number;
    blocksExpansion: boolean;
    /** isEncroacher */
    encroacher?: boolean;
}

/**
 * Reason to attack a player's room, null to leave it alone; a stronger player only for aggression, or
 * for an encroaching room until it answers (AGGRESSION_HOSTILE): then only real aggression counts
 */
export function playerReason(facts: PlayerFacts): StrategicReason | null {
    if (isAggressor(facts.aggression, facts.stronger)) return "aggressor";
    if (facts.encroacher && facts.aggression < AGGRESSION_HOSTILE) return "encroacher";
    if (facts.stronger) return null;
    if (facts.blocksExpansion) return "expansion";
    if (facts.usableSources > 0) return "territory";
    return null;
}
