/**
 * Keeper killer: one per keeper room a home mines (unboosted RANGED_ATTACK + HEAL, keepers.ts killerParts,
 * spawned by remoteSpawnRole before the room's harvesters). It waits at range 3 of the lair whose keeper
 * spawns first (keepers.ts keeperTarget), shoots the keepers of the mined sources from range 3 and heals
 * itself every tick. The mineral's lair is left alone. Our design: Hivemind ports no keeper mining. See
 * docs/decisions/economy.md.
 */

import { followPath, stayInPlace } from "../core/movement";
import { trafficManager } from "../modules/TrafficManager";
import { isRemoteRoomMined, remotePath, remoteSources } from "../remote/RemoteMining";
import { keeperTarget } from "../remote/keepers";
import { KEEPER_KILLER } from "../remote/remoteSpawnRole";
import { countStat } from "../utils/stats";
import { performRecycle } from "./recycle";
import { registerRole } from "./registry";

/** Lairs and keepers within this range of a mined source are guarded (IntelManager's lair test) */
const GUARD_RANGE = 5;
/** The killer fights at RANGED_ATTACK's range: a keeper deals 100 per tick there, 400 adjacent */
const FIGHT_RANGE = 3;

/** The keeper each killer fought last (heap): gone while the killer is in the room = killed */
const lastKeeper: Map<string, Id<Creep>> = new Map();

/** Ends of life that are no combat loss (MemoryCleanup counts the others as keeper:killerDied) */
function markExpiring(creep: Creep): void {
    if (!creep.memory.expiring) creep.memory.expiring = true;
}

export function runKeeperKiller(creep: Creep): void {
    const roomName = creep.memory.keeperRoom;
    const home = creep.memory.room ?? "";
    if ((creep.ticksToLive ?? CREEP_LIFE_TIME) <= 2) {
        markExpiring(creep);
        lastKeeper.delete(creep.name);
    }
    // Keeper room dropped from the selection: recycle like the remote harvesters
    if (!roomName || !isRemoteRoomMined(home, roomName)) {
        markExpiring(creep);
        performRecycle(creep);
        return;
    }
    const hurt = creep.hits < creep.hitsMax;
    const sources = remoteSources(home).filter(s => s.room === roomName);
    if (creep.room.name !== roomName) {
        if (hurt) creep.heal(creep);
        if (sources.length > 0 && followPath(creep, remotePath(sources[0]), true, 30)) return;
        trafficManager.moveToRoom(creep, roomName, { priority: 30 });
        return;
    }

    // Every source's keeper, mined or not: remote paths and haulers pass by them (the mineral's keeper is
    // left alone, remote paths keep away from it: RemoteMining remoteCostMatrix)
    const guarded = creep.room.find(FIND_SOURCES).map(s => s.pos);
    const near = (pos: RoomPosition) => guarded.some(s => s.inRangeTo(pos, GUARD_RANGE));
    const lairs = creep.room.find(FIND_HOSTILE_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_KEEPER_LAIR && near(s.pos)
    }) as StructureKeeperLair[];
    const keepers = creep.room.find(FIND_HOSTILE_CREEPS, {
        filter: c => c.owner.username === "Source Keeper" && (near(c.pos) || lairs.some(l => l.pos.inRangeTo(c, GUARD_RANGE)))
    });

    const previous = lastKeeper.get(creep.name);
    if (previous && !Game.getObjectById(previous)) {
        countStat("keeper:killed");
        lastKeeper.delete(creep.name);
    }

    const target = keeperTarget(
        creep.pos,
        keepers.map(k => ({ id: k.id, x: k.pos.x, y: k.pos.y })),
        lairs.map(l => ({ id: l.id, x: l.pos.x, y: l.pos.y, ticksToSpawn: l.ticksToSpawn }))
    );
    // RANGED_ATTACK and HEAL run the same tick (a melee ATTACK would be cancelled by the HEAL)
    if (hurt) creep.heal(creep);
    // A keeper strikes in melee within 1: keep every live keeper at range FIGHT_RANGE
    const close = keepers.filter(k => creep.pos.inRangeTo(k, FIGHT_RANGE - 1));
    if (close.length > 0) {
        const step = PathFinder.search(creep.pos, close.map(k => ({ pos: k.pos, range: FIGHT_RANGE })), { flee: true, maxRooms: 1 }).path[0];
        if (step) trafficManager.requestMove(creep, step, { range: 0, priority: 10 });
    }
    if (target?.kind === "keeper") {
        const keeper = keepers.find(k => k.id === target.id)!;
        lastKeeper.set(creep.name, keeper.id);
        if (creep.pos.inRangeTo(keeper, FIGHT_RANGE)) creep.rangedAttack(keeper);
        if (close.length === 0) trafficManager.requestMove(creep, keeper, { range: FIGHT_RANGE, priority: 10, combat: true });
        return;
    }
    if (close.length > 0) return;
    const lair = target ? lairs.find(l => l.id === target.id) : undefined;
    // Waiting at range 3 of the lair: the new keeper is in reach the tick it spawns, out of its melee
    if (lair) trafficManager.requestMove(creep, lair, { range: FIGHT_RANGE, priority: 30 });
    else stayInPlace(creep);
}

registerRole(KEEPER_KILLER, runKeeperKiller);
