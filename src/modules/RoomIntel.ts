/**
 * RoomIntel - hostile presence in every visible room: `room.memory.enemies` (read by spawning, the
 * dispatcher, builders and remote mining) and, for owned rooms, `room.memory.defenseMode` (towers).
 * Dangerous hostile (Hivemind isDangerous, MIT): a part other than MOVE/TOUGH, and outside our rooms
 * other than WORK/CARRY too. Out of sight a room stays unsafe until its last hostile is expected to die.
 */

import { activePower, effectiveHits, isFast } from "../defense/RoomDefense";

declare global {
    interface RoomMemory {
        defenseMode?: boolean;
    }
}

const HARMLESS_AT_HOME: BodyPartConstant[] = [MOVE, TOUGH];
const HARMLESS_ABROAD: BodyPartConstant[] = [MOVE, TOUGH, WORK, CARRY];

function dangerous(room: Room): Creep[] {
    const harmless = room.controller?.my ? HARMLESS_AT_HOME : HARMLESS_ABROAD;
    return room.find(FIND_HOSTILE_CREEPS, {
        filter: c =>
            c.owner.username !== "Source Keeper" && c.body.some(p => p.hits > 0 && !harmless.includes(p.type))
    });
}

export const roomIntelModule = () => {
    for (const name in Game.rooms) {
        const room = Game.rooms[name];
        const hostiles = dangerous(room);
        const cores = room.find(FIND_HOSTILE_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_INVADER_CORE
        }) as StructureInvaderCore[];
        const owned = !!room.controller?.my;
        if (!owned && hostiles.length === 0 && cores.length === 0) {
            // Through Memory.rooms: room.memory would create an entry for every room in sight
            const memory = Memory.rooms?.[name];
            if (memory?.enemies) {
                delete memory.enemies;
                if (Object.keys(memory).length === 0) delete Memory.rooms[name];
            }
            continue;
        }
        // A deployed core (level > 0) about to spawn defenders makes the room unsafe
        const safe = hostiles.length === 0 && cores.every(c => c.level === 0 || (c.ticksToDeploy ?? 0) > 1000);
        let expires = hostiles.length ? Game.time + _.max(hostiles.map(c => c.ticksToLive ?? CREEP_LIFE_TIME)) : undefined;
        for (const core of cores) {
            for (const effect of core.effects ?? []) {
                if (effect.effect !== EFFECT_COLLAPSE_TIMER) continue;
                expires = Math.max(expires ?? 0, Game.time + effect.ticksRemaining);
            }
        }
        room.memory.enemies = {
            safe,
            lastSeen: safe ? room.memory.enemies?.lastSeen : Game.time,
            ...(expires !== undefined && { expires }),
            ...(cores.length > 0 && { hasInvaderCore: true }),
            ...(hostiles.length > 0 && {
                // Boosts included (Hivemind getDamageCapacity / getHealCapacity): a boosted invader hits twice as hard
                damage: _.sum(
                    hostiles,
                    c => activePower(c, ATTACK, "attack") * ATTACK_POWER + activePower(c, RANGED_ATTACK, "rangedAttack") * RANGED_ATTACK_POWER
                ),
                heal: _.sum(hostiles, c => activePower(c, HEAL, "heal") * HEAL_POWER),
                rangedDamage: _.sum(hostiles, c => activePower(c, RANGED_ATTACK, "rangedAttack") * RANGED_ATTACK_POWER),
                hits: _.sum(hostiles, c => effectiveHits(c)),
                fastMelee: hostiles.some(c => c.getActiveBodyparts(ATTACK) > 0 && isFast(c)),
                ranged: hostiles.some(c => c.getActiveBodyparts(RANGED_ATTACK) > 0),
                players: hostiles.some(c => c.owner.username !== "Invader")
            })
        };
        if (owned) room.memory.defenseMode = !safe;
    }
};

/** A remote is unsafe while a dangerous hostile was seen there and is not expected dead yet */
export function isRoomUnderAttack(roomName: string): boolean {
    const enemies = Memory.rooms?.[roomName]?.enemies;
    return !!enemies && !enemies.safe && (enemies.expires ?? 0) > Game.time;
}

/** An invader core was seen in the room (kept out of sight until the room is seen without it) */
export function hasInvaderCore(roomName: string): boolean {
    return !!Memory.rooms?.[roomName]?.enemies?.hasInvaderCore;
}
