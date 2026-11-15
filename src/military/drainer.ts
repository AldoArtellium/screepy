/**
 * Drainer: one cheap creep (TOUGH, HEAL, MOVE) sent before a quad that can't tank the target's towers
 * (sizing.ts SquadPlan.tanks). It bounces on the exit tile towards the target from the staging room (a
 * creep left on an exit tile changes room every tick): the towers spend a shot on it every other tick and
 * it heals on our side. It rests off the border below REST_HITS until READY_HITS. Meanwhile the mission
 * measures the towers' net drain (drainForecast.ts) and spawns the quad once the towers are predicted
 * empty by its arrival, or gives up with the drainer alone spent. It keeps draining while the quad
 * forms, travels and waits at the border (the only drain: the quad has no poker of its own, quad.ts
 * waitForDrain), and a drain the refills cancel then still ends the mission. Our design.
 */

import { needsBoosting } from "../labs/boosts";
import { trafficManager } from "../modules/TrafficManager";
import { onRoomEdge } from "../utils/rooms";
import { countStat } from "../utils/stats";
import { healPower } from "./combat";
import {
    DrainDecision,
    drainDecision,
    PROBE_TIMEOUT,
    quadLeadTime,
    recordPoke,
    sampleEnergy,
    wasHit
} from "./drainForecast";
import type { QuadMemory } from "./quad";
import { quadAttackerBody, quadHealerBody } from "./sizing";

export const DRAINER = "drainer";
/** Rests off the border below this share of its hits, back on the exit tile from READY_HITS */
const REST_HITS = 0.6;
const READY_HITS = 0.9;
const PRIORITY = 0;

declare global {
    interface CreepMemory {
        /** Quad mission the drainer drains for */
        drain?: string;
        /** Hits when it started its last tick in the target room and what it healed then (hit detection) */
        drainPoke?: { hits: number; healed: number };
        /** Resting off the border until READY_HITS */
        drainRest?: boolean;
    }
}

let drainersTick = -1;
let drainersByMission: Map<string, Creep[]> = new Map();

/** Drainers of a quad mission (spawning ones included) */
export function drainerCreeps(mission: string): Creep[] {
    if (drainersTick !== Game.time) {
        drainersTick = Game.time;
        drainersByMission = new Map();
        for (const name in Game.creeps) {
            const creep = Game.creeps[name];
            if (!creep.memory.drain) continue;
            const list = drainersByMission.get(creep.memory.drain) ?? [];
            list.push(creep);
            drainersByMission.set(creep.memory.drain, list);
        }
    }
    return drainersByMission.get(mission) ?? [];
}

/** Closest hostile creep within range 3, else the closest hostile structure there (not the controller) */
function shotTarget(creep: Creep): Creep | Structure | null {
    if (creep.getActiveBodyparts(RANGED_ATTACK) === 0) return null;
    const creeps = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 3);
    if (creeps.length > 0) return creep.pos.findClosestByRange(creeps);
    const structures = creep.pos
        .findInRange(FIND_STRUCTURES, 3)
        .filter(
            s =>
                s.structureType !== STRUCTURE_CONTROLLER &&
                (s.structureType === STRUCTURE_WALL || ("my" in s && !(s as OwnedStructure).my))
        );
    return structures.length > 0 ? creep.pos.findClosestByRange(structures) : null;
}

/** One tick of a drainer */
function runDrainer(creep: Creep, quad: QuadMemory): void {
    const hurt = creep.hits < creep.hitsMax;
    if (creep.room.name === quad.targetRoom) {
        // Healing only when already hurt: at full hits any hit shows next tick (drainForecast.ts wasHit)
        if (hurt) creep.heal(creep);
        creep.memory.drainPoke = { hits: creep.hits, healed: hurt ? healPower(creep.body) : 0 };
        // Armed and shooting (other pipeline than heal): towers that only target a threat still fire
        const target = shotTarget(creep);
        if (target) creep.rangedAttack(target);
        // On the exit tile: back to the staging room at the end of the tick. Pushed off it: back to it.
        if (onRoomEdge(creep.pos)) trafficManager.requestMove(creep, creep.pos, { range: 0, priority: PRIORITY });
        else trafficManager.moveToRoom(creep, quad.stagingRoom, { priority: PRIORITY });
        return;
    }
    if (hurt) creep.heal(creep);
    const poke = creep.memory.drainPoke;
    if (poke) {
        delete creep.memory.drainPoke;
        if (quad.probe) quad.probe = recordPoke(quad.probe, wasHit(poke.hits, creep.hits, poke.healed, creep.hitsMax));
        countStat("military:drainPoke");
    }
    if (creep.room.name !== quad.stagingRoom) {
        trafficManager.moveToRoom(creep, quad.stagingRoom, { priority: PRIORITY });
        return;
    }
    const ratio = creep.hits / creep.hitsMax;
    if (ratio < REST_HITS) creep.memory.drainRest = true;
    else if (ratio >= READY_HITS) delete creep.memory.drainRest;
    if (creep.memory.drainRest) {
        // Off the exit tile (else it changes room at the end of the tick), healing
        if (onRoomEdge(creep.pos)) trafficManager.moveToRoom(creep, creep.room.name, { priority: PRIORITY });
        else trafficManager.requestMove(creep, creep.pos, { range: 0, priority: PRIORITY });
        return;
    }
    const direction = Game.map.findExit(quad.stagingRoom, quad.targetRoom);
    const exit = direction > 0 ? creep.pos.findClosestByRange(creep.room.find(direction as ExitConstant)) : null;
    if (exit) trafficManager.requestMove(creep, exit, { range: 0, priority: PRIORITY });
    else trafficManager.requestMove(creep, creep.pos, { range: 0, priority: PRIORITY });
}

/** Ticks between spawning the quad and its arrival at the border (drainForecast.ts quadLeadTime) */
function leadTime(quad: QuadMemory): number {
    const spawnParts = 2 * quadAttackerBody(quad.energy).length + 2 * quadHealerBody(quad.energy).length;
    const spawns = quad.bases.reduce((sum, b) => sum + (Game.rooms[b]?.find(FIND_MY_SPAWNS).length ?? 0), 0);
    const boosted = !!quad.boosts && Object.values(quad.boosts).some(c => !!c);
    return quadLeadTime({ spawnParts, spawns, boosted, routeRooms: Math.max(0, (quad.length ?? 1) - 1) });
}

/**
 * Runs the mission's drainers and samples the towers while one stands in the target room (vision);
 * while probing or waiting at the border, the decision: "spawn" the quad (probing only), give up
 * ("noFire", "noProgress") or "wait"
 */
export function runDrainers(name: string, quad: QuadMemory): DrainDecision {
    // Not boosted (military.ts boosts), but walked to the labs by an older request: CreepRunner moves it
    const drainers = drainerCreeps(name).filter(c => !c.spawning && !needsBoosting(c));
    for (const creep of drainers) runDrainer(creep, quad);
    const room = Game.rooms[quad.targetRoom];
    if (room && drainers.some(c => c.room.name === quad.targetRoom)) {
        // Towers under one shot of energy can't fire: empty for the forecast
        const towers = room.find(FIND_HOSTILE_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_TOWER
        }) as StructureTower[];
        const energy = _.sum(towers, t => (t.store.energy >= TOWER_ENERGY_COST ? t.store.energy : 0));
        quad.probe = sampleEnergy(quad.probe, Game.time, energy);
        quad.probeEnergy = energy;
    }
    // Decided while probing and while the quad waits at the border (only the giving up then: it goes
    // in once it sees the towers empty, quad.ts)
    if (quad.state !== "probe" && quad.state !== "wait") return "wait";
    // The drainer never got to the target (blocked, killed on the way): no forecast to wait for
    if (!quad.probe && Game.time - (quad.probeSince ?? Game.time) >= PROBE_TIMEOUT) return "noProgress";
    // Only with a drainer at work: a forecast left from a dead one would decide on old samples
    if (!quad.probe || quad.probeEnergy === undefined || drainers.length === 0) return "wait";
    const decision = drainDecision(quad.probe, Game.time, quad.probeEnergy, leadTime(quad));
    return quad.state === "probe" || decision !== "spawn" ? decision : "wait";
}
