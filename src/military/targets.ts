/**
 * Automatic targets (when Memory.military.attack is unset), by return on investment after Harabi's
 * "ROI-driven target selection": score = durability x distance penalty / threat, lowest first.
 *
 * 1. Strongholds (invader cores of level 1 to maxStrongholdLevel, default 1) near our rooms or
 *    remotes: they spawn defenders that raid our remotes, so they come first. Level 0 cores in our
 *    remotes are already cleared by the remote defense ATTACKER (remote/remoteDefense.ts).
 * 2. Player rooms, only with `Memory.military.auto = true` (never by default): durability from the
 *    weakest rampart (1 = 1M hits) and the towers, threat from the player's infamy (energy they made us
 *    lose) plus a baseline for armed rooms within 5 rooms; the current target's score is halved
 *    (hysteresis), rooms in safe mode or recently failed are skipped.
 * Only targets the chosen squad can fight (sizing.ts feasible). Our design.
 */

import { remoteSources } from "../remote/RemoteMining";
import { HostileRoom, militaryMemory } from "./intel";
import { planSquad } from "./sizing";

const MAX_DISTANCE = 10;
/** Linear distance of a stronghold from our rooms (remotes: one less) */
const STRONGHOLD_RANGE = 2;
const PLAYER_BASELINE_RANGE = 5;
const PLAYER_BASELINE = 1000;
/** A failed target is left alone this long */
const FAILURE_MEMORY = 20000;

interface Origin {
    room: Room;
}

function origins(): Origin[] {
    const minRcl = militaryMemory().minRcl ?? 4;
    return _.filter(
        Game.rooms,
        r => !!r.controller?.my && r.controller.level >= minRcl && r.find(FIND_MY_SPAWNS).length > 0
    ).map(room => ({ room }));
}

function recentlyFailed(roomName: string): boolean {
    return (militaryMemory().log ?? []).some(
        e => e.room === roomName && e.result === "abandoned" && Game.time - e.time < FAILURE_MEMORY
    );
}

function closest(origins: Origin[], roomName: string): { origin: Origin; distance: number } | null {
    let best: { origin: Origin; distance: number } | null = null;
    for (const origin of origins) {
        const distance = Game.map.getRoomLinearDistance(origin.room.name, roomName);
        if (distance <= MAX_DISTANCE && (!best || distance < best.distance)) best = { origin, distance };
    }
    return best;
}

function nearOurTerritory(roomName: string): boolean {
    for (const name in Game.rooms) {
        if (!Game.rooms[name].controller?.my) continue;
        if (Game.map.getRoomLinearDistance(name, roomName) <= STRONGHOLD_RANGE) return true;
        for (const source of remoteSources(name))
            if (Game.map.getRoomLinearDistance(source.room, roomName) < STRONGHOLD_RANGE) return true;
    }
    return false;
}

function strongholdScore(intel: HostileRoom, roomName: string, distance: number): number | null {
    const maxLevel = militaryMemory().maxStrongholdLevel ?? 1;
    if (!intel.coreLevel || intel.coreLevel > maxLevel) return null;
    // Not deployed yet (nothing to fight for a while), or collapsing soon on its own
    if ((intel.coreDeploy ?? 0) > Game.time + 500) return null;
    if (intel.collapse !== undefined && intel.collapse - Game.time < 2000) return null;
    if (!nearOurTerritory(roomName)) return null;
    return intel.coreLevel + distance / 10;
}

function playerScore(intel: HostileRoom, distance: number, current: boolean): number | null {
    const memory = militaryMemory();
    if (!intel.owner || intel.owner === Memory.username || intel.spawns === 0) return null;
    if ((intel.safeMode ?? 0) > Game.time) return null;
    const durability = Math.max(0.05, intel.barrier / 1e6) + 0.25 * intel.towers;
    const baseline = intel.towers > 0 && distance <= PLAYER_BASELINE_RANGE ? PLAYER_BASELINE : 0;
    const threat = Math.max(1, (memory.infamy?.[intel.owner] ?? 0) + baseline);
    const score = (durability * (1 + Math.log2(1 + distance))) / threat;
    return current ? score / 2 : score;
}

/** Best automatic target, strongholds before players (null: nothing worth it) */
export function chooseAutoTarget(): { room: string; reason: "stronghold" | "player" } | null {
    const memory = militaryMemory();
    const from = origins();
    if (from.length === 0) return null;
    let best: { room: string; reason: "stronghold" | "player"; score: number } | null = null;
    for (const [roomName, intel] of Object.entries(memory.rooms ?? {})) {
        if (recentlyFailed(roomName)) continue;
        const near = closest(from, roomName);
        if (!near) continue;
        const stronghold = strongholdScore(intel, roomName, near.distance);
        const player =
            stronghold === null && memory.auto
                ? playerScore(intel, near.distance, memory.target?.room === roomName)
                : null;
        if (stronghold === null && player === null) continue;
        if (!planSquad(roomName, near.origin.room.energyCapacityAvailable, memory.squad, stronghold !== null).feasible)
            continue;
        // Strongholds always before players
        const score = stronghold !== null ? stronghold - 1000 : player!;
        if (!best || score < best.score)
            best = { room: roomName, reason: stronghold !== null ? "stronghold" : "player", score };
    }
    return best && { room: best.room, reason: best.reason };
}
