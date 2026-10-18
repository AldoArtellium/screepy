/**
 * Remote builder: keeps a remote source's container and the roads of its path up. It fills up from
 * the home storage, walks the path to the source building and repairing the road tiles around it,
 * then walks back doing the same, and picks the source with the most missing hits for each trip.
 * Ported from Hivemind (MIT), src/role/builder.mines.ts. See docs/hivemind/hivemind-remote.md §7.4.
 *
 * Hivemind follows a cached path; here the creep steps from tile to tile of the remote path
 * (index 0 = container tile next to the source, last = next to the planned storage).
 */

import { stayInPlace, whenInRange } from "../core/movement";
import { creepsByRole, storageLocation } from "../core/roomState";
import { trafficManager } from "../modules/TrafficManager";
import {
    containerPos,
    getRemoteSource,
    isRemoteUnderAttack,
    neededWork,
    remoteContainer,
    remotePath,
    RemoteSource,
    remoteSources,
    sourcePos
} from "../remote/RemoteMining";
import { REMOTE_BUILDER, REMOTE_HARVESTER } from "../remote/remoteSpawnRole";
import { countStat } from "../utils/stats";
import { fleeIfThreatened } from "./flee";
import { registerRole } from "./registry";

declare global {
    interface CreepMemory {
        /** Remote builder: heading home to refill */
        returning?: boolean;
        /** Remote builder: path index it walks to next */
        pathIndex?: number;
    }
}

/** Hivemind stops placing remote road sites above 70% of the global limit */
const MAX_GLOBAL_SITES = MAX_CONSTRUCTION_SITES * 0.7;
const MAX_REMOTE_ROOM_SITES = 5;

export function runRemoteBuilder(creep: Creep): void {
    const home = Game.rooms[creep.memory.room ?? creep.room.name];
    let source = getRemoteSource(creep.memory.source);
    if (!source) {
        delete creep.memory.source;
        if (!home) return;
        if (creep.room.name !== home.name) {
            trafficManager.moveToRoom(creep, home.name);
            return;
        }
        const wait = home.storage ?? storageLocation(home);
        if (!wait) return;
        whenInRange(creep, 3, wait, () => determineTargetSource(creep));
        source = getRemoteSource(creep.memory.source);
        if (!source) return;
    }
    if (fleeIfThreatened(creep, sourcePos(source))) return;

    if (creep.memory.returning) {
        if (buildRoad(creep, source)) return;
        returnHome(creep, source);
        return;
    }
    goToSource(creep, source);
}

function setReturning(creep: Creep, returning: boolean): void {
    creep.memory.returning = returning;
    delete creep.memory.pathIndex;
    if (!returning) determineTargetSource(creep);
}

/** Source with the most missing hits, among sources with a harvester and no remote builder yet */
function determineTargetSource(creep: Creep): void {
    const homeRoom = creep.memory.room ?? creep.room.name;
    delete creep.memory.source;
    let best: RemoteSource | undefined;
    let bestWork = 0;
    for (const source of remoteSources(homeRoom)) {
        if (isRemoteUnderAttack(source)) continue;
        if (creepsByRole(homeRoom, REMOTE_BUILDER).some(c => c !== creep && c.memory.source === source.key)) continue;
        if (!creepsByRole(homeRoom, REMOTE_HARVESTER).some(c => c.memory.source === source.key)) continue;
        const work = neededWork(source);
        if (work > bestWork) {
            best = source;
            bestWork = work;
        }
    }
    if (best) creep.memory.source = best.key;
}

/**
 * Walk one tile along the path (towards the source or towards home). Off the path, the creep first
 * heads for the path's closest tile in its room.
 */
function followPath(creep: Creep, path: RoomPosition[], towardsSource: boolean): void {
    const index = currentIndex(creep, path);
    if (index === null) {
        const inRoom = path.map((p, i) => ({ p, i })).filter(e => e.p.roomName === creep.room.name);
        const closest = _.min(inRoom, e => e.p.getRangeTo(creep.pos));
        const target = typeof closest === "number" ? path[towardsSource ? 0 : path.length - 1] : closest.p;
        trafficManager.requestMove(creep, target, { range: 0, priority: 40 });
        return;
    }
    const next = towardsSource ? index - 1 : index + 1;
    if (next < 0 || next >= path.length) {
        stayInPlace(creep);
        return;
    }
    creep.memory.pathIndex = next;
    trafficManager.requestMove(creep, path[next], { range: 0, priority: 40 });
}

/** Path index of the creep's tile, looked up around the last known index first */
function currentIndex(creep: Creep, path: RoomPosition[]): number | null {
    const last = creep.memory.pathIndex;
    if (last !== undefined) {
        for (let i = Math.max(0, last - 3); i <= Math.min(path.length - 1, last + 3); i++) {
            if (path[i].isEqualTo(creep.pos)) return i;
        }
    }
    const index = path.findIndex(p => p.isEqualTo(creep.pos));
    return index === -1 ? null : index;
}

function goToSource(creep: Creep, source: RemoteSource): void {
    const target = sourcePos(source);
    if (creep.room.name === source.room && creep.pos.getRangeTo(target) <= 2) {
        setReturning(creep, true);
        return;
    }
    if (pickupNearbyEnergy(creep)) return;
    if (buildRoad(creep, source)) return;
    followPath(creep, remotePath(source), true);
}

function returnHome(creep: Creep, source: RemoteSource): void {
    // Top up at the source container after repairing it
    const container = remoteContainer(source);
    if (
        container &&
        container.pos.roomName === creep.room.name &&
        creep.pos.getRangeTo(container) < 10 &&
        creep.store.getUsedCapacity() < creep.store.getCapacity() * 0.5 &&
        container.store.energy > container.store.getCapacity() * 0.1
    ) {
        whenInRange(creep, 1, container, () => creep.withdraw(container, RESOURCE_ENERGY));
        return;
    }
    if (pickupNearbyEnergy(creep)) return;

    const home = Game.rooms[creep.memory.room ?? ""];
    if (home && creep.room.name === home.name) {
        if (creep.store.getFreeCapacity() === 0) {
            setReturning(creep, false);
            return;
        }
        const storage = home.storage;
        if (storage && storage.store.energy >= creep.store.getFreeCapacity()) {
            whenInRange(creep, 1, storage, () => {
                if (creep.withdraw(storage, RESOURCE_ENERGY) === OK) setReturning(creep, false);
            });
            return;
        }
        const wait = storageLocation(home);
        if (wait) whenInRange(creep, 5, wait);
        return;
    }
    followPath(creep, remotePath(source), false);
}

/** Pick up an energy pile of at least 100 within 3 tiles */
function pickupNearbyEnergy(creep: Creep): boolean {
    if (creep.store.getFreeCapacity() < 20) return false;
    const pile = creep.pos.findInRange(FIND_DROPPED_RESOURCES, 3).find(r => r.resourceType === RESOURCE_ENERGY && r.amount >= 100);
    if (!pile) return false;
    if (creep.pos.getRangeTo(pile) > 1) {
        trafficManager.requestMove(creep, pile, { range: 1, priority: 40 });
        return false;
    }
    creep.pickup(pile);
    return true;
}

/** Build and repair around the creep; true when it should stay on this tile for more work */
function buildRoad(creep: Creep, source: RemoteSource): boolean {
    const work = creep.getActiveBodyparts(WORK);
    if (work === 0 || creep.store.energy === 0) return false;
    const state = { acted: false };
    if (buildRoadOnPath(creep, source, work, state)) return stay(creep);
    if (ensureContainer(creep, source, work, state)) return stay(creep);
    if (buildNearby(creep, work, state)) return stay(creep);
    return false;
}

function stay(creep: Creep): boolean {
    stayInPlace(creep);
    return true;
}

/** Path tiles i-2..i+2 around the creep: repair damaged roads, place missing ones outside our rooms */
function buildRoadOnPath(creep: Creep, source: RemoteSource, work: number, state: { acted: boolean }): boolean {
    const controller = creep.room.controller;
    if (controller?.owner && !controller.my) return false;
    const path = remotePath(source);
    const index = currentIndex(creep, path);
    if (index === null) return repairNearby(creep, work, state);
    for (let i = index - 2; i <= index + 2; i++) {
        if (i < 0 || i >= path.length) continue;
        const pos = path[i];
        if (pos.roomName !== creep.room.name) continue;
        const road = pos.lookFor(LOOK_STRUCTURES).find(s => s.structureType === STRUCTURE_ROAD);
        if (road && road.hits < road.hitsMax - work * REPAIR_POWER) {
            if (state.acted) return true;
            if (creep.repair(road) === OK) {
                state.acted = true;
                countStat("work:remoteRepair", work);
            }
            if (road.hits < road.hitsMax - 2 * work * REPAIR_POWER) return true;
            continue;
        }
        // Our rooms get their roads from the room builder
        if (road || controller?.my) continue;
        if (_.size(Game.constructionSites) >= MAX_GLOBAL_SITES) continue;
        if (pos.lookFor(LOOK_CONSTRUCTION_SITES).length > 0) continue;
        const roomSites = _.filter(Game.constructionSites, s => s.pos.roomName === pos.roomName).length;
        if (roomSites < MAX_REMOTE_ROOM_SITES && pos.createConstructionSite(STRUCTURE_ROAD) === OK) return true;
    }
    return false;
}

function repairNearby(creep: Creep, work: number, state: { acted: boolean }): boolean {
    const damaged = creep.pos.findInRange(FIND_STRUCTURES, 3, {
        filter: s =>
            (s.structureType === STRUCTURE_ROAD || s.structureType === STRUCTURE_CONTAINER) &&
            s.hits < s.hitsMax - work * REPAIR_POWER
    })[0];
    if (!damaged) return false;
    if (creep.repair(damaged) === OK) {
        state.acted = true;
        countStat("work:remoteRepair", work);
    }
    return damaged.hits < damaged.hitsMax - 2 * work * REPAIR_POWER;
}

/** Repair the source container within 3 tiles, or place its site */
function ensureContainer(creep: Creep, source: RemoteSource, work: number, state: { acted: boolean }): boolean {
    const container = remoteContainer(source);
    if (container) {
        if (creep.pos.getRangeTo(container) > 3 || container.hits > container.hitsMax - work * REPAIR_POWER) return false;
        if (state.acted) return true;
        if (creep.repair(container) === OK) {
            state.acted = true;
            countStat("work:remoteRepair", work);
        }
        return container.hits < container.hitsMax - 2 * work * REPAIR_POWER;
    }
    const pos = containerPos(source);
    if (pos.roomName !== creep.room.name) return false;
    if (!pos.lookFor(LOOK_CONSTRUCTION_SITES).some(s => s.structureType === STRUCTURE_CONTAINER)) {
        pos.createConstructionSite(STRUCTURE_CONTAINER);
    }
    return false;
}

/** Build a container or road site within 3 tiles */
function buildNearby(creep: Creep, work: number, state: { acted: boolean }): boolean {
    const site = creep.pos.findInRange(FIND_MY_CONSTRUCTION_SITES, 3, {
        filter: s => s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_ROAD
    })[0];
    if (!site) return false;
    if (state.acted) return true;
    if (creep.build(site) === OK) {
        state.acted = true;
        countStat("work:remoteBuild", work);
    }
    return site.progressTotal - site.progress > work * BUILD_POWER * 2;
}

registerRole(REMOTE_BUILDER, runRemoteBuilder);
