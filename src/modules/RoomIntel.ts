/**
 * RoomIntel - hostile presence in every visible room: `room.memory.enemies` (read by spawning, the
 * dispatcher, builders and remote mining) and, for owned rooms, `room.memory.defenseMode` (towers).
 * Dangerous hostile (Hivemind isDangerous, MIT): a part other than MOVE/TOUGH, and outside our rooms
 * other than WORK/CARRY too. Out of sight a room stays unsafe until its last hostile is expected to die.
 */

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
            delete room.memory.enemies;
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
                damage: _.sum(hostiles, c => c.getActiveBodyparts(ATTACK) * ATTACK_POWER + c.getActiveBodyparts(RANGED_ATTACK) * RANGED_ATTACK_POWER),
                heal: _.sum(hostiles, c => c.getActiveBodyparts(HEAL) * HEAL_POWER),
                ranged: hostiles.some(c => c.getActiveBodyparts(RANGED_ATTACK) > 0)
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
