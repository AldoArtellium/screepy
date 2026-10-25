/**
 * Threat of each hostile creep in a room, one score shared by the towers, the guardians and the squads
 * (not in Hivemind, which values a creep by its parts alone: HEAL 5, WORK 1...).
 * shard0 W28N7 (doorknobnob, 2026-10-24): 1-WORK decoys drew the guardian away from two 8-WORK
 * dismantlers working on a rampart. A creep is scored by what it can do (attack power, dismantling
 * included), whether it is doing it (touching one of our structures, or a ranged one within 3) and
 * where (next to the spawns, storage, towers or controller); a healer by its heal plus a share of the
 * threat it keeps alive (defense/threatModel.ts).
 */

import { tickCache } from "../core/roomState";
import { creepPower, hostileCreeps } from "./RoomDefense";
import { CRITICAL_RANGE, ThreatInput, ownThreat, threatScore } from "./threatModel";

const CRITICAL_TYPES: StructureConstant[] = [STRUCTURE_SPAWN, STRUCTURE_STORAGE, STRUCTURE_TERMINAL, STRUCTURE_TOWER];

/**
 * Threat of every hostile creep in the room by id, once per tick. In a room we don't own (a squad's
 * target) we have no structures there: the score then only uses power and healing.
 */
export function roomThreats(room: Room): Map<Id<Creep>, number> {
    return tickCache(`threats:${room.name}`, () => {
        const hostiles = hostileCreeps(room);
        const scores = new Map<Id<Creep>, number>();
        if (hostiles.length === 0) return scores;
        const ours = room.find(FIND_MY_STRUCTURES);
        const critical: RoomObject[] = ours.filter(s => CRITICAL_TYPES.includes(s.structureType));
        if (room.controller?.my) critical.push(room.controller);
        const inputs: { creep: Creep; input: ThreatInput }[] = hostiles.map(creep => {
            // Destroyed parts still count for 10% (Hivemind militaryValue's 0.1 floor): a creep with
            // every attack part gone scored 0, so the towers stopped shooting it (mockup raids lived
            // their whole 1500 ticks with 100 hits of MOVE left)
            const active = creepPower(creep, true);
            const all = creepPower(creep);
            const power = 0.9 * active.attack + 0.1 * all.attack;
            const reach = creep.getActiveBodyparts(RANGED_ATTACK) > 0 ? 3 : 1;
            return {
                creep,
                input: {
                    power,
                    heal: 0.9 * active.heal + 0.1 * all.heal,
                    active: power > 0 && creep.pos.findInRange(ours, reach).length > 0,
                    critical: power > 0 && creep.pos.findInRange(critical, CRITICAL_RANGE).length > 0,
                    patientThreat: 0
                }
            };
        });
        for (const { creep, input } of inputs) {
            if (input.heal === 0) continue;
            for (const other of inputs) {
                if (other.creep === creep || other.creep.pos.getRangeTo(creep) > 3) continue;
                input.patientThreat = Math.max(input.patientThreat, ownThreat(other.input));
            }
        }
        for (const { creep, input } of inputs) scores.set(creep.id, threatScore(input));
        return scores;
    });
}

/** Threat of one hostile creep in its room (0 for a creep that can neither hurt nor heal) */
export function threatOf(creep: Creep): number {
    return roomThreats(creep.room).get(creep.id) ?? 0;
}
