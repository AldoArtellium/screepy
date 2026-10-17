/**
 * Pioneer: bootstraps a new or spawnless room. Fills up at home, travels to its target room and
 * stays there: upgrades the controller to RCL 2 first, fills the spawn and towers, builds (tower
 * sites, then spawn sites, then the closest), and gets energy from piles, the storage, containers
 * or by harvesting.
 * Ported from Hivemind (MIT), src/role/builder.remote.ts (and the builder unit's fillWithEnergy in
 * role/brawler.ts). Rampart rescue and extra energy from neighbour rooms are left out.
 */

import { stayInPlace, whenInRange } from "../core/movement";
import { effectiveEnergy, storageLocation } from "../core/roomState";
import { PIONEER } from "../expansion/squadSpawnRole";
import { trafficManager } from "../modules/TrafficManager";
import { countStat } from "../utils/stats";
import { fleeIfThreatened } from "./flee";
import { registerRole } from "./registry";
import { performGetEnergy } from "./transporter";

declare global {
    interface CreepMemory {
        /** Pioneer: filling up at home before leaving */
        filling?: boolean;
        /** Pioneer: spending energy (else getting some) */
        building?: boolean;
    }
}

/** Below this, pioneers wait at home instead of draining the room (Hivemind brawler fill) */
const MIN_FILL_ENERGY = 3000;

export function runPioneer(creep: Creep): void {
    const target = creep.memory.targetRoom;
    if (creep.memory.filling) {
        if (fillAtHome(creep)) return;
        delete creep.memory.filling;
    }
    if (target && creep.room.name !== target) {
        if (fleeIfThreatened(creep)) return;
        trafficManager.moveToRoom(creep, target, { priority: 40 });
        return;
    }

    const energy = creep.store.energy;
    if (creep.memory.building && energy === 0) creep.memory.building = false;
    else if (!creep.memory.building && creep.store.getFreeCapacity() === 0) creep.memory.building = true;
    if (creep.memory.building) build(creep);
    else getEnergy(creep);
}

/** True while still filling in an owned room */
function fillAtHome(creep: Creep): boolean {
    const room = creep.room;
    if (!room.controller?.my || creep.store.getFreeCapacity() === 0) return false;
    if (room.name === creep.memory.targetRoom) return false;
    if (effectiveEnergy(room) < MIN_FILL_ENERGY) {
        const center = storageLocation(room);
        if (center) whenInRange(creep, 5, center);
        return true;
    }
    performGetEnergy(creep);
    return true;
}

function build(creep: Creep): void {
    const room = creep.room;
    const controller = room.controller;
    const mine = !!controller?.my;

    // RCL 1 first goes to RCL 2; a controller close to downgrading is saved first
    if (mine && controller && !controller.upgradeBlocked && (controller.level < 2 || controller.ticksToDowngrade < 500)) {
        upgrade(creep, controller);
        return;
    }

    const spawn = room.find(FIND_MY_SPAWNS).find(s => s.store.energy < s.store.getCapacity(RESOURCE_ENERGY) * 0.8);
    if (spawn) {
        whenInRange(creep, 1, spawn, () => creep.transfer(spawn, RESOURCE_ENERGY));
        return;
    }
    const tower = room.find(FIND_MY_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_TOWER && s.store.getFreeCapacity(RESOURCE_ENERGY) > s.store.getCapacity(RESOURCE_ENERGY) / 2
    })[0] as StructureTower | undefined;
    if (tower) {
        whenInRange(creep, 1, tower, () => creep.transfer(tower, RESOURCE_ENERGY));
        return;
    }

    const site = buildTarget(creep);
    if (site) {
        whenInRange(creep, 3, site, () => creep.build(site) === OK && countStat("work:pioneerBuild"));
        return;
    }
    if (mine && controller) upgrade(creep, controller);
    else if (controller) whenInRange(creep, 4, controller);
    else stayInPlace(creep);
}

/** Tower sites, then spawn sites, then the closest site */
function buildTarget(creep: Creep): ConstructionSite | null {
    const sites = creep.room.find(FIND_MY_CONSTRUCTION_SITES);
    if (sites.length === 0) return null;
    for (const type of [STRUCTURE_TOWER, STRUCTURE_SPAWN]) {
        const site = creep.pos.findClosestByRange(sites.filter(s => s.structureType === type));
        if (site) return site;
    }
    return creep.pos.findClosestByRange(sites);
}

function upgrade(creep: Creep, controller: StructureController): void {
    whenInRange(creep, 3, controller, () => creep.upgradeController(controller) === OK && countStat("work:pioneerUpgrade"));
}

/** Piles, the storage, containers, else harvest the closest active source */
function getEnergy(creep: Creep): void {
    const room = creep.room;
    const pile = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
        filter: r => r.resourceType === RESOURCE_ENERGY && (r.amount > creep.store.getCapacity() * 0.3 || (creep.pos.getRangeTo(r) <= 1 && r.amount > 20))
    });
    if (pile) {
        whenInRange(creep, 1, pile, () => creep.pickup(pile));
        return;
    }
    if (room.storage && room.storage.store.energy > 5000) {
        const storage = room.storage;
        whenInRange(creep, 1, storage, () => creep.withdraw(storage, RESOURCE_ENERGY));
        return;
    }
    const container = creep.pos.findClosestByRange(FIND_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_CONTAINER && s.store.energy > 500
    }) as StructureContainer | null;
    if (container) {
        whenInRange(creep, 1, container, () => creep.withdraw(container, RESOURCE_ENERGY));
        return;
    }
    const reservation = room.controller?.reservation;
    if (!reservation || reservation.username === creep.owner.username) {
        // Not in Hivemind: skip sources whose tiles are all taken (the room's own harvesters once it
        // has a spawn), the path there fails every tick
        const source = creep.pos.findClosestByRange(FIND_SOURCES_ACTIVE, { filter: s => hasFreeTile(s.pos, creep) });
        if (source) {
            whenInRange(creep, 1, source, () => creep.harvest(source) === OK && countStat("work:pioneerHarvest"));
            return;
        }
    }
    performGetEnergy(creep);
}

function hasFreeTile(pos: RoomPosition, creep: Creep): boolean {
    const terrain = Game.map.getRoomTerrain(pos.roomName);
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            if (!dx && !dy) continue;
            const x = pos.x + dx;
            const y = pos.y + dy;
            if (x < 1 || x > 48 || y < 1 || y > 48 || terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
            const occupant = new RoomPosition(x, y, pos.roomName).lookFor(LOOK_CREEPS)[0];
            if (!occupant || occupant === creep) return true;
        }
    }
    return false;
}

registerRole(PIONEER, runPioneer);
