/**
 * DepositMining - mines one highway deposit at a time (phase 1 of the highway plan,
 * docs/decisions/resources.md "Highway intel"): picks it from the deposits IntelManager recorded
 * (`Memory.highwayIntel`) by return (highway/depositPlan.ts), keeps `Memory.depositMining`, and asks the
 * home room for its harvesters (roles/depositHarvester.ts). The resources go to the home storage or
 * terminal and are sold by the MarketManager (isCommodity).
 * Ported from Hivemind (MIT), strategy.deposit_mining and spawn-role/harvester.deposit; deviations in
 * depositPlan.ts and below (RCL 7, spawn priority, one deposit at a time).
 *
 * `Memory.highwayMining = { enabled?: false, minRoi?: number }` turns it off or changes the return needed.
 */

import { bodyCost, buildBody } from "../core/bodyBuilder";
import { effectiveEnergy } from "../core/roomState";
import { squadRoute } from "../military/route";
import { energyPrice } from "../modules/MarketManager";
import { isRoomUnderAttack } from "../modules/RoomIntel";
import { spawnManager } from "../modules/SpawnManager";
import { cpuPressure } from "../remote/remoteIncome";
import { log } from "../utils/logger";
import { chooseDeposit, DepositCandidate, DepositChoice, DepositHome } from "./depositPlan";
import { HIGHWAY_MAX_DISTANCE } from "./highwayIntel";

export const DEPOSIT_HARVESTER = "depositHarvester";

/** Ticks between two choices of the deposit */
const SELECTION_INTERVAL = 100;
/** Hivemind minRclForDepositMining is 8; a full 50-part harvester (3000 energy) fits RCL 7 */
const MIN_RCL = 7;
/** Hivemind minEnergyForDepositMining */
const MIN_ENERGY = 20000;
/** Hivemind spawns deposit harvesters only above this bucket */
const MIN_BUCKET = 8000;
/** Travel estimate per room of the route (full speed on plains, a 50-tile room) */
const TICKS_PER_ROOM = 50;
/** Hivemind priority 3, like the remote creeps; below them here until a balance is measured */
const SPAWN_PRIORITY = 2;
/** Energy capacity of an RCL 7 room: the body the return is computed for */
const MODEL_ENERGY = 5600;

export interface DepositOperation extends DepositChoice {
    since: number;
}

declare global {
    interface Memory {
        /** The deposit being mined */
        depositMining?: DepositOperation;
        /** Overrides: enabled false stops deposit mining, minRoi the return needed (default 1) */
        highwayMining?: { enabled?: boolean; minRoi?: number };
    }

    interface CreepMemory {
        /** Deposit a deposit harvester works on */
        deposit?: string;
    }
}

/** Hivemind body weights: CARRY 3, WORK 2, full speed on plains */
export function depositHarvesterBody(energy: number): BodyPartConstant[] {
    return buildBody({ weights: { [CARRY]: 3, [WORK]: 2 }, energyLimit: energy });
}

let lastSelection = -Infinity;

/** Owned rooms that can feed a deposit operation, with the ticks of their route to the deposit room */
function homesFor(room: string): DepositHome[] {
    const homes: DepositHome[] = [];
    for (const name in Game.rooms) {
        const home = Game.rooms[name];
        if (!home.controller?.my || home.controller.level < MIN_RCL || !home.storage) continue;
        if (Game.map.getRoomLinearDistance(name, room) > HIGHWAY_MAX_DISTANCE) continue;
        if (effectiveEnergy(home) < MIN_ENERGY) continue;
        const route = squadRoute(name, room);
        if (route) homes.push({ name, travel: (route.length - 1) * TICKS_PER_ROOM });
    }
    return homes;
}

function candidates(): DepositCandidate[] {
    const objects = Memory.highwayIntel?.objects ?? {};
    const result: DepositCandidate[] = [];
    for (const id in objects) {
        const o = objects[id];
        if (o.kind !== "deposit" || !o.type || o.decayAt <= Game.time || isRoomUnderAttack(o.room)) continue;
        result.push({
            id, room: o.room, x: o.x, y: o.y, type: o.type, cooldown: o.cooldown ?? 0, decayAt: o.decayAt, free: o.free
        });
    }
    return result;
}

/** The deposit is gone (decayed or exhausted out of sight): end the operation and date it in the log */
function depositGone(op: DepositOperation): boolean {
    if (!Game.rooms[op.room] || Game.getObjectById(op.id as Id<Deposit>)) return false;
    const logged = Memory.highwayIntel?.objects[op.id];
    if (logged) logged.decayAt = Math.min(logged.decayAt, Game.time);
    return true;
}

function select(): void {
    const settings = Memory.highwayMining ?? {};
    const current = Memory.depositMining;
    if (settings.enabled === false || (current && depositGone(current))) {
        if (current) log.info("DepositMining", `stop ${current.type} ${current.room} after ${Game.time - current.since} ticks`);
        delete Memory.depositMining;
        if (settings.enabled === false) return;
    }

    const body = depositHarvesterBody(MODEL_ENERGY);
    const model = { work: body.filter(p => p === WORK).length, carry: body.filter(p => p === CARRY).length };
    const all = candidates();
    const pick = (list: DepositCandidate[]) =>
        chooseDeposit(list, homesFor, energyPrice, model, bodyCost(body), Game.time, settings.minRoi ?? 1);
    // The current deposit is kept while it still pays: no switching back and forth between two
    const kept = Memory.depositMining ? pick(all.filter(c => c.id === Memory.depositMining!.id)) : null;
    const choice = kept ?? pick(all);
    if (!choice) {
        if (Memory.depositMining) log.info("DepositMining", `stop ${Memory.depositMining.type} ${Memory.depositMining.room}: no return`);
        delete Memory.depositMining;
        return;
    }
    if (!kept) log.info("DepositMining", `start ${choice.type} ${choice.room} from ${choice.home}, roi ${choice.roi.toFixed(2)}`);
    Memory.depositMining = { ...choice, since: kept ? Memory.depositMining!.since : Game.time };
}

/** Harvesters of the operation that still have time to work: a replacement spawns before one dies */
function activeHarvesters(op: DepositOperation, bodySize: number): number {
    return _.filter(
        Game.creeps,
        c => c.memory.role === DEPOSIT_HARVESTER && c.memory.deposit === op.id &&
            (c.spawning || (c.ticksToLive ?? 0) > op.travel + bodySize * CREEP_SPAWN_TIME)
    ).length;
}

export const depositMiningModule = () => {
    if (Game.time - lastSelection >= SELECTION_INTERVAL) {
        lastSelection = Game.time;
        select();
    }
    const op = Memory.depositMining;
    if (!op || cpuPressure() || Game.cpu.bucket < MIN_BUCKET) return;
    const home = Game.rooms[op.home];
    if (!home?.controller?.my) return;
    const body = depositHarvesterBody(home.energyCapacityAvailable);
    if (activeHarvesters(op, body.length) >= op.harvesters) return;
    spawnManager.requestSpawn({
        id: `deposit-${op.id}`,
        roomName: op.home,
        body,
        priority: SPAWN_PRIORITY,
        weight: 0,
        memory: { role: DEPOSIT_HARVESTER, room: op.home, deposit: op.id },
        ttl: 30,
        reason: `deposit ${op.type} ${op.room}`
    });
};
