/**
 * Remote defense: a defender for a mined remote with an invader core, or with hostiles once the home
 * room has 5000 energy to spare (before that, spawning there just stops until the hostiles die).
 * Ported from Hivemind (MIT), src/spawn-role/brawler.ts (remote part, getDefenseCreepSize).
 * See docs/hivemind/hivemind-remote.md §9.3. Larger threats (trains, quads) get no defender.
 */

import { buildBody, MoveMode } from "../core/bodyBuilder";
import { creepsByRole, effectiveEnergy } from "../core/roomState";
import type { SpawnOption } from "../spawning/spawnRoles";
import { EnemyData, isRemoteUnderAttack, remoteEnemyData, remoteHasInvaderCore, remoteSources } from "./RemoteMining";

export const REMOTE_DEFENDER = "remoteDefender";

export const enum DefenseResponse {
    /** Melee only, against invader cores */
    ATTACKER = "attacker",
    MINI_BRAWLER = "miniBrawler",
    MINI_BLINKY = "miniBlinky"
}

declare global {
    interface CreepMemory {
        /** Remote defender: room to clear */
        targetRoom?: string;
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

export function defenseResponse(enemies: EnemyData): DefenseResponse | null {
    const power = enemies.damage + 5 * enemies.heal;
    if (enemies.hasInvaderCore && power < SMALL_DEFENDER_POWER) return DefenseResponse.ATTACKER;
    if (power < SMALL_DEFENDER_POWER / 2 && !enemies.ranged) return DefenseResponse.MINI_BRAWLER;
    if (power < SMALL_BLINKY_POWER) return DefenseResponse.MINI_BLINKY;
    return null;
}

export type DefenseOption = SpawnOption & { targetRoom: string; response: DefenseResponse };

export function remoteDefenseOptions(home: Room): DefenseOption[] {
    const options: DefenseOption[] = [];
    const seen = new Set<string>();
    for (const source of remoteSources(home.name)) {
        if (seen.has(source.room)) continue;
        seen.add(source.room);
        const underAttack = isRemoteUnderAttack(source);
        if (!underAttack && !remoteHasInvaderCore(source)) continue;
        // Hivemind returns here: no remote gets a defender while the home room is short on energy
        if (underAttack && effectiveEnergy(home) < MIN_DEFENSE_ENERGY) return options;
        const recent = home.memory.recentDefender?.[source.room] ?? -Infinity;
        if (Game.time - recent < DEFENDER_DELAY) continue;
        if (creepsByRole(home.name, REMOTE_DEFENDER).some(c => c.memory.targetRoom === source.room)) continue;
        const response = defenseResponse(remoteEnemyData(source));
        if (!response) continue;
        options.push({ role: REMOTE_DEFENDER, priority: 3, weight: 1, targetRoom: source.room, response });
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
    return buildBody({ weights: { [RANGED_ATTACK]: 7, [HEAL]: 3 }, partLimits: { [RANGED_ATTACK]: 6 }, ...common });
}

/** Called right before the spawn: remember it so the next defender waits DEFENDER_DELAY */
export function remoteDefenderMemory(home: Room, option: DefenseOption): Partial<CreepMemory> {
    home.memory.recentDefender = { ...home.memory.recentDefender, [option.targetRoom]: Game.time };
    return { role: REMOTE_DEFENDER, room: home.name, targetRoom: option.targetRoom };
}
