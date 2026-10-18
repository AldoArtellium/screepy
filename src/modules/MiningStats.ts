/**
 * MiningStats - share of the source energy we actually harvest, per source: every source regenerates
 * every ENERGY_REGEN_TIME ticks, and the energy still in it on the last tick of a cycle is lost. A full
 * source without a regeneration timer (nobody harvests it) loses its whole capacity, counted per tick
 * seen. Only our rooms' sources and the selected remote sources, and only while visible.
 * The energy read on the last tick still includes that tick's harvest (<= 1% of a cycle).
 * Counters `mining:{available,wasted}:{local,remote}` for the mockup reports.
 */

import { countStat } from "../utils/stats";

/** Cycles kept per source (5 x 300 ticks) */
const MAX_CYCLES = 5;
const STALE_TICKS = MAX_CYCLES * ENERGY_REGEN_TIME;

interface Cycle {
    available: number;
    wasted: number;
}

interface SourceState {
    room: string;
    remote: boolean;
    /** Home room of a remote source (its own room for a local one) */
    home: string;
    cycles: Cycle[];
    /** Untouched full source: capacity lost per tick seen, pushed as a cycle every ENERGY_REGEN_TIME ticks */
    idle: Cycle;
    idleTicks: number;
    lastSeen: number;
}

const states: Map<Id<Source>, SourceState> = new Map();
/** Remote source key -> id (looked up once) */
const remoteIds: Map<string, Id<Source>> = new Map();

function pushCycle(state: SourceState, cycle: Cycle): void {
    state.cycles.push(cycle);
    if (state.cycles.length > MAX_CYCLES) state.cycles.shift();
    const kind = state.remote ? "remote" : "local";
    countStat(`mining:available:${kind}`, cycle.available);
    countStat(`mining:wasted:${kind}`, cycle.wasted);
}

function observe(source: Source, remote: boolean, home: string): void {
    let state = states.get(source.id);
    if (!state) {
        state = { room: source.room.name, remote, home, cycles: [], idle: { available: 0, wasted: 0 }, idleTicks: 0, lastSeen: 0 };
        states.set(source.id, state);
    }
    state.lastSeen = Game.time;
    state.remote = remote;
    state.home = home;
    if (source.ticksToRegeneration === undefined) {
        // Full and untouched: no timer runs
        state.idle.available += source.energyCapacity / ENERGY_REGEN_TIME;
        state.idle.wasted += source.energyCapacity / ENERGY_REGEN_TIME;
        if (++state.idleTicks >= ENERGY_REGEN_TIME) {
            pushCycle(state, state.idle);
            state.idle = { available: 0, wasted: 0 };
            state.idleTicks = 0;
        }
        return;
    }
    if (source.ticksToRegeneration === 1) pushCycle(state, { available: source.energyCapacity, wasted: source.energy });
}

function remoteSource(key: string, roomName: string, x: number, y: number): Source | null {
    const room = Game.rooms[roomName];
    if (!room) return null;
    const id = remoteIds.get(key);
    const cached = id && Game.getObjectById(id);
    if (cached) return cached;
    const source = room.lookForAt(LOOK_SOURCES, x, y)[0];
    if (source) remoteIds.set(key, source.id);
    return source ?? null;
}

export const miningStatsModule = (): void => {
    for (const name in Game.rooms) {
        const room = Game.rooms[name];
        if (!room.controller?.my) continue;
        for (const source of room.find(FIND_SOURCES)) observe(source, false, name);
    }
    for (const source of Object.values(Memory.remoteMining?.sources ?? {})) {
        const found = remoteSource(source.key, source.room, source.x, source.y);
        if (found) observe(found, true, source.homeRoom);
    }
    // Sources not seen for a while (remote dropped, room lost): their old cycles no longer count
    if (Game.time % 100 === 0) {
        for (const [id, state] of states) if (Game.time - state.lastSeen > STALE_TICKS) states.delete(id);
    }
};

/** Share harvested (0..1) over the kept cycles, undefined without any finished cycle */
function efficiency(cycles: Cycle[]): number | undefined {
    const available = cycles.reduce((sum, c) => sum + c.available, 0);
    if (available === 0) return undefined;
    return 1 - cycles.reduce((sum, c) => sum + c.wasted, 0) / available;
}

export interface MiningEfficiency {
    total?: number;
    local?: number;
    remote?: number;
    /** By remote room */
    rooms: { [room: string]: number };
    /** Local sources by id */
    sources: { id: Id<Source>; efficiency: number }[];
}

/** Mining efficiency of a home room: its own sources and the remotes it mines */
export function miningEfficiency(home: string): MiningEfficiency {
    const all: Cycle[] = [];
    const local: Cycle[] = [];
    const remote: Cycle[] = [];
    const byRoom: { [room: string]: Cycle[] } = {};
    const sources: MiningEfficiency["sources"] = [];
    for (const [id, state] of states) {
        if (state.home !== home) continue;
        all.push(...state.cycles);
        if (state.remote) {
            remote.push(...state.cycles);
            (byRoom[state.room] ??= []).push(...state.cycles);
        } else {
            local.push(...state.cycles);
            const value = efficiency(state.cycles);
            if (value !== undefined) sources.push({ id, efficiency: value });
        }
    }
    const rooms: { [room: string]: number } = {};
    for (const room in byRoom) {
        const value = efficiency(byRoom[room]);
        if (value !== undefined) rooms[room] = value;
    }
    return { total: efficiency(all), local: efficiency(local), remote: efficiency(remote), rooms, sources };
}
