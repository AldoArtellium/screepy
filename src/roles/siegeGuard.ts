/**
 * Siege guard (military/siege.ts): holds a fallen player room while its controller is attacked. Kills
 * hostile creeps (workers, carriers, claimers and armed ones first), steps on hostile construction sites
 * (a hostile creep stepping on one destroys it: spawns and towers first), else parks near the controller.
 * Heals itself when hurt and not hitting. Our design.
 */

import { SIEGE_GUARD, sieges, travelToSiege } from "../military/siege";
import { trafficManager } from "../modules/TrafficManager";
import { performRecycle } from "./recycle";
import { registerRole } from "./registry";

const USEFUL: BodyPartConstant[] = [WORK, CARRY, CLAIM, ATTACK, RANGED_ATTACK, HEAL];
const SITE_ORDER: { [type: string]: number } = { [STRUCTURE_SPAWN]: 0, [STRUCTURE_TOWER]: 1 };
/** Parking range from the controller: the tiles next to it stay free for the attacker */
const PARK_RANGE = 3;

/** A hostile, non-public rampart on the tile: the site under it can't be stepped on */
function covered(site: ConstructionSite): boolean {
    return site.pos
        .lookFor(LOOK_STRUCTURES)
        .some(s => s.structureType === STRUCTURE_RAMPART && !(s as StructureRampart).my && !(s as StructureRampart).isPublic);
}

function siteToStomp(creep: Creep): ConstructionSite | null {
    const sites = creep.room.find(FIND_HOSTILE_CONSTRUCTION_SITES).filter(s => !covered(s));
    if (sites.length === 0) return null;
    const best = _.min(sites.map(s => SITE_ORDER[s.structureType] ?? 2));
    return creep.pos.findClosestByRange(sites.filter(s => (SITE_ORDER[s.structureType] ?? 2) === best));
}

export function runSiegeGuard(creep: Creep): void {
    const target = creep.memory.siege;
    if (!target || !sieges()[target]) {
        performRecycle(creep);
        return;
    }
    const hurt = creep.hits < creep.hitsMax;
    if (creep.room.name !== target) {
        if (hurt) creep.heal(creep);
        travelToSiege(creep, target);
        return;
    }
    const hostiles = creep.room.find(FIND_HOSTILE_CREEPS);
    const useful = hostiles.filter(c => c.body.some(p => USEFUL.includes(p.type)));
    const enemy = creep.pos.findClosestByRange(useful.length > 0 ? useful : hostiles);
    if (enemy) {
        // ATTACK and HEAL share the melee pipeline: heal only when not hitting
        if (creep.pos.isNearTo(enemy)) creep.attack(enemy);
        else if (hurt) creep.heal(creep);
        trafficManager.requestMove(creep, enemy, { range: 1, combat: true });
        return;
    }
    if (hurt) creep.heal(creep);
    const site = siteToStomp(creep);
    if (site) {
        trafficManager.requestMove(creep, site.pos, { range: 0 });
        return;
    }
    const controller = creep.room.controller;
    // Stops as soon as in range: it rarely stands next to the controller, and the attacker shoves it (traffic priority)
    if (controller) trafficManager.requestMove(creep, controller, { range: PARK_RANGE });
}

registerRole(SIEGE_GUARD, runSiegeGuard);
