/**
 * Remote defense: a defender for a mined remote with an invader core, or with hostiles once the home
 * room has 5000 energy to spare (before that, spawning there just stops until the hostiles die; before
 * the storage invaders get one anyway, see defenseModel.ts).
 * Ported from Hivemind (MIT), src/spawn-role/brawler.ts (remote part, getDefenseCreepSize).
 * See docs/hivemind/hivemind-remote.md §9.3. Hivemind's ladder: mini brawler, mini blinky, a blinky
 * sized to the energy capacity, then 2-creep trains; of the trains only the blinky pair is kept (two
 * blinkies that wait for each other at home, then kite and heal each other). Larger threats get no
 * defender (the remote waits for the hostiles to die); strongholds (invader cores of level 1+) are
 * left to the military module.
 */

import { buildBody, MoveMode } from "../core/bodyBuilder";
import { creepsByRole, effectiveEnergy } from "../core/roomState";
import type { SpawnOption } from "../spawning/spawnRoles";
import {
    isRemoteUnderAttack,
    remoteEnemyData,
    remoteHasInvaderCore,
    remoteSources,
    remoteThreatRoom
} from "./RemoteMining";
import { DefenseResponse, defenseResponse, meleeOrder, skipsEnergyGate, unarmedPlayers } from "./defenseModel";

export { DefenseResponse } from "./defenseModel";

export const REMOTE_DEFENDER = "remoteDefender";

declare global {
    interface CreepMemory {
        /** Remote defender: room to clear */
        targetRoom?: string;
        /** Remote defender of a group: group id ("<targetRoom>:<tick of the first spawn>") and size */
        defenseGroup?: string;
        defenseGroupSize?: number;
        /** The group left home: no more members are spawned, the survivors don't wait again */
        defenseGroupLeft?: boolean;
    }
    interface RoomMemory {
        /** Last defender spawned for each remote room */
        recentDefender?: { [room: string]: number };
    }
}

/** Ticks between two defenders for the same remote (Hivemind: 300 when profitable, else 1500) */
const DEFENDER_DELAY = 300;
const MIN_DEFENSE_ENERGY = 5000;

/** Ticks the first members of a group wait at home for the others */
const GROUP_WAIT = 300;

export type DefenseOption = SpawnOption & { targetRoom: string; response: DefenseResponse; group?: string };

/** Members of a defender group (spawning ones included) */
export function groupMembers(home: string, group: string): Creep[] {
    return creepsByRole(home, REMOTE_DEFENDER).filter(c => c.memory.defenseGroup === group);
}

/** First members wait at home until the group is complete, at most GROUP_WAIT ticks */
export function waitingForGroup(creep: Creep): boolean {
    const group = creep.memory.defenseGroup;
    if (!group || !creep.memory.room || creep.memory.defenseGroupLeft) return false;
    const members = groupMembers(creep.memory.room, group);
    const complete = members.length >= (creep.memory.defenseGroupSize ?? 1) && !members.some(c => c.spawning);
    if (complete || Game.time - Number(group.split(":")[1]) > GROUP_WAIT) {
        creep.memory.defenseGroupLeft = true;
        return false;
    }
    return true;
}

/** Next member of the groups still being spawned (Hivemind train segments: priority 4) */
function groupOptions(home: Room): DefenseOption[] {
    const options: DefenseOption[] = [];
    const seen = new Set<string>();
    for (const creep of creepsByRole(home.name, REMOTE_DEFENDER)) {
        const group = creep.memory.defenseGroup;
        if (!group || seen.has(group) || !creep.memory.targetRoom) continue;
        seen.add(group);
        const members = groupMembers(home.name, group);
        if (members.some(c => c.memory.defenseGroupLeft)) continue;
        if (Game.time - Number(group.split(":")[1]) > GROUP_WAIT) continue;
        if (members.length >= (creep.memory.defenseGroupSize ?? 1)) continue;
        // Hivemind: priority 4, weight 0; above the economy here so the first member waits less
        const response = DefenseResponse.BLINKY_PAIR;
        options.push({ role: REMOTE_DEFENDER, priority: 5, weight: 1, targetRoom: creep.memory.targetRoom, response, group });
    }
    return options;
}

export function remoteDefenseOptions(home: Room): DefenseOption[] {
    const options = groupOptions(home);
    if (options.length > 0) return options;
    const seen = new Set<string>();
    for (const source of remoteSources(home.name)) {
        const room = remoteThreatRoom(source);
        if (seen.has(room)) continue;
        seen.add(room);
        const underAttack = isRemoteUnderAttack(source);
        if (!underAttack && !remoteHasInvaderCore(source)) continue;
        // Strongholds (core level 1+) are military targets (military/targets.ts): an ATTACKER would die to their towers
        if ((Memory.military?.rooms?.[source.room]?.coreLevel ?? 0) > 0) continue;
        const enemies = remoteEnemyData(source);
        // A player's harvesters and reservers get no defender, and don't hold back the other remotes' defense
        if (unarmedPlayers(enemies)) continue;
        // Hivemind returns here: no remote gets a defender while the home room is short on energy
        if (underAttack && effectiveEnergy(home) < MIN_DEFENSE_ENERGY && !skipsEnergyGate(!!home.storage, enemies)) {
            return options;
        }
        const recent = home.memory.recentDefender?.[room] ?? -Infinity;
        if (Game.time - recent < DEFENDER_DELAY) continue;
        if (creepsByRole(home.name, REMOTE_DEFENDER).some(c => c.memory.targetRoom === room)) continue;
        const response = defenseResponse(enemies, miniBrawlerBody(home), blinkyBody(home, 6), blinkyBody(home));
        if (!response) continue;
        options.push({ role: REMOTE_DEFENDER, priority: 3, weight: 1, targetRoom: room, response });
    }
    return options;
}

function energyLimit(room: Room): number {
    return Math.min(room.energyCapacityAvailable, Math.max(room.energyCapacityAvailable * 0.9, room.energyAvailable));
}

export function remoteDefenderBody(home: Room, option: DefenseOption): BodyPartConstant[] {
    const common = { moveMode: MoveMode.PLAINS, moveBufferRatio: 0.4, energyLimit: energyLimit(home) };
    if (option.response === DefenseResponse.ATTACKER) return buildBody({ weights: { [ATTACK]: 1 }, ...common });
    if (option.response === DefenseResponse.MINI_BRAWLER) return miniBrawlerBody(home);
    return blinkyBody(home, option.response === DefenseResponse.MINI_BLINKY ? 6 : undefined);
}

function miniBrawlerBody(home: Room): BodyPartConstant[] {
    const body = buildBody({
        weights: { [ATTACK]: 2, [HEAL]: 1 },
        partLimits: { [ATTACK]: 5 },
        moveMode: MoveMode.PLAINS,
        moveBufferRatio: 0.4,
        energyLimit: energyLimit(home)
    });
    return meleeOrder(body);
}

function blinkyBody(home: Room, maxRanged?: number): BodyPartConstant[] {
    return buildBody({
        weights: { [RANGED_ATTACK]: 7, [HEAL]: 3 },
        partLimits: maxRanged ? { [RANGED_ATTACK]: maxRanged } : undefined,
        moveMode: MoveMode.PLAINS,
        moveBufferRatio: 0.4,
        energyLimit: energyLimit(home)
    });
}

/** Called right before the spawn: remember it so the next defender waits DEFENDER_DELAY */
export function remoteDefenderMemory(home: Room, option: DefenseOption): Partial<CreepMemory> {
    home.memory.recentDefender = { ...home.memory.recentDefender, [option.targetRoom]: Game.time };
    const memory: Partial<CreepMemory> = { role: REMOTE_DEFENDER, room: home.name, targetRoom: option.targetRoom };
    if (option.response === DefenseResponse.BLINKY_PAIR) {
        memory.defenseGroup = option.group ?? `${option.targetRoom}:${Game.time}`;
        memory.defenseGroupSize = 2;
    }
    return memory;
}
