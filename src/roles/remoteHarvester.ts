/**
 * Remote harvester: goes to its remote source, places and builds the container on the first tile of
 * the path, then harvests into it and keeps it repaired. Flees military hostiles.
 * Ported from Hivemind (MIT), src/role/harvester.remote.ts.
 */

import { followPath, whenInRange } from "../core/movement";
import { intelManager } from "../modules/IntelManager";
import { trafficManager } from "../modules/TrafficManager";
import { containerPos, getRemoteSource, hasRemoteContainer, remoteContainer, remotePath, sourcePos } from "../remote/RemoteMining";
import { REMOTE_HARVESTER } from "../remote/remoteSpawnRole";
import { buildEnergy, countRemoteHarvest, countWork, harvestEnergy } from "../utils/history";
import { fleeIfThreatened } from "./flee";
import { performRecycle } from "./recycle";
import { registerRole } from "./registry";

export function runRemoteHarvester(creep: Creep): void {
    const source = getRemoteSource(creep.memory.source);
    // Remote dropped from the selection: nothing to do any more
    if (!source) {
        performRecycle(creep);
        return;
    }
    const target = sourcePos(source);
    if (fleeIfThreatened(creep, target)) return;
    if (creep.room.name !== source.room || creep.pos.getRangeTo(target) > 2) {
        if (!followPath(creep, remotePath(source), true, 40)) trafficManager.requestMove(creep, target, { range: 1, priority: 40 });
        return;
    }

    const work = creep.getActiveBodyparts(CARRY) > 0 ? creep.getActiveBodyparts(WORK) : 0;
    const site = creep.pos.findClosestByRange(FIND_MY_CONSTRUCTION_SITES, {
        filter: s => s.structureType === STRUCTURE_CONTAINER || s.structureType === STRUCTURE_ROAD
    });
    if (site && creep.pos.inRangeTo(site, 3)) {
        if (work > 0 && creep.store.energy >= Math.min(BUILD_POWER * work, creep.store.getCapacity())) {
            if (creep.build(site) === OK) {
                countWork(creep, "remoteBuild", buildEnergy(creep, site));
                trafficManager.requestMove(creep, creep.pos, { range: 0 });
                return;
            }
        } else {
            const pile = creep.pos.findInRange(FIND_DROPPED_RESOURCES, 1).find(r => r.resourceType === RESOURCE_ENERGY);
            if (pile) creep.pickup(pile);
        }
    }

    const container = remoteContainer(source);
    if (
        container &&
        work > 0 &&
        creep.store.energy >= work &&
        creep.pos.inRangeTo(container, 3) &&
        container.hits <= container.hitsMax - work * REPAIR_POWER
    ) {
        creep.repair(container);
        trafficManager.requestMove(creep, creep.pos, { range: 0 });
        return;
    }

    const mine = Game.getObjectById(intelSourceId(source.room, target)) ?? target.lookFor(LOOK_SOURCES)[0];
    if (!mine) return;
    // Stand on the container when it is free, else next to the source
    const onContainer = container && !container.pos.lookFor(LOOK_CREEPS).some(c => c !== creep);
    const spot = onContainer ? container!.pos : target;
    whenInRange(creep, onContainer ? 0 : 1, spot, () => {
        if (mine.energy > 0 && creep.harvest(mine) === OK) countRemoteHarvest(creep, source.key, harvestEnergy(creep, mine));
        if (container && !creep.pos.isEqualTo(container.pos) && creep.store.getFreeCapacity() < creep.getActiveBodyparts(WORK) * 2) {
            creep.transfer(container, RESOURCE_ENERGY);
        }
        if (!hasRemoteContainer(source)) {
            const pos = containerPos(source);
            if (pos && !pos.lookFor(LOOK_CONSTRUCTION_SITES).some(s => s.structureType === STRUCTURE_CONTAINER)) {
                pos.createConstructionSite(STRUCTURE_CONTAINER);
            }
        }
    });
}

function intelSourceId(roomName: string, pos: RoomPosition): Id<Source> {
    const source = intelManager.getIntel(roomName)?.sources?.find(s => s.x === pos.x && s.y === pos.y);
    return (source?.id ?? "") as Id<Source>;
}

registerRole(REMOTE_HARVESTER, runRemoteHarvester);
