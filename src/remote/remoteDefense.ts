/**
 * Remote defense: a defender for a mined remote with an invader core, or with hostiles once the home
 * room has 5000 energy to spare (before that, spawning there just stops until the hostiles die).
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
    EnemyData,
    isRemoteUnderAttack,
    remoteEnemyData,
    remoteHasInvaderCore,
    remoteSources,
    remoteThreatRoom
} from "./RemoteMining";

export const REMOTE_DEFENDER = "remoteDefender";

export const enum DefenseResponse {
    /** Melee only, against invader cores */
    ATTACKER = "attacker",
    MINI_BRAWLER = "miniBrawler",
    MINI_BLINKY = "miniBlinky",
    /** Blinky sized to the energy capacity */
    BLINKY = "blinky",
    /** Two blinkies leaving together (Hivemind RESPONSE_BLINKY_BLINKY_TRAIN, without the train) */
    BLINKY_PAIR = "blinkyPair"
}

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

/** 5 ATTACK + 3 HEAL; heal weighs 3 against melee */
const SMALL_DEFENDER_POWER = 5 * ATTACK_POWER + 3 * HEAL_POWER * 3;
/** 6 RANGED_ATTACK + 2 HEAL; heal weighs 5 */
const SMALL_BLINKY_POWER = 6 * RANGED_ATTACK_POWER + 2 * HEAL_POWER * 5;
/** Ticks the first members of a group wait at home for the others */
const GROUP_WAIT = 300;

/** Hivemind's power of a blinky body: heal weighs 5 */
function blinkyPower(body: BodyPartConstant[]): number {
    return _.sum(body, p => (p === RANGED_ATTACK ? RANGED_ATTACK_POWER : p === HEAL ? HEAL_POWER * 5 : 0));
}

/** Margin of the fight model: the hostiles must die this many times faster than our focused creep */
const WIN_MARGIN = 1.5;

/**
 * Whether `count` creeps of `body` win against the hostiles (not in Hivemind, whose power alone sent a
 * blinky pair against 720 boosted ranged damage): our ranged damage minus their healing against their
 * hits, their damage minus our healing against the hits of the creep they focus. Kiting keeps melee
 * hostiles out of reach unless they are as fast as us (W7N4 mockup: a bigMelee* caught a lone blinky
 * along the room edge and killed it).
 */
export function blinkyWins(enemies: EnemyData, body: BodyPartConstant[], count: number): boolean {
    const damage = count * RANGED_ATTACK_POWER * body.filter(p => p === RANGED_ATTACK).length - enemies.heal;
    if (damage <= 0) return false;
    const heal = count * HEAL_POWER * body.filter(p => p === HEAL).length;
    const incoming = enemies.fastMelee ? enemies.damage : enemies.rangedDamage;
    if (incoming <= heal) return true;
    const killTicks = enemies.hits / damage;
    const deathTicks = (body.length * 100) / (incoming - heal);
    return killTicks * WIN_MARGIN < deathTicks;
}

/**
 * Response to the hostiles (Hivemind getDefenseCreepSize); `miniBlinky` / `blinky`: the bodies the home
 * can spawn. Not in Hivemind: a blinky response also has to win the fight (blinkyWins), else the next
 * step, else none: the remote waits for the hostiles to die.
 */
export function defenseResponse(
    enemies: EnemyData,
    miniBlinky: BodyPartConstant[],
    blinky: BodyPartConstant[]
): DefenseResponse | null {
    const power = enemies.damage + 5 * enemies.heal;
    if (enemies.hasInvaderCore && power < SMALL_DEFENDER_POWER) return DefenseResponse.ATTACKER;
    if (power < SMALL_DEFENDER_POWER / 2 && !enemies.ranged) return DefenseResponse.MINI_BRAWLER;
    if (power < SMALL_BLINKY_POWER && blinkyWins(enemies, miniBlinky, 1)) return DefenseResponse.MINI_BLINKY;
    if (power < blinkyPower(blinky) && blinkyWins(enemies, blinky, 1)) return DefenseResponse.BLINKY;
    if (power < 2 * blinkyPower(blinky) && blinkyWins(enemies, blinky, 2)) return DefenseResponse.BLINKY_PAIR;
    return null;
}

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
        // Hivemind returns here: no remote gets a defender while the home room is short on energy
        if (underAttack && effectiveEnergy(home) < MIN_DEFENSE_ENERGY) return options;
        const recent = home.memory.recentDefender?.[room] ?? -Infinity;
        if (Game.time - recent < DEFENDER_DELAY) continue;
        if (creepsByRole(home.name, REMOTE_DEFENDER).some(c => c.memory.targetRoom === room)) continue;
        const response = defenseResponse(remoteEnemyData(source), blinkyBody(home, 6), blinkyBody(home));
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
    if (option.response === DefenseResponse.MINI_BRAWLER) {
        return buildBody({ weights: { [ATTACK]: 2, [HEAL]: 1 }, partLimits: { [ATTACK]: 5 }, ...common });
    }
    return blinkyBody(home, option.response === DefenseResponse.MINI_BLINKY ? 6 : undefined);
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
