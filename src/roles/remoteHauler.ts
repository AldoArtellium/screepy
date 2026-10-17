/**
 * Remote hauler: a pool per home room. Each trip it picks the most profitable remote source, empties
 * its container and brings the energy home, where it delivers like a transporter (spawn, extensions,
 * towers, workers, storage, else the pile at the base center).
 * Ported from Hivemind (MIT), src/role/hauler.relay.ts ("relay" is a historical name, there is none).
 */

import { whenInRange } from "../core/movement";
import { clearOrder, creepsByRole } from "../core/roomState";
import { trafficManager } from "../modules/TrafficManager";
import {
    canReserveFrom,
    getRemoteSource,
    isRemoteUnderAttack,
    remoteContainer,
    RemoteSource,
    remoteSources,
    sourcePos
} from "../remote/RemoteMining";
import { REMOTE_HARVESTER, REMOTE_HAULER } from "../remote/remoteSpawnRole";
import { fleeIfThreatened } from "./flee";
import { registerRole } from "./registry";
import { performDeliver } from "./transporter";

export function runRemoteHauler(creep: Creep): void {
    const used = creep.store.getUsedCapacity();
    if (creep.memory.delivering && used === 0) startPickup(creep);
    else if (!creep.memory.delivering && used >= creep.store.getCapacity() * 0.9) startDelivering(creep);

    if (creep.memory.delivering) deliver(creep);
    else pickup(creep);
}

function startPickup(creep: Creep): void {
    creep.memory.delivering = false;
    clearOrder(creep);
    const home = Game.rooms[creep.memory.room ?? creep.room.name];
    const best = _.max(remoteSources(creep.memory.room ?? creep.room.name), s => score(creep, home, s));
    creep.memory.source = typeof best === "number" ? undefined : best.key;
}

function startDelivering(creep: Creep): void {
    creep.memory.delivering = true;
    delete creep.memory.source;
    clearOrder(creep);
}

/** Energy we can expect to pick up there, minus what other haulers already went for */
function score(creep: Creep, home: Room | undefined, source: RemoteSource): number {
    const container = remoteContainer(source);
    let energy = container?.store.energy ?? 0;
    const room = Game.rooms[source.room];
    if (room) {
        energy += _.sum(
            sourcePos(source).findInRange(FIND_DROPPED_RESOURCES, 1).filter(r => r.resourceType === RESOURCE_ENERGY),
            r => r.amount
        );
    }
    const harvesters = creepsByRole(source.homeRoom, REMOTE_HARVESTER).filter(c => c.memory.source === source.key);
    const ttl = _.max(harvesters.map(c => c.ticksToLive ?? CREEP_LIFE_TIME).concat([0]));
    const capacity = home && canReserveFrom(home, source.room) ? SOURCE_ENERGY_CAPACITY : SOURCE_ENERGY_NEUTRAL_CAPACITY;
    const income = container ? (Math.min(ttl, source.travelTime) * capacity) / ENERGY_REGEN_TIME : 0;
    const queued = _.sum(
        creepsByRole(source.homeRoom, REMOTE_HAULER).filter(c => c !== creep && !c.memory.delivering && c.memory.source === source.key),
        c => c.store.getFreeCapacity()
    );
    return energy + income - queued - (isRemoteUnderAttack(source) ? 1000 : 0) - 2 * source.travelTime;
}

function pickup(creep: Creep): void {
    const source = getRemoteSource(creep.memory.source);
    if (!source) {
        if (creep.store.getUsedCapacity() > 0) startDelivering(creep);
        else startPickup(creep);
        // Nothing to haul: wait at home
        if (!creep.memory.source && creep.room.name === creep.memory.room) trafficManager.requestMove(creep, creep.pos, { range: 0 });
        return;
    }
    const target = sourcePos(source);
    if (fleeIfThreatened(creep, target)) return;
    if (pickupNearby(creep)) return;
    if (creep.room.name !== source.room || creep.pos.getRangeTo(target) > 3) {
        trafficManager.requestMove(creep, target, { range: 2, priority: 45 });
        return;
    }
    const container = remoteContainer(source);
    const harvesterNear = creepsByRole(source.homeRoom, REMOTE_HARVESTER).some(
        c => c.memory.source === source.key && container && c.pos.inRangeTo(container, 3)
    );
    if (!container) {
        whenInRange(creep, 2, target, () => startDelivering(creep));
        return;
    }
    if (!harvesterNear && container.store.energy < 20) {
        startDelivering(creep);
        return;
    }
    whenInRange(creep, 1, container, () => {
        const enough = container.store.energy >= Math.min(container.store.getCapacity() / 2, creep.store.getFreeCapacity());
        const dying = (creep.ticksToLive ?? CREEP_LIFE_TIME) < 1.5 * source.travelTime;
        if ((enough || !harvesterNear || dying) && creep.withdraw(container, RESOURCE_ENERGY) === OK) startDelivering(creep);
    });
}

/** Piles, tombstones and ruins at range 3, outside our rooms */
function pickupNearby(creep: Creep): boolean {
    if (creep.room.controller?.my || creep.store.getFreeCapacity() === 0) return false;
    const pile = creep.pos.findInRange(FIND_DROPPED_RESOURCES, 3).find(r => r.resourceType === RESOURCE_ENERGY && r.amount >= 20);
    if (pile) {
        whenInRange(creep, 1, pile, () => creep.pickup(pile));
        return true;
    }
    const grave = [...creep.pos.findInRange(FIND_TOMBSTONES, 3), ...creep.pos.findInRange(FIND_RUINS, 3)].find(
        g => g.store.energy > 0
    );
    if (grave) {
        whenInRange(creep, 1, grave, () => creep.withdraw(grave, RESOURCE_ENERGY));
        return true;
    }
    return false;
}

function deliver(creep: Creep): void {
    const home = creep.memory.room ?? creep.room.name;
    if (fleeIfThreatened(creep)) return;
    if (creep.room.name !== home) {
        trafficManager.moveToRoom(creep, home, { priority: 45 });
        return;
    }
    // At home: deliver like a transporter (spawn, extensions, towers, workers, storage, center pile)
    performDeliver(creep);
    // performDeliver clears `delivering` when the creep has nothing left to deliver to
    creep.memory.delivering = true;
}

registerRole(REMOTE_HAULER, runRemoteHauler);
