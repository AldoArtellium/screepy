/**
 * PowerMining - cracks one highway power bank at a time and carries its power home (phase 2 of the
 * highway plan, docs/decisions/resources.md "Highway intel"): picks it from the power banks IntelManager
 * recorded (`Memory.highwayIntel`) by return (highway/powerPlan.ts), keeps `Memory.powerMining`, asks the
 * spawn rooms for attackers and healers (roles/powerHarvester.ts), then haulers (roles/powerHauler.ts) as
 * the bank nears its end. The power is sold by the MarketManager (no power spawn before RCL 8).
 * Ported from Hivemind (MIT), process/strategy/power-mining.ts, spawn-role/power-harvester.ts and
 * power-hauler.ts; deviations in powerPlan.ts and below (RCL 7).
 *
 * `Memory.highwayMining = { enabled?: false, minRoi?: number }` also covers it.
 */

import { bodyCost, buildBody, MoveMode } from "../core/bodyBuilder";
import { effectiveEnergy } from "../core/roomState";
import { squadRoute } from "../military/route";
import { energyPrice } from "../modules/MarketManager";
import { isRoomUnderAttack } from "../modules/RoomIntel";
import { spawnManager } from "../modules/SpawnManager";
import { cpuPressure } from "../remote/remoteIncome";
import { log } from "../utils/logger";
import { countStat } from "../utils/stats";
import { HIGHWAY_MAX_DISTANCE } from "./highwayIntel";
import { choosePowerBank, PowerBankInfo, PowerHome, PowerPlan } from "./powerPlan";

export const POWER_HARVESTER = "powerHarvester";
export const POWER_HAULER = "powerHauler";

/** Ticks between two choices of the power bank */
const SELECTION_INTERVAL = 100;
/** Hivemind minRclForPowerMining is 8; the plan's return accounts for the weaker RCL 7 healers */
const MIN_RCL = 7;
/** Hivemind minEnergyForPowerHarvesting */
const MIN_ENERGY = 75000;
const MIN_BUCKET = 8000;
/** Hivemind: no new bank above this much stored power */
const MAX_STORED_POWER = 100000;
const TICKS_PER_ROOM = 50;
/** Hivemind powerMineCreepPriority: the bank decays, its creeps can't wait behind the remotes */
const SPAWN_PRIORITY = 3;

export interface PowerOperation extends PowerPlan {
    hits: number;
    decayAt: number;
    since: number;
    /** The bank broke with its power on the ground or in our haulers */
    cracked?: boolean;
}

declare global {
    interface Memory {
        /** The power bank being cracked */
        powerMining?: PowerOperation;
    }

    interface CreepMemory {
        /** Power bank a power harvester or hauler works on */
        powerBank?: string;
        /** Power harvester that heals instead of attacking */
        isHealer?: boolean;
    }
}

export function attackerBody(energy: number): BodyPartConstant[] {
    return buildBody({ weights: { [ATTACK]: 1 }, moveBufferRatio: 1, energyLimit: energy });
}

export function healerBody(energy: number): BodyPartConstant[] {
    return buildBody({ weights: { [HEAL]: 1 }, moveBufferRatio: 1, energyLimit: energy });
}

export function haulerBody(energy: number): BodyPartConstant[] {
    return buildBody({ weights: { [CARRY]: 1 }, moveMode: MoveMode.ROAD, energyLimit: energy });
}

const parts = (body: BodyPartConstant[], type: BodyPartConstant) => body.filter(p => p === type).length;

function homesFor(room: string): PowerHome[] {
    const homes: PowerHome[] = [];
    for (const name in Game.rooms) {
        const home = Game.rooms[name];
        if (!home.controller?.my || home.controller.level < MIN_RCL || !home.storage) continue;
        if (Game.map.getRoomLinearDistance(name, room) > HIGHWAY_MAX_DISTANCE) continue;
        if (effectiveEnergy(home) < MIN_ENERGY) continue;
        const route = squadRoute(name, room);
        if (!route) continue;
        const energy = home.energyCapacityAvailable;
        const attacker = attackerBody(energy);
        const healer = healerBody(energy);
        const hauler = haulerBody(energy);
        homes.push({
            name, travel: (route.length - 1) * TICKS_PER_ROOM,
            attack: parts(attacker, ATTACK), heal: parts(healer, HEAL), carry: parts(hauler, CARRY),
            attackerCost: bodyCost(attacker), healerCost: bodyCost(healer), haulerCost: bodyCost(hauler)
        });
    }
    return homes;
}

function candidates(): PowerBankInfo[] {
    const objects = Memory.highwayIntel?.objects ?? {};
    const result: PowerBankInfo[] = [];
    for (const id in objects) {
        const o = objects[id];
        if (o.kind !== "powerBank" || !o.power || o.decayAt <= Game.time || isRoomUnderAttack(o.room)) continue;
        result.push({
            id, room: o.room, x: o.x, y: o.y, power: o.power, hits: o.hits ?? POWER_BANK_HITS,
            decayAt: o.decayAt, free: o.free
        });
    }
    return result;
}

function storedPower(): number {
    let total = 0;
    for (const name in Game.rooms) {
        const room = Game.rooms[name];
        if (!room.controller?.my) continue;
        total += (room.storage?.store[RESOURCE_POWER] ?? 0) + (room.terminal?.store[RESOURCE_POWER] ?? 0);
    }
    return total;
}

/** Power left in the bank room once the bank is gone: piles and ruins */
function powerLeft(room: Room): number {
    const piles = room.find(FIND_DROPPED_RESOURCES, { filter: r => r.resourceType === RESOURCE_POWER });
    const ruins = room.find(FIND_RUINS, { filter: r => r.store[RESOURCE_POWER] > 0 });
    return _.sum(piles, p => p.amount) + _.sum(ruins, r => r.store[RESOURCE_POWER]);
}

function opCreeps(op: PowerOperation, role: string): Creep[] {
    return _.filter(Game.creeps, c => c.memory.role === role && c.memory.powerBank === op.id);
}

/** End the operation and date the bank's decay in the log, so it is never picked again */
function end(op: PowerOperation, why: string, counter: string): void {
    log.info("PowerMining", `end ${op.room} (${op.power} power) after ${Game.time - op.since} ticks: ${why}`);
    countStat(counter);
    const logged = Memory.highwayIntel?.objects[op.id];
    if (logged) logged.decayAt = Math.min(logged.decayAt, Game.time);
    delete Memory.powerMining;
}

/** Bank state from sight; true when the operation is over */
function update(op: PowerOperation): boolean {
    const room = Game.rooms[op.room];
    if (!room) {
        if (Game.time <= op.decayAt + 1000) return false;
        end(op, "out of sight past its decay", "power:failed");
        return true;
    }
    const bank = Game.getObjectById(op.id as Id<StructurePowerBank>);
    if (bank) {
        op.hits = bank.hits;
        op.decayAt = Game.time + bank.ticksToDecay;
        return false;
    }
    // Haulers next to the bank pick its power up within the ticks between two runs: what they carry counts
    const carried = _.sum(opCreeps(op, POWER_HAULER), c => c.store[RESOURCE_POWER] ?? 0);
    if (powerLeft(room) > 0 || carried > 0) {
        op.cracked = true;
        op.hits = 0;
        return false;
    }
    if (op.cracked) end(op, "power carried home", "power:done");
    // Gone with no power on the ground nor in our haulers: it decayed or someone else cracked it
    else end(op, "gone before we cracked it", "power:failed");
    return true;
}

function select(): void {
    const settings = Memory.highwayMining ?? {};
    if (settings.enabled === false || cpuPressure() || Game.cpu.bucket < MIN_BUCKET) return;
    if (storedPower() > MAX_STORED_POWER) return;
    const plan = choosePowerBank(candidates(), homesFor, energyPrice, Game.time, settings.minRoi ?? 1);
    if (!plan) return;
    const logged = Memory.highwayIntel?.objects[plan.id];
    const hits = logged?.hits ?? POWER_BANK_HITS;
    Memory.powerMining = { ...plan, hits, decayAt: logged?.decayAt ?? Game.time, since: Game.time };
    log.info("PowerMining", `start ${plan.room} (${plan.power} power) from ${plan.homes.join(",")}: ` +
        `${plan.attackers} attackers, ${plan.healers} healers, ${plan.haulers} haulers, roi ${plan.roi.toFixed(2)}`);
}

/** Still useful for the operation: spawning, or alive past the time the next one takes to get there */
function lasting(op: PowerOperation, creep: Creep): boolean {
    return creep.spawning || (creep.ticksToLive ?? 0) > op.travel + MAX_CREEP_SIZE * CREEP_SPAWN_TIME;
}

function request(op: PowerOperation, kind: "attacker" | "healer" | "hauler", index: number): void {
    const roomName = op.homes[index % op.homes.length];
    const home = Game.rooms[roomName];
    if (!home?.controller?.my) return;
    const energy = home.energyCapacityAvailable;
    const body = kind === "attacker" ? attackerBody(energy) : kind === "healer" ? healerBody(energy) : haulerBody(energy);
    const role = kind === "hauler" ? POWER_HAULER : POWER_HARVESTER;
    spawnManager.requestSpawn({
        id: `power-${op.id}-${kind}`,
        roomName,
        body,
        priority: SPAWN_PRIORITY,
        weight: kind === "hauler" ? 0.5 : 1,
        memory: { role, room: roomName, powerBank: op.id, ...(kind === "healer" ? { isHealer: true } : {}) },
        ttl: 30,
        reason: `power ${kind} ${op.room}`
    });
}

function spawnFor(op: PowerOperation): void {
    const harvesters = opCreeps(op, POWER_HARVESTER).filter(c => lasting(op, c));
    const attackers = harvesters.filter(c => !c.memory.isHealer);
    const healers = harvesters.filter(c => c.memory.isHealer);
    const haulers = opCreeps(op, POWER_HAULER);
    const damage = _.sum(attackers, c => c.getActiveBodyparts(ATTACK)) * ATTACK_POWER;

    if (op.hits > 0) {
        // Hivemind: attackers first, healers while their share lags behind
        if (attackers.length < op.attackers && attackers.length / op.attackers <= healers.length / op.healers) {
            request(op, "attacker", attackers.length);
            return;
        }
        if (healers.length < op.healers) {
            request(op, "healer", healers.length);
            return;
        }
    }
    // Hivemind: haulers once 80% of the time to crack it fits their spawn and travel
    const timeToKill = damage > 0 ? (0.8 * op.hits) / damage : Infinity;
    const lead = MAX_CREEP_SIZE * CREEP_SPAWN_TIME + Math.max(CREEP_LIFE_TIME / 3, op.travel);
    const due = op.hits === 0 || timeToKill <= lead;
    const capacity = _.sum(haulers, c => c.store.getCapacity());
    if (due && capacity < op.power * 1.2) request(op, "hauler", haulers.length);
}

let lastSelection = -Infinity;

export const powerMiningModule = () => {
    const op = Memory.powerMining;
    if (op) {
        if (update(op)) return;
        if (Memory.highwayMining?.enabled === false || cpuPressure() || Game.cpu.bucket < MIN_BUCKET) return;
        spawnFor(op);
        return;
    }
    if (Game.time - lastSelection >= SELECTION_INTERVAL) {
        lastSelection = Game.time;
        select();
    }
};
