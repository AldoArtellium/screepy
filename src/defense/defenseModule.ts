/**
 * Owned room defense, every tick: towers (attack the military target, else heal, else repair the
 * ramparts hostiles hit during a serious attack) and safe mode.
 * Ported from Hivemind (MIT), src/process/rooms/owned/defense.ts. Towers repair nothing else
 * (builders keep roads and containers up).
 */

import { log } from "../utils/logger";
import { countStat } from "../utils/stats";
import {
    canKillBeforeFleeing,
    ENEMY_STRENGTH_NONE,
    ENEMY_STRENGTH_NORMAL,
    EnemyStrength,
    enemyStrength,
    hostileCreeps,
    isDangerous,
    isWallIntact,
    myRooms,
    towerPowerAtRange,
    towerTarget
} from "./RoomDefense";

const IMPORTANT_STRUCTURES: StructureConstant[] = [
    STRUCTURE_FACTORY,
    STRUCTURE_LAB,
    STRUCTURE_NUKER,
    STRUCTURE_POWER_SPAWN,
    STRUCTURE_SPAWN,
    STRUCTURE_STORAGE,
    STRUCTURE_TERMINAL
];

function manageTowers(room: Room): void {
    const towers = room.find(FIND_MY_STRUCTURES, {
        filter: s => s.structureType === STRUCTURE_TOWER && s.store.energy > 0 && s.isActive()
    }) as StructureTower[];
    if (towers.length === 0) return;
    const hostiles = hostileCreeps(room);
    const strength = enemyStrength(room);
    for (const tower of towers) {
        if (towerAttack(room, tower, hostiles)) continue;
        if (towerHeal(room, tower, strength)) continue;
        towerRampartRepair(room, tower, hostiles, strength);
    }
}

function towerAttack(room: Room, tower: StructureTower, hostiles: Creep[]): boolean {
    if (hostiles.length === 0) return false;
    const target = towerTarget(room);
    if (!target) return false;
    // Don't get drained by creeps dancing on the room edge
    const shoot =
        (room.controller?.safeMode ?? 1000) < 200 ||
        target.pos.getRangeTo(25, 25) <= 20 ||
        target.owner.username === "Invader" ||
        target.hits < target.hitsMax ||
        canKillBeforeFleeing(room, target);
    if (!shoot) return false;
    if (tower.attack(target) !== OK) return false;
    countStat("tower:attack");
    return true;
}

/** Wounded fighters (any wounded creep when there are no enemies), lowest relative hits first */
function towerHeal(room: Room, tower: StructureTower, strength: EnemyStrength): boolean {
    const wounded = room.find(FIND_MY_CREEPS, {
        filter: c =>
            c.hits < c.hitsMax &&
            (c.getActiveBodyparts(ATTACK) > 0 || c.getActiveBodyparts(RANGED_ATTACK) > 0 || strength === ENEMY_STRENGTH_NONE)
    });
    if (wounded.length === 0) return false;
    const target = _.min(wounded, c => c.hits / c.hitsMax / (1 + towerPowerAtRange(tower.pos.getRangeTo(c))));
    return typeof target !== "number" && tower.heal(target) === OK;
}

/** During a serious attack, with half a tower of energy: the weakest rampart a hostile can hit */
function towerRampartRepair(room: Room, tower: StructureTower, hostiles: Creep[], strength: EnemyStrength): boolean {
    if (strength < ENEMY_STRENGTH_NORMAL) return false;
    if (tower.store.energy < tower.store.getCapacity(RESOURCE_ENERGY) / 2) return false;
    const ramparts = room.find(FIND_MY_STRUCTURES, { filter: s => s.structureType === STRUCTURE_RAMPART });
    const endangered = ramparts.filter(r =>
        hostiles.some(h => isDangerous(h) && r.pos.getRangeTo(h) <= (h.getActiveBodyparts(RANGED_ATTACK) > 0 ? 3 : 1))
    );
    if (endangered.length === 0) return false;
    const target = _.min(endangered, r => r.hits / (1 + towerPowerAtRange(tower.pos.getRangeTo(r))));
    return typeof target !== "number" && tower.repair(target) === OK;
}

/**
 * Safe mode when the ramparts aren't complete and a hostile gets close to a spawn, the storage, the
 * controller... (with a single room, even weak enemies and invaders count).
 */
function manageSafeMode(room: Room): void {
    const controller = room.controller!;
    if (controller.safeMode || controller.safeModeCooldown || controller.safeModeAvailable === 0) return;
    const strength = enemyStrength(room);
    if (strength === ENEMY_STRENGTH_NONE) return;
    if (strength < ENEMY_STRENGTH_NORMAL && myRooms().length > 1) return;
    if (isWallIntact(room)) return;
    if (room.find(FIND_MY_SPAWNS).length === 0) return;
    if (!isEnemyCloseToImportantStructures(room)) return;
    const result = controller.activateSafeMode();
    if (result === OK) {
        log.warn("Defense", `Safe mode activated in ${room.name} (${controller.safeModeAvailable} left)`);
        Game.notify(`Activated safe mode in room ${room.name}. ${controller.safeModeAvailable} remaining.`);
        countStat("safeMode");
    }
}

function isEnemyCloseToImportantStructures(room: Room): boolean {
    const important: (Structure | ConstructionSite)[] = room.find(FIND_MY_STRUCTURES, {
        filter: s => IMPORTANT_STRUCTURES.includes(s.structureType)
    });
    important.push(room.controller!);
    important.push(
        ...room.find(FIND_MY_CONSTRUCTION_SITES, { filter: s => IMPORTANT_STRUCTURES.includes(s.structureType) && s.progress >= 10000 })
    );
    for (const target of important) {
        for (const creep of hostileCreeps(room)) {
            // Structures need a dangerous creep, construction sites can be stomped by anyone
            if (target instanceof Structure && !isDangerous(creep)) continue;
            // One more than the creep's range, to act before the damage
            const range = creep.getActiveBodyparts(RANGED_ATTACK) > 0 ? 4 : 2;
            if (target.pos.getRangeTo(creep) <= range) return true;
        }
    }
    return false;
}

export const defenseModule = (): void => {
    for (const room of myRooms()) {
        manageTowers(room);
        manageSafeMode(room);
    }
};
