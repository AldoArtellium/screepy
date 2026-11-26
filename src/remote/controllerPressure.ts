/**
 * Pressure on the controller of one of our remotes (pure, offline check `node tests/remoteRooms/run.mjs`;
 * our design, 2026-11-26). shard0 W29N8 (W29N7's remote, ~79221000): doorknobnob's creeps stood at the
 * controller, one with CLAIM. The contest rule (remoteRooms.ts contestingPlayer) dropped the room from
 * the selection for ~20000 ticks at the first sighting, our reserver was recycled, the reservation ran out
 * and doorknobnob claimed the room (RCL 4 by 79302891). The rule was written for a room another, stronger
 * player held before us (W28N4, Blindfold); against a player no stronger than us, intruding on a room we
 * mine, the room is defended instead: no contest, their reservation doesn't block it (our reserver attacks
 * it), and a light defender clears their claimers and blockers (remoteDefense.ts).
 */

/** Their reservation can't outlast CONTROLLER_RESERVE_MAX ticks after the last sighting */
export const PRESSURE_TTL = 5000;

export interface PressureEntry {
    player: string;
    /** First and last sightings */
    since: number;
    seen: number;
    /** Their CLAIM creeps next to the controller, their other creeps parked on its tiles, last sighting */
    claimers: number;
    blockers: number;
}

/** Another player's creep in the room: `claims` an active CLAIM part, `atController` next to the controller */
export interface ControllerCreep {
    owner: string;
    claims: boolean;
    atController: boolean;
}

function isPlayer(name: string | undefined, me: string | undefined): name is string {
    return !!name && name !== me && name !== "Invader" && name !== "Source Keeper";
}

/** The player with creeps at the controller (CLAIM or parked on its tiles), else undefined */
export function pressingPlayer(creeps: ControllerCreep[], me: string | undefined): string | undefined {
    return creeps.find(c => isPlayer(c.owner, me) && c.atController)?.owner;
}

/** Claimers and blockers of `player` at the controller */
export function controllerCrowd(creeps: ControllerCreep[], player: string): { claimers: number; blockers: number } {
    const there = creeps.filter(c => c.owner === player && c.atController);
    const claimers = there.filter(c => c.claims).length;
    return { claimers, blockers: there.length - claimers };
}

/**
 * Defend a remote rather than cede it: one we mine (`ours`), against a player no stronger than us
 * (playerThreat.ts looksStronger). A stronger player keeps the contest rule: no fight we would lose.
 */
export function defendsRemote(ours: boolean, stronger: boolean): boolean {
    return ours && !stronger;
}

/** Records a sighting; true for a new episode (none, expired, or another player) */
export function notePressure(
    entries: { [room: string]: PressureEntry },
    roomName: string,
    player: string,
    time: number,
    crowd: { claimers: number; blockers: number }
): boolean {
    const entry = entries[roomName];
    if (entry && entry.player === player && time - entry.seen < PRESSURE_TTL) {
        entry.seen = time;
        entry.claimers = crowd.claimers;
        entry.blockers = crowd.blockers;
        return false;
    }
    entries[roomName] = { player, since: time, seen: time, ...crowd };
    return true;
}

/** The player pressing the room's controller, while the entry lasts */
export function pressedBy(entry: PressureEntry | undefined, time: number): string | undefined {
    return entry && time - entry.seen < PRESSURE_TTL ? entry.player : undefined;
}
