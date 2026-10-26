/**
 * Remote defense: a defender for a mined remote with an invader core, or with hostiles once the home
 * room has 5000 energy to spare (before that, spawning there just stops until the hostiles die; before
 * the storage invaders get one anyway, see defenseModel.ts).
 * Ported from Hivemind (MIT), src/spawn-role/brawler.ts (remote part, getDefenseCreepSize).
 * See docs/hivemind/hivemind-remote.md §9.3. Hivemind's ladder: mini brawler, mini blinky, a blinky
 * sized to the energy capacity, then 2-creep trains; of the trains only the blinky pair is kept (two
 * blinkies that wait for each other at home, then kite and heal each other). Larger threats get a
 * boosted defender when the home's labs and stock make one win (not in Hivemind, defenseModel.ts
 * boostedResponse), else none (the remote waits for the hostiles to die); strongholds (invader cores of
 * level 1+) are left to the military module.
 */

import { buildBody, MoveMode } from "../core/bodyBuilder";
import { creepsByRole, effectiveEnergy } from "../core/roomState";
import { BoostEffect, BoostPlan, boostableParts, boostsWith, canBoost, operationalLabs } from "../labs/boosts";
import { tierOf } from "../military/boostNeed";
import { energyPrice } from "../modules/MarketManager";
import type { SpawnOption } from "../spawning/spawnRoles";
import { log } from "../utils/logger";
import {
    isRemoteUnderAttack,
    remoteEnemyData,
    remoteHasInvaderCore,
    remoteSources,
    remoteThreatRoom
} from "./RemoteMining";
import {
    BoostStock,
    blinkyBody,
    boostedResponse,
    DefenseBoost,
    defenseCandidates,
    DefenseEffect,
    DefenseResponse,
    defenseResponse,
    miniBrawlerBody,
    skipsEnergyGate
} from "./defenseModel";

export { DefenseResponse } from "./defenseModel";

export const REMOTE_DEFENDER = "remoteDefender";

/** Boosts chosen for a remote defender: TOUGH parts in front and a compound per effect */
export interface DefenderBoosts {
    t: number;
    c: Partial<Record<DefenseEffect, string>>;
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
        /** Remote defender that only wins boosted: the boosts it was spawned for */
        defenseBoosts?: DefenderBoosts;
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

/**
 * Ticks a boosted remote defender waits for its boosts once out of the spawn (labs/boosts.ts default,
 * squads 500): the remote earns nothing meanwhile; without its boosts it recycles (remoteDefender.ts)
 */
export const REMOTE_DEFENDER_BOOST_TIMEOUT = 150;

export type DefenseOption = SpawnOption & {
    targetRoom: string;
    response: DefenseResponse;
    group?: string;
    boosts?: DefenderBoosts;
};

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
        // The second member gets the first one's body and boosts
        const boosts = creep.memory.defenseBoosts;
        options.push({ role: REMOTE_DEFENDER, priority: 5, weight: 1, targetRoom: creep.memory.targetRoom, response, group, boosts });
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
        // Hivemind returns here: no remote gets a defender while the home room is short on energy
        if (underAttack && effectiveEnergy(home) < MIN_DEFENSE_ENERGY && !skipsEnergyGate(!!home.storage, enemies)) {
            return options;
        }
        const recent = home.memory.recentDefender?.[room] ?? -Infinity;
        if (Game.time - recent < DEFENDER_DELAY) continue;
        if (creepsByRole(home.name, REMOTE_DEFENDER).some(c => c.memory.targetRoom === room)) continue;
        const energy = energyLimit(home);
        const response = defenseResponse(enemies, miniBrawlerBody(energy), blinkyBody(energy, 6), blinkyBody(energy));
        if (response) {
            options.push({ role: REMOTE_DEFENDER, priority: 3, weight: 1, targetRoom: room, response });
            continue;
        }
        const boosted = boostedDefense(home, enemies);
        if (!boosted) continue;
        options.push({
            role: REMOTE_DEFENDER,
            priority: 3,
            weight: 1,
            targetRoom: room,
            response: boosted.response,
            boosts: { t: boosted.tough, c: boosted.compounds },
            reason: `boosted ${Object.values(boosted.compounds).join("+")} vs ${room}`
        });
    }
    return options;
}

/** Part type and BOOSTS effect name of each defense effect */
const BOOST_PARTS: Record<DefenseEffect, [BodyPartConstant, BoostEffect]> = {
    heal: [HEAL, "heal"],
    rangedAttack: [RANGED_ATTACK, "rangedAttack"],
    attack: [ATTACK, "attack"],
    tough: [TOUGH, "damage"]
};

/** Compounds in the home's stock (beyond what other creeps asked for) for `parts` parts of an effect */
function boostStock(home: Room): BoostStock {
    return (effect, parts) => {
        const [part, name] = BOOST_PARTS[effect];
        const table = (BOOSTS as unknown as Record<string, Record<string, Record<string, number>>>)[part] ?? {};
        const result: DefenseBoost[] = [];
        for (const compound in table) {
            const multiplier = table[compound][name];
            if (multiplier === undefined || boostableParts(home, compound as ResourceConstant) < parts) continue;
            const cost = LAB_BOOST_MINERAL * energyPrice(compound as ResourceConstant) + LAB_BOOST_ENERGY;
            result.push({ compound, multiplier, cost, tier: tierOf(compound) });
        }
        return result;
    };
}

/** Boosted defender that wins when no unboosted one does (defenseModel.ts boostedResponse); a lab per compound */
function boostedDefense(home: Room, enemies: ReturnType<typeof remoteEnemyData>) {
    if (!canBoost(home)) return null;
    const labs = operationalLabs(home).length;
    return boostedResponse(enemies, defenseCandidates(energyLimit(home)), boostStock(home), labs);
}

function energyLimit(room: Room): number {
    return Math.min(room.energyCapacityAvailable, Math.max(room.energyCapacityAvailable * 0.9, room.energyAvailable));
}

export function remoteDefenderBody(home: Room, option: DefenseOption): BodyPartConstant[] {
    const energy = energyLimit(home);
    const common = { moveMode: MoveMode.PLAINS, moveBufferRatio: 0.4, energyLimit: energy };
    if (option.response === DefenseResponse.ATTACKER) return buildBody({ weights: { [ATTACK]: 1 }, ...common });
    if (option.response === DefenseResponse.MINI_BRAWLER) return miniBrawlerBody(energy);
    const maxRanged = option.response === DefenseResponse.MINI_BLINKY ? 6 : undefined;
    const tough = option.boosts?.t ?? 0;
    const body = blinkyBody(energy, maxRanged, tough);
    // The energy dropped since the choice (the TOUGH variant no longer fits): plain body, the boosts follow
    return body.length > 0 ? body : blinkyBody(energy, maxRanged);
}

/** Boosts of a remote defender: the compounds chosen with its option (boostsWith: the best in stock if one ran short) */
export function remoteDefenderBoosts(home: Room, option: DefenseOption, body: BodyPartConstant[]): BoostPlan {
    const chosen = option.boosts?.c;
    if (!chosen) return {};
    const planned = (Object.keys(chosen) as DefenseEffect[]).map(
        effect => [...BOOST_PARTS[effect], chosen[effect] ?? null] as [BodyPartConstant, BoostEffect, string | null]
    );
    return boostsWith(home, body, planned);
}

/** Called right before the spawn: remember it so the next defender waits DEFENDER_DELAY */
export function remoteDefenderMemory(home: Room, option: DefenseOption): Partial<CreepMemory> {
    home.memory.recentDefender = { ...home.memory.recentDefender, [option.targetRoom]: Game.time };
    const memory: Partial<CreepMemory> = { role: REMOTE_DEFENDER, room: home.name, targetRoom: option.targetRoom };
    if (option.response === DefenseResponse.BLINKY_PAIR) {
        memory.defenseGroup = option.group ?? `${option.targetRoom}:${Game.time}`;
        memory.defenseGroupSize = 2;
    }
    if (option.boosts) {
        memory.defenseBoosts = option.boosts;
        if (!option.group) {
            log.info("RemoteDefense", `${home.name}: boosted ${option.response} for ${option.targetRoom} (${JSON.stringify(option.boosts)})`);
        }
    }
    return memory;
}

/**
 * A boosted defender whose request is over (boosted or timed out) lacks a part type it was spawned to
 * boost: it only wins boosted
 */
export function missingBoosts(creep: Creep): boolean {
    const chosen = creep.memory.defenseBoosts?.c;
    if (!chosen) return false;
    return (Object.keys(chosen) as DefenseEffect[]).some(effect => {
        const part = BOOST_PARTS[effect][0];
        return creep.body.some(p => p.type === part) && !creep.body.some(p => p.type === part && p.boost);
    });
}
