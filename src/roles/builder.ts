/**
 * Builder: builds and repairs once 90% full, upgrades the controller when there is nothing to do.
 * Never harvests: energy comes from the resource dispatcher or is delivered by transporters.
 * Ported from Hivemind (MIT), src/role/builder.ts.
 */

import { getBestOption } from "../core/options";
import { whenInRange } from "../core/movement";
import { clearOrder, creepsWithOrder, effectiveEnergy, hasEnemies, Order, setOrder, tickCache } from "../core/roomState";
import { roomPlanner } from "../planner/RoomPlanner";
import { countStat } from "../utils/stats";
import { performRecycle } from "./recycle";
import { registerRole } from "./registry";
import { performGetEnergy } from "./transporter";

declare global {
    interface CreepMemory {
        repairing?: boolean;
        upgrading?: boolean;
    }
    interface RoomMemory {
        /** Last tick a builder found nothing to build or repair */
        noBuilderNeeded?: number;
    }
}

/** Wall / rampart hits wanted per RCL (Hivemind settings maxWallHealth) */
const MAX_WALL_HEALTH: { [rcl: number]: number } = {
    0: 1, 1: 5000, 2: 10000, 3: 20000, 4: 100000, 5: 500000, 6: 2000000, 7: 3000000, 8: 20000000
};

type BuilderOption = Order & { object: Structure | ConstructionSite };

export function runBuilder(creep: Creep): void {
    const working = creep.memory.repairing || creep.memory.upgrading;
    if (working && creep.store.energy === 0) setBuilderState(creep, false);
    else if (!working && creep.store.getUsedCapacity() >= creep.store.getCapacity() * 0.9) setBuilderState(creep, true);

    if (creep.memory.upgrading) {
        performUpgrade(creep);
        return;
    }

    if (creep.memory.repairing) {
        if (!performRepair(creep)) {
            creep.room.memory.noBuilderNeeded = Game.time;
            if ((creep.room.controller?.level ?? 0) < 8 && !creep.room.controller?.upgradeBlocked) {
                creep.memory.upgrading = true;
                delete creep.memory.repairing;
                performUpgrade(creep);
            } else {
                delete creep.memory.repairing;
                performRecycle(creep);
            }
        }
        return;
    }

    // Collect: wait for a deliverer heading our way, else fetch
    const deliverer = creepsWithOrder(creep.room, "workerCreep", creep.id)[0];
    if (deliverer) {
        whenInRange(creep, 1, deliverer);
        return;
    }
    countStat("work:builderFetch");
    if (!creep.room.storage || effectiveEnergy(creep.room) > 2500) performGetEnergy(creep);
}

function setBuilderState(creep: Creep, repairing: boolean): void {
    creep.memory.repairing = repairing;
    delete creep.memory.upgrading;
    clearOrder(creep);
}

function performUpgrade(creep: Creep): void {
    const room = creep.room;
    const controller = room.controller;
    if (!controller || room.find(FIND_MY_CONSTRUCTION_SITES).length > 0) {
        delete creep.memory.upgrading;
        delete room.memory.noBuilderNeeded;
        return;
    }
    room.memory.noBuilderNeeded = Game.time;
    if ((room.storage && effectiveEnergy(room) < 25000) || controller.upgradeBlocked) {
        performRecycle(creep);
        return;
    }
    whenInRange(creep, 3, controller, () => {
        if (creep.upgradeController(controller) === OK) countStat("work:builderUpgrade");
    });
}

function performRepair(creep: Creep): boolean {
    let order = creep.memory.order;
    const isWorkOrder = order?.type === "build" || order?.type === "repair";
    if (!isWorkOrder || !order?.target || !Game.getObjectById(order.target as Id<Structure>)) {
        calculateBuilderTarget(creep);
        order = creep.memory.order;
    }
    const target = order?.target ? Game.getObjectById(order.target as Id<Structure | ConstructionSite>) : null;
    if (!order || !target) return false;

    if (order.type === "repair") {
        const structure = target as Structure;
        let maxHealth = order.maxHealth || structure.hitsMax;
        if (order.maxHealth && structure.structureType === STRUCTURE_RAMPART) {
            maxHealth = Math.min(maxHealth + 10000, structure.hitsMax);
        }
        if (!structure.hits || structure.hits >= maxHealth) {
            calculateBuilderTarget(creep);
            return true;
        }
        workOn(creep, structure, () => creep.repair(structure) === OK && countStat("work:repair"));
        return true;
    }
    const site = target as ConstructionSite;
    workOn(creep, site, () => creep.build(site) === OK && countStat("work:build"));
    return true;
}

function workOn(creep: Creep, target: Structure | ConstructionSite, action: () => void): void {
    if (whenInRange(creep, 3, target, action)) return;
    repairNearby(creep);
}

/** On the way, fix whatever is in range (not while half full, like Hivemind) */
function repairNearby(creep: Creep): void {
    const ratio = creep.store.energy / creep.store.getCapacity();
    if (ratio > 0.3 && ratio < 0.7) return;
    const work = creep.getActiveBodyparts(WORK);
    for (const structure of repairTargets(creep.room)) {
        if (!creep.pos.inRangeTo(structure, 3)) continue;
        if (structure.hits > maxHits(structure) - work * REPAIR_POWER) continue;
        creep.repair(structure);
        return;
    }
}

function calculateBuilderTarget(creep: Creep): void {
    clearOrder(creep);
    const best = getBestOption<BuilderOption>([...repairOptions(creep), ...buildOptions(creep)]);
    if (!best || best.priority <= 0) return;
    delete creep.room.memory.noBuilderNeeded;
    setOrder(creep, { type: best.type, target: best.object.id, priority: best.priority, weight: best.weight, maxHealth: best.maxHealth });
}

function maxHits(structure: Structure): number {
    if (structure.structureType === STRUCTURE_WALL || structure.structureType === STRUCTURE_RAMPART) {
        return MAX_WALL_HEALTH[structure.room.controller?.level ?? 0];
    }
    return structure.hitsMax;
}

/** Damaged structures worth repairing: planned roads, planned defenses, everything else */
function repairTargets(room: Room): Structure[] {
    return tickCache(`repairTargets:${room.name}`, () => {
        const plan = roomPlanner.getPlan(room.name);
        return room.find(FIND_STRUCTURES).filter(s => {
            if (!s.hits || s.hits >= maxHits(s)) return false;
            if (s.structureType === STRUCTURE_ROAD) return !plan || plan.has(s.pos, "road");
            if (s.structureType === STRUCTURE_RAMPART) return (s as StructureRampart).my && (!plan || plan.has(s.pos, "rampart"));
            if (s.structureType === STRUCTURE_WALL) return !plan || plan.has(s.pos, "wall");
            return !("my" in s) || (s as OwnedStructure).my;
        });
    });
}

function repairOptions(creep: Creep): BuilderOption[] {
    const room = creep.room;
    const options: BuilderOption[] = [];
    for (const target of repairTargets(room)) {
        const option: BuilderOption = { type: "repair", object: target, priority: 3, weight: 1 - target.hits / target.hitsMax };
        const isDefense = target.structureType === STRUCTURE_WALL || target.structureType === STRUCTURE_RAMPART;
        if (isDefense) {
            modifyDefenseOption(room, target, option);
        } else {
            const ratio = target.hits / target.hitsMax;
            if (ratio > 0.9) option.priority--;
            if (ratio < 0.2) option.priority++;
            if (target.structureType === STRUCTURE_ROAD && target.hits > target.hitsMax / 3) option.priority = 0;
            option.weight -= creep.pos.getRangeTo(target) / 100;
        }
        const decaying =
            target.structureType === STRUCTURE_ROAD ||
            target.structureType === STRUCTURE_RAMPART ||
            target.structureType === STRUCTURE_CONTAINER;
        if (decaying && target.hits / (option.maxHealth || target.hitsMax) > 0.9) continue;
        if (!hasEnemies(room)) option.priority -= creepsWithOrder(room, "repair", target.id).length;
        options.push(option);
    }
    return options;
}

function modifyDefenseOption(room: Room, target: Structure, option: BuilderOption): void {
    option.priority--;
    if (target.structureType === STRUCTURE_WALL) option.priority--;
    let maxHealth = maxHits(target);
    if (target.hits >= maxHealth * 0.9 && target.hits < target.hitsMax) {
        option.priority = (room.controller?.level ?? 0) < 8 ? -1 : 0;
        maxHealth = target.hitsMax;
    }
    option.weight = 1 - target.hits / maxHealth;
    option.maxHealth = maxHealth;
    if (target.structureType !== STRUCTURE_RAMPART) return;
    if (target.hits < 10000 && (room.controller?.level ?? 0) >= 3) {
        option.priority += 2;
        option.weight += 1;
    }
    if (hasEnemies(room)) {
        option.priority += 2;
        option.weight += 1;
    } else if (effectiveEnergy(room) < 5000 && target.hits >= 10000) {
        option.priority = -1;
    }
}

function buildOptions(creep: Creep): BuilderOption[] {
    const room = creep.room;
    return room.find(FIND_MY_CONSTRUCTION_SITES).map(site => {
        const option: BuilderOption = {
            type: "build",
            object: site,
            priority: 4,
            weight: site.progress / site.progressTotal - creep.pos.getRangeTo(site) / 100
        };
        if (site.progressTotal < 1000) option.priority -= creepsWithOrder(room, "build", site.id).length;
        if (site.structureType === STRUCTURE_SPAWN) option.priority = 5;
        const lowValue: StructureConstant[] = [STRUCTURE_ROAD, STRUCTURE_RAMPART, STRUCTURE_WALL, STRUCTURE_CONTAINER];
        if (lowValue.includes(site.structureType)) option.weight -= 1;
        const late: StructureConstant[] = [STRUCTURE_LAB, STRUCTURE_NUKER, STRUCTURE_FACTORY];
        if (late.includes(site.structureType)) option.priority -= 1;
        return option;
    });
}

registerRole("builder", runBuilder);
