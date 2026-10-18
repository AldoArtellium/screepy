/**
 * Military intel: what our squads need to know about hostile rooms (towers, spawns, barriers,
 * invader cores and strongholds, defenders) and how much each player hurt us (infamy, after
 * Harabi's ROI target selection: the energy a player made us lose). Our design.
 */

import { remoteSources } from "../remote/RemoteMining";

export interface HostileRoom {
    /** Tick of the record */
    t: number;
    owner?: string;
    rcl?: number;
    towers: number;
    spawns: number;
    /** Tick the safe mode ends */
    safeMode?: number;
    /** Weakest hostile rampart or wall hits (0: none), the cost of a breach */
    barrier: number;
    /** Invader core level (0: plain core, 1+: stronghold) */
    coreLevel?: number;
    /** Tick the core is deployed (strongholds deploy their towers then) */
    coreDeploy?: number;
    /** Tick the stronghold collapses */
    collapse?: number;
    /** Damage and healing per tick of the hostile creeps */
    damage: number;
    heal: number;
}

declare global {
    interface Memory {
        military?: {
            /** Room to attack, set by hand (overrides the automatic target) */
            attack?: string;
            /** Allow automatic attacks on player rooms (default off: strongholds only) */
            auto?: boolean;
            /** Force the squad type of new missions ("duo" or "quad"; default: sized from the threat) */
            squad?: "duo" | "quad";
            /** Automatic target (strongholds near our rooms, players with `auto`) */
            target?: { room: string; reason: "stronghold" | "player"; since: number };
            duos: { [name: string]: import("./duo").DuoMemory };
            quads?: { [name: string]: import("./quad").QuadMemory };
            /** Lowest RCL of the attacking room (default 4; lower it to test sooner) */
            minRcl?: number;
            /** Highest stronghold level attacked automatically (default 1) */
            maxStrongholdLevel?: number;
            /** Finished missions */
            log?: { room: string; result: "success" | "abandoned"; time: number; losses: number; squad?: string }[];
            /** Hostile rooms seen */
            rooms?: { [room: string]: HostileRoom };
            /** Energy each player made us lose (decays) */
            infamy?: { [player: string]: number };
        };
    }
}

const RECORD_EVERY = 10;
const FORGET_AFTER = 50000;
const INFAMY_DECAY_EVERY = 1000;
const INFAMY_DECAY = 0.95;
const NPC = ["Invader", "Source Keeper"];

export function militaryMemory(): NonNullable<Memory["military"]> {
    if (!Memory.military) Memory.military = { duos: {} };
    return Memory.military;
}

function combatPower(creeps: Creep[]): { damage: number; heal: number } {
    let damage = 0;
    let heal = 0;
    for (const creep of creeps) {
        for (const part of creep.body) {
            if (part.hits <= 0) continue;
            const boost = part.boost ? 4 : 1;
            if (part.type === ATTACK) damage += ATTACK_POWER * boost;
            else if (part.type === RANGED_ATTACK) damage += RANGED_ATTACK_POWER * boost;
            else if (part.type === HEAL) heal += HEAL_POWER * boost;
        }
    }
    return { damage, heal };
}

function recordRoom(room: Room): void {
    const memory = militaryMemory();
    const owner = room.controller?.owner?.username;
    const hostileOwner = !!owner && !room.controller?.my;
    const structures = room.find(FIND_HOSTILE_STRUCTURES);
    const core = structures.find(s => s.structureType === STRUCTURE_INVADER_CORE) as StructureInvaderCore | undefined;
    if (!hostileOwner && !core && !structures.some(s => s.structureType === STRUCTURE_TOWER)) {
        if (memory.rooms?.[room.name]) delete memory.rooms[room.name];
        return;
    }
    const barriers = room.find(FIND_STRUCTURES, {
        filter: s =>
            s.structureType === STRUCTURE_WALL || (s.structureType === STRUCTURE_RAMPART && !(s as StructureRampart).my)
    });
    const collapse = core?.effects?.find(e => e.effect === EFFECT_COLLAPSE_TIMER);
    const power = combatPower(room.find(FIND_HOSTILE_CREEPS, { filter: c => c.owner.username !== "Source Keeper" }));
    memory.rooms = memory.rooms ?? {};
    memory.rooms[room.name] = {
        t: Game.time,
        ...(hostileOwner && { owner, rcl: room.controller!.level }),
        towers: structures.filter(s => s.structureType === STRUCTURE_TOWER).length,
        spawns: structures.filter(s => s.structureType === STRUCTURE_SPAWN).length,
        ...(room.controller?.safeMode && { safeMode: Game.time + room.controller.safeMode }),
        barrier: barriers.length ? _.min(barriers.map(s => s.hits)) : 0,
        ...(core && { coreLevel: core.level, coreDeploy: Game.time + (core.ticksToDeploy ?? 0) }),
        ...(collapse && { collapse: Game.time + collapse.ticksRemaining }),
        damage: power.damage,
        heal: power.heal
    };
}

/** Player creeps seen in our rooms and remotes (heap: each creep counted once) */
const seenCreeps: Set<string> = new Set();

function bodyCost(creep: Creep): number {
    return _.sum(creep.body, p => BODYPART_COST[p.type]);
}

/** Infamy: energy value of the player creeps that came into our rooms or remotes */
function recordInfamy(): void {
    const memory = militaryMemory();
    const ours = new Set<string>();
    for (const name in Game.rooms) {
        if (!Game.rooms[name].controller?.my) continue;
        ours.add(name);
        for (const source of remoteSources(name)) ours.add(source.room);
    }
    for (const roomName of ours) {
        const room = Game.rooms[roomName];
        if (!room) continue;
        for (const creep of room.find(FIND_HOSTILE_CREEPS)) {
            if (NPC.includes(creep.owner.username) || seenCreeps.has(creep.id)) continue;
            seenCreeps.add(creep.id);
            const fighter = creep.body.some(p => p.type === ATTACK || p.type === RANGED_ATTACK || p.type === WORK);
            memory.infamy = memory.infamy ?? {};
            memory.infamy[creep.owner.username] =
                (memory.infamy[creep.owner.username] ?? 0) + (fighter ? bodyCost(creep) : 100);
        }
    }
    if (Game.time % INFAMY_DECAY_EVERY === 0) {
        seenCreeps.clear();
        for (const player in memory.infamy ?? {}) {
            memory.infamy![player] *= INFAMY_DECAY;
            if (memory.infamy![player] < 10) delete memory.infamy![player];
        }
    }
}

/** Every RECORD_EVERY ticks: hostile rooms in sight; every tick: infamy */
export function updateMilitaryIntel(): void {
    recordInfamy();
    if (Game.time % RECORD_EVERY !== 0) return;
    for (const name in Game.rooms) recordRoom(Game.rooms[name]);
    const rooms = militaryMemory().rooms ?? {};
    for (const name in rooms) if (Game.time - rooms[name].t > FORGET_AFTER) delete rooms[name];
}

export function hostileRoom(roomName: string): HostileRoom | undefined {
    return militaryMemory().rooms?.[roomName];
}
