/**
 * RoomIntel - hostile presence in every visible room: `room.memory.enemies` (read by spawning, the
 * dispatcher, builders and remote mining) and, for owned rooms, `room.memory.defenseMode` (towers).
 * Dangerous hostile (Hivemind isDangerous, MIT): a part other than MOVE/TOUGH, and outside our rooms
 * other than WORK/CARRY too. Out of sight a room stays unsafe until its last hostile is expected to die.
 */

import { activePower, effectiveHits, isFast } from "../defense/RoomDefense";
import { CONTEST_TTL, ContestEntry, contestingPlayer, isContested, noteContest, pruneContests } from "../remote/remoteRooms";
import { jitter } from "../utils/jitter";
import { log } from "../utils/logger";
import { countStat } from "../utils/stats";

declare global {
    interface RoomMemory {
        defenseMode?: boolean;
    }
    interface Memory {
        /** Rooms another player mines or reserves, blocked for remote mining (remote/remoteRooms.ts) */
        remoteContested?: { [room: string]: ContestEntry };
    }
}

/** Ticks between two prunings of Memory.remoteContested (heap timestamp: the module is mandatory) */
const CONTEST_PRUNE_INTERVAL = 1000;
let lastContestPrune = 0;

/**
 * Another player mining or reserving a room we don't own (not in Hivemind): shard0 W28N4, Blindfold's
 * harvester on the source container and its reserver, while ours fought its reservation back
 */
function recordContest(room: Room): void {
    const controller = room.controller;
    if (!controller || controller.owner) return;
    const reserver = controller.reservation?.username;
    const players = room.find(FIND_HOSTILE_CREEPS, {
        filter: c => c.owner.username !== "Invader" && c.owner.username !== "Source Keeper"
    });
    if (!players.length && (!reserver || reserver === Memory.username || reserver === "Invader")) return;
    let sources: Source[] | undefined;
    const creeps = players.map(c => ({
        owner: c.owner.username,
        harvests:
            c.getActiveBodyparts(WORK) > 0 && (sources ??= room.find(FIND_SOURCES)).some(s => c.pos.isNearTo(s)),
        claims: c.getActiveBodyparts(CLAIM) > 0 && c.pos.isNearTo(controller)
    }));
    const player = contestingPlayer({ reserver, creeps }, Memory.username);
    if (!player) return;
    Memory.remoteContested ??= {};
    if (noteContest(Memory.remoteContested, room.name, player, Game.time, jitter(CONTEST_TTL))) {
        countStat("remote:contested");
        log.info("RoomIntel", `${room.name} contested by ${player}: no remote mining there for ~${CONTEST_TTL} ticks`);
    }
}

/** Another player mined or reserved the room within the last ~20000 ticks */
export function isRoomContested(roomName: string): boolean {
    return isContested(Memory.remoteContested?.[roomName], Game.time);
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
    if (Memory.remoteContested && Game.time - lastContestPrune >= CONTEST_PRUNE_INTERVAL) {
        lastContestPrune = Game.time;
        pruneContests(Memory.remoteContested, Game.time);
        if (Object.keys(Memory.remoteContested).length === 0) delete Memory.remoteContested;
    }
    for (const name in Game.rooms) {
        const room = Game.rooms[name];
        recordContest(room);
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
