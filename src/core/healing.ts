/**
 * Idle healing: a creep with HEAL parts and nothing to do heals our wounded creeps of its room. A damaged
 * part does nothing until healed (a remote harvester hit by an invader or a keeper mines with its live
 * WORK parts only) and remote rooms have no tower to heal it. Our design: Hivemind's brawler heals only
 * its adjacent allies. Patient choice: core/patients.ts.
 */

import { trafficManager } from "../modules/TrafficManager";
import { countStat } from "../utils/stats";
import { pickPatient, RANGED_HEAL_RANGE } from "./patients";

export interface HealOptions {
    /** Walk to the patient (else heal only the wounded within RANGED_HEAL_RANGE) */
    move?: boolean;
    /** Farthest patient considered */
    maxRange?: number;
    /** Traffic priority of the walk */
    priority?: number;
}

/**
 * Heals the patient pickPatient chooses among our creeps in the healer's room (hostiles of the room as
 * danger): heal when adjacent, rangedHeal within 3, and walks to it when `move`. True when a patient was
 * found and the healer is busy with it. A heal intent issued earlier this tick blocks a rangedHeal.
 */
export function healWounded(creep: Creep, options: HealOptions = {}): boolean {
    if (creep.getActiveBodyparts(HEAL) === 0) return false;
    const wounded = creep.room.find(FIND_MY_CREEPS, { filter: c => c.hits < c.hitsMax && !c.spawning });
    if (wounded.length === 0) return false;
    const danger = creep.room.find(FIND_HOSTILE_CREEPS).map(c => c.pos);
    const limit = options.maxRange ?? Infinity;
    const patient = pickPatient(
        creep.pos,
        wounded.map(c => ({ id: c.id, x: c.pos.x, y: c.pos.y, hits: c.hits, hitsMax: c.hitsMax })),
        danger,
        options.move ? limit : Math.min(limit, RANGED_HEAL_RANGE)
    );
    const target = patient && Game.getObjectById(patient.id as Id<Creep>);
    if (!target) return false;
    const distance = creep.pos.getRangeTo(target);
    if (distance <= 1) {
        if (creep.heal(target) === OK && target.id !== creep.id) countStat("heal:idle");
    } else if (distance <= RANGED_HEAL_RANGE) {
        if (creep.rangedHeal(target) === OK) countStat("heal:idleRanged");
    }
    if (options.move && distance > 1) {
        trafficManager.requestMove(creep, target, { range: 1, priority: options.priority ?? 20 });
    }
    return true;
}
