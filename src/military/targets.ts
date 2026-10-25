/**
 * Automatic targets (when Memory.military.attack is unset), by return on investment in energy (roi.ts):
 * what a target brings against what its squad costs, the best return of at least 1 wins.
 *
 * 1. Strongholds (invader cores of level 1 to maxStrongholdLevel, default 1) near our rooms or
 *    remotes: their loot seen in sight and the remote income they block until they collapse (their
 *    room's sources). Level 0 cores in our remotes are already cleared by the remote defense ATTACKER
 *    (remote/remoteDefense.ts).
 * 2. Player rooms, unless `Memory.military.auto = false` (on by default since 2026-10-25): their loot seen in
 *    sight (storage, terminal, containers), the energy the player made us lose (infamy) and the remote
 *    sources its fall frees next to our rooms (roi.ts freedSources, REMOTE_HORIZON ticks of income);
 *    rooms in safe mode or without spawn are skipped.
 * Under CPU pressure (remote budget capped, or CPU above 85%) the squad's CPU is priced in energy
 * (roi.ts squadCpu x a neutral remote source's energy per CPU): the remote budget gives that CPU up.
 * Rooms that failed in the last FAILURE_MEMORY ticks are left alone, and only targets the chosen squad
 * can fight (sizing.ts feasible) count. Before, Harabi's score (durability x distance / threat) with
 * strongholds always first: the mockup quad lost 8 creeps (~16k energy each way) for 22 units of loot.
 * Our design.
 */

import { intelManager } from "../modules/IntelManager";
import { cpuPressure, neutralEnergyPerCpu } from "../remote/remoteIncome";
import { remoteSources } from "../remote/RemoteMining";
import { HostileRoom, militaryMemory } from "./intel";
import {
    freedSources,
    pickTarget,
    REMOTE_HORIZON,
    remoteValue,
    RoomHolding,
    squadCost,
    squadCpu,
    targetValue
} from "./roi";
import { planSquad, squadMemberCosts } from "./sizing";

const MAX_DISTANCE = 10;
/** Distance of the neutral remote source whose energy per CPU prices a squad's CPU (remoteIncome examples) */
const CPU_PRICE_DISTANCE = 50;
/** Linear distance of a stronghold from our rooms (remotes: one less) */
const STRONGHOLD_RANGE = 2;
/** A failed target is left alone this long */
const FAILURE_MEMORY = 20000;

export interface AutoTarget {
    room: string;
    reason: "stronghold" | "player";
    roi: number;
    value: number;
    /** Spawn energy with replacements, plus `cpu` */
    cost: number;
    /** The squad's CPU priced in energy (0 without CPU pressure) */
    cpu: number;
}

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

function isStronghold(intel: HostileRoom, roomName: string): boolean {
    const maxLevel = militaryMemory().maxStrongholdLevel ?? 1;
    if (!intel.coreLevel || intel.coreLevel > maxLevel) return false;
    // Not deployed yet (nothing to fight for a while), or collapsing soon on its own
    if ((intel.coreDeploy ?? 0) > Game.time + 500) return false;
    if (intel.collapse !== undefined && intel.collapse - Game.time < 2000) return false;
    return nearOurTerritory(roomName);
}

function linearDistance(a: string, b: string): number {
    return Game.map.getRoomLinearDistance(a, b);
}

function ownedRooms(): string[] {
    return _.filter(Game.rooms, r => !!r.controller?.my).map(r => r.name);
}

/** Owner, reserver and source count of every room in the static intel */
function holdings(): RoomHolding[] {
    return Object.entries(intelManager.allIntel()).map(([room, intel]) => ({
        room,
        owner: intel.owner,
        reserver: intel.reserver,
        sources: intel.sources?.length ?? 0,
        scouted: intel.lastScouted
    }));
}

function isPlayerTarget(intel: HostileRoom): boolean {
    if (militaryMemory().auto === false) return false;
    if (!intel.owner || intel.owner === Memory.username || intel.spawns === 0) return false;
    return (intel.safeMode ?? 0) <= Game.time;
}

/** Every feasible target with its return (value / cost in energy) */
export function rankTargets(): AutoTarget[] {
    const memory = militaryMemory();
    const from = origins();
    const targets: AutoTarget[] = [];
    if (from.length === 0) return targets;
    for (const [roomName, intel] of Object.entries(memory.rooms ?? {})) {
        if (recentlyFailed(roomName)) continue;
        const near = closest(from, roomName);
        if (!near) continue;
        const reason = isStronghold(intel, roomName) ? "stronghold" : isPlayerTarget(intel) ? "player" : null;
        if (!reason) continue;
        const energy = near.origin.room.energyCapacityAvailable;
        const plan = planSquad(roomName, energy, memory.squad, reason === "stronghold", near.origin.room);
        if (!plan.feasible) continue;
        const members = squadMemberCosts(plan.type, energy);
        const cpu = cpuPressure()
            ? Math.round(squadCpu(members.length) * neutralEnergyPerCpu(CPU_PRICE_DISTANCE, energy))
            : 0;
        const cost = squadCost(members) + cpu;
        const ticksLeft = (intel.collapse ?? Infinity) - Game.time;
        const remote =
            reason === "stronghold"
                ? remoteValue(intelManager.sourceCount(roomName), ticksLeft)
                : remoteValue(
                      freedSources(roomName, intel.owner!, holdings(), ownedRooms(), linearDistance, Game.time),
                      REMOTE_HORIZON
                  );
        const value = targetValue({
            loot: intel.loot ?? 0,
            remote,
            infamy: reason === "player" ? memory.infamy?.[intel.owner!] ?? 0 : 0
        });
        targets.push({ room: roomName, reason, roi: value / cost, value: Math.round(value), cost, cpu });
    }
    return targets;
}

/** Best automatic target (null: nothing pays for its squad) */
export function chooseAutoTarget(): AutoTarget | null {
    return pickTarget(rankTargets(), militaryMemory().target?.room);
}
