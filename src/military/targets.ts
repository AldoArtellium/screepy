/**
 * Automatic targets (when Memory.military.attack is unset): only rooms with a strategic reason
 * (strategy.ts), then by return on investment in energy (roi.ts): what a target brings against what its
 * squad costs, the best return of at least 1 wins.
 *
 * 1. Strongholds (invader cores of level 1 to maxStrongholdLevel, default 1) near our rooms or
 *    remotes, while the remote budget has room for the sources they block: their loot seen in sight
 *    and the remote income they block until they collapse (their room's sources, as many as the budget
 *    can take). Level 0 cores in our remotes are already cleared by the remote defense ATTACKER
 *    (remote/remoteDefense.ts).
 * 2. Player rooms, unless `Memory.military.auto = false` (on by default since 2026-10-25), with a reason
 *    (strategy.ts playerReason): the player hurt us (aggressor; a stronger player, more rooms seen than
 *    we own, only from AGGRESSION_RETALIATE), it reserves or claimed our expansion target, or its fall
 *    frees remote sources the remote budget can take (territory). Value: loot seen in sight (storage,
 *    terminal, containers), those usable sources (roi.ts freedSources, REMOTE_HORIZON ticks of income)
 *    and, for an aggressor only, the energy its creeps made us lose (infamy). A small room next to ours
 *    (encroacher, whatever its owner's size until they answer) counts every source it frees. Rooms in safe mode or
 *    without spawn are skipped. Rooms left alone for want of a reason are listed in
 *    `Memory.military.skipped` (room: why) and logged once per change.
 * Under CPU pressure (remote budget capped, or CPU above 85%) the squad's CPU is priced in energy
 * (roi.ts squadCpu x a neutral remote source's energy per CPU): the remote budget gives that CPU up.
 * Rooms that failed in the last FAILURE_MEMORY ticks are left alone, and only targets the chosen squad
 * can fight (sizing.ts feasible) count. Before, Harabi's score (durability x distance / threat) with
 * strongholds always first: the mockup quad lost 8 creeps (~16k energy each way) for 22 units of loot.
 * Our design.
 */

import { intelManager } from "../modules/IntelManager";
import { releaseRooms } from "../modules/RoomIntel";
import { cpuPressure, neutralEnergyPerCpu } from "../remote/remoteIncome";
import { minedRemoteRooms, remoteSources, spawnBusyShare } from "../remote/RemoteMining";
import { roomCountersSince } from "../utils/history";
import { log } from "../utils/logger";
import { HostileRoom, militaryMemory } from "./intel";
import { looksStronger, OwnedRoomSeen, playerRoomCounts } from "./playerThreat";
import {
    ATTRITION,
    freedSources,
    pickTarget,
    REMOTE_HORIZON,
    releasedRooms,
    remoteValue,
    RoomHolding,
    spawnTimeCost,
    squadCost,
    squadCpu,
    targetValue
} from "./roi";
import { planSquad, SquadPlan, squadMemberCosts, squadMemberParts } from "./sizing";
import { blocksExpansion, isEncroacher, playerReason, spareRemoteRooms, StrategicReason, usableSources } from "./strategy";

const MAX_DISTANCE = 10;
/** Distance of the neutral remote source whose energy per CPU prices a squad's CPU (remoteIncome examples) */
const CPU_PRICE_DISTANCE = 50;
/** Linear distance of a stronghold from our rooms (remotes: one less) */
const STRONGHOLD_RANGE = 2;
/** A failed target is left alone this long */
const FAILURE_MEMORY = 20000;

export interface AutoTarget {
    room: string;
    reason: StrategicReason;
    roi: number;
    value: number;
    /** Spawn energy with replacements, plus `cpu` */
    cost: number;
    /** The squad's CPU priced in energy (0 without CPU pressure) */
    cpu: number;
    /** The income the origin's economy loses while its spawns make the squad (roi.ts spawnTimeCost) */
    spawnTime: number;
}

/** Room income (local + remote harvest) per tick is averaged over this */
const INCOME_WINDOW = 5000;

/** Energy harvested per tick by each owned room's creeps over INCOME_WINDOW (history room counters) */
function incomePerTick(): { [room: string]: number } {
    const income: { [room: string]: number } = {};
    for (const [room, { ticks, counters }] of Object.entries(roomCountersSince(Game.time - INCOME_WINDOW))) {
        if (ticks > 0) income[room] = ((counters.harvest ?? 0) + (counters.remoteHarvest ?? 0)) / ticks;
    }
    return income;
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

/**
 * Closest origin whose squad can fight the target (sizing.ts feasible, its boosts in stock counted):
 * shard0 W28N8 is next to W28N7 (no labs) and one room further from W29N7 (labs, XLHO2 and GHO2)
 */
function feasibleOrigin(origins: Origin[], roomName: string): { origin: Origin; plan: SquadPlan } | null {
    const inReach = origins
        .map(origin => ({ origin, distance: Game.map.getRoomLinearDistance(origin.room.name, roomName) }))
        .filter(o => o.distance <= MAX_DISTANCE)
        .sort((a, b) => a.distance - b.distance);
    for (const { origin } of inReach) {
        // Strongholds (the core) and players (haulers) refill their towers: judged at close range
        const energy = origin.room.energyCapacityAvailable;
        const plan = planSquad(roomName, energy, militaryMemory().squad, true, origin.room);
        if (plan.feasible) return { origin, plan };
    }
    return null;
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

function isStrongholdNear(intel: HostileRoom, roomName: string): boolean {
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

/** Rooms seen owned by each player (military intel and static intel, playerThreat.ts playerRoomCounts) */
function playerRooms(): { [player: string]: number } {
    const seen: OwnedRoomSeen[] = Object.entries(militaryMemory().rooms ?? {}).map(([room, r]) => ({
        room,
        owner: r.owner,
        seen: r.t
    }));
    for (const [room, intel] of Object.entries(intelManager.allIntel()))
        seen.push({ room, owner: intel.owner, seen: intel.lastScouted });
    return playerRoomCounts(seen, Game.time);
}

/** Why each room was last left alone (heap: logged on a change only) */
const skippedLogged: Map<string, string> = new Map();

function skip(skipped: { [room: string]: string }, roomName: string, why: string): void {
    skipped[roomName] = why;
    if (skippedLogged.get(roomName) === why) return;
    skippedLogged.set(roomName, why);
    log.info("Military", `${roomName} left alone: ${why}`);
}

function unskip(skipped: { [room: string]: string }, roomName: string): void {
    delete skipped[roomName];
    skippedLogged.delete(roomName);
}

interface Candidate {
    reason: StrategicReason;
    /** Remote sources counted in the value: the stronghold's or the freed ones, within the budget */
    sources: number;
}

/**
 * A player's room with a strategic reason (strategy.ts), else null and the room in `skipped`. `kept`: the
 * reason of the current target while its squad has creeps, kept when the reason fades (the remote budget
 * filling up, aggression decaying, the expansion ending) so a squad is not recycled half way.
 */
function playerCandidate(
    roomName: string,
    intel: HostileRoom,
    context: { counts: { [player: string]: number }; ours: string[]; spare: number; holdings: RoomHolding[] },
    skipped: { [room: string]: string },
    kept?: StrategicReason
): Candidate | null {
    if (militaryMemory().auto === false) return null;
    const owner = intel.owner;
    if (!owner || owner === Memory.username || intel.spawns === 0) return null;
    if ((intel.safeMode ?? 0) > Game.time) return null;
    const aggression = Math.round(militaryMemory().aggression?.[owner] ?? 0);
    const theirRooms = context.counts[owner] ?? 0;
    const stronger = looksStronger(theirRooms, context.ours.length);
    const freed = freedSources(roomName, owner, context.holdings, context.ours, linearDistance, Game.time);
    const usable = usableSources(freed, context.spare);
    const expansion = Memory.expand?.current?.roomName;
    const blocking = blocksExpansion(roomName, owner, expansion, context.holdings, linearDistance, Game.time);
    const distance = _.min(context.ours.map(o => linearDistance(o, roomName)));
    const encroacher = isEncroacher({ distance, rcl: intel.rcl, towers: intel.towers, damage: intel.damage });
    const reason = playerReason({ aggression, stronger, usableSources: usable, blocksExpansion: blocking, encroacher });
    // Blocking our expansion costs at least the target room's sources, whatever the remote budget
    if (reason === "expansion") return { reason, sources: Math.max(usable, intelManager.sourceCount(expansion!)) };
    // An encroacher is attacked to deny the land: every freed source counts, whatever the remote budget
    if (reason === "encroacher") return { reason, sources: Math.max(usable, freed) };
    if (reason) return { reason, sources: usable };
    if (kept) return { reason: kept, sources: usable };
    const why = encroacher
        ? `${owner} answered our attacks (aggression ${aggression}): encroacher left alone`
        : stronger
          ? `${owner} stronger (${theirRooms} rooms seen for our ${context.ours.length}), aggression ${aggression}`
          : `${owner}: no strategic reason (aggression ${aggression}, freed sources ${freed}, usable ${usable})`;
    skip(skipped, roomName, why);
    return null;
}

/** A stronghold near our territory while the remote budget can mine what it blocks */
function strongholdCandidate(
    roomName: string,
    intel: HostileRoom,
    spare: number,
    skipped: { [room: string]: string },
    kept?: StrategicReason
): Candidate | null {
    if (!isStrongholdNear(intel, roomName)) return null;
    const sources = intelManager.sourceCount(roomName);
    const usable = usableSources(sources, spare);
    if (usable > 0 || kept) return { reason: "stronghold", sources: usable };
    skip(skipped, roomName, `stronghold level ${intel.coreLevel}: ${sources > 0 ? "remote budget full" : "no source"}`);
    return null;
}

/** Every feasible target with its return (value / cost in energy); `engaged`: the current target's squad has creeps */
export function rankTargets(engaged = false): AutoTarget[] {
    const memory = militaryMemory();
    const from = origins();
    const targets: AutoTarget[] = [];
    if (from.length === 0) {
        delete memory.skipped;
        return targets;
    }
    const income = incomePerTick();
    const context = {
        counts: playerRooms(),
        ours: ownedRooms(),
        spare: spareRemoteRooms(Memory.remoteMining?.maxRooms, minedRemoteRooms()),
        holdings: holdings()
    };
    const skipped: { [room: string]: string } = {};
    for (const [roomName, intel] of Object.entries(memory.rooms ?? {})) {
        if (recentlyFailed(roomName)) continue;
        const kept = engaged && memory.target?.room === roomName ? memory.target.reason : undefined;
        const candidate =
            strongholdCandidate(roomName, intel, context.spare, skipped, kept) ??
            playerCandidate(roomName, intel, context, skipped, kept);
        if (!candidate) continue;
        unskip(skipped, roomName);
        const { reason } = candidate;
        const near = feasibleOrigin(from, roomName);
        if (!near) continue;
        const { plan } = near;
        const energy = near.origin.room.energyCapacityAvailable;
        const members = squadMemberCosts(plan.type, energy);
        const cpu = cpuPressure()
            ? Math.round(squadCpu(members.length) * neutralEnergyPerCpu(CPU_PRICE_DISTANCE, energy))
            : 0;
        const origin = near.origin.room;
        const spawnTime = spawnTimeCost(
            squadMemberParts(plan.type, energy),
            origin.find(FIND_MY_SPAWNS).length,
            income[origin.name] ?? 0,
            spawnBusyShare(origin.name)
        );
        // The compounds the squad needs against this target (sizing.ts planSquad) are spent too
        const cost = squadCost(members, ATTRITION, plan.boostCost) + cpu + spawnTime;
        const ticksLeft = (intel.collapse ?? Infinity) - Game.time;
        const remote = remoteValue(candidate.sources, reason === "stronghold" ? ticksLeft : REMOTE_HORIZON);
        const value = targetValue({
            loot: intel.loot ?? 0,
            remote,
            // The energy a player's creeps made us lose only counts once they fought us
            infamy: reason === "aggressor" ? (memory.infamy?.[intel.owner!] ?? 0) : 0
        });
        targets.push({ room: roomName, reason, roi: value / cost, value: Math.round(value), cost, cpu, spawnTime });
    }
    memory.skipped = skipped;
    return targets;
}

/**
 * A player's room fell to our squad: it and the rooms they reserved from it are released for remote
 * mining (RoomIntel releaseRooms), so their leftover reservation and creeps don't keep them contested
 */
export function releaseFallen(roomName: string): void {
    const owner = militaryMemory().rooms?.[roomName]?.owner;
    if (!owner || owner === Memory.username || owner === "Invader") return;
    const rooms = releasedRooms(roomName, owner, holdings(), linearDistance, Game.time);
    if (rooms.length > 0) releaseRooms(rooms, owner);
}

/** Best automatic target (null: nothing pays for its squad); `engaged`: the current target's squad has creeps */
export function chooseAutoTarget(engaged = false): AutoTarget | null {
    return pickTarget(rankTargets(engaged), militaryMemory().target?.room, engaged);
}
