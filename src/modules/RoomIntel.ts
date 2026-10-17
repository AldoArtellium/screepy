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
        const hasInvaderCore = room.find(FIND_HOSTILE_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_INVADER_CORE
        }).length > 0;
        const owned = !!room.controller?.my;
        if (!owned && hostiles.length === 0 && !hasInvaderCore) {
            delete room.memory.enemies;
            continue;
        }
        const safe = hostiles.length === 0;
        const expires = safe ? undefined : Game.time + _.max(hostiles.map(c => c.ticksToLive ?? CREEP_LIFE_TIME));
        room.memory.enemies = {
            safe,
            lastSeen: safe ? room.memory.enemies?.lastSeen : Game.time,
            ...(expires !== undefined && { expires }),
            ...(hasInvaderCore && { hasInvaderCore })
        };
        if (owned) room.memory.defenseMode = !safe;
    }
};

/** A remote is unsafe while a dangerous hostile was seen there and is not expected dead yet */
export function isRoomUnderAttack(roomName: string): boolean {
    const enemies = Memory.rooms?.[roomName]?.enemies;
    return !!enemies && !enemies.safe && (enemies.expires ?? 0) > Game.time;
}
