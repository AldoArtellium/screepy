/**
 * Lightweight bot stats in Memory.stats, read by the local test harness (scripts/pserver-test.mjs)
 */

function getStats(): BotStats {
    if (!Memory.stats) {
        Memory.stats = { tick: 0, cpu: 0, cpuAvg: 0, cpuMax: 0, bucket: 0, counters: {}, rooms: {} };
    }
    return Memory.stats;
}

/** Increment a named counter (e.g. "taskFailed") */
export function countStat(name: string, amount = 1): void {
    const counters = getStats().counters;
    counters[name] = (counters[name] ?? 0) + amount;
}

/** Keep the last 20 samples of a diagnostic (e.g. failed moves) in Memory.stats.samples */
export function recordSample(name: string, sample: string): void {
    const stats = getStats();
    if (!stats.samples) stats.samples = {};
    const list = (stats.samples[name] ??= []);
    list.push(`${Game.time} ${sample}`);
    if (list.length > 20) list.shift();
}

/** Last tick recorded by this global (undefined right after a global reset) */
let lastRecordedTick: number | undefined;

/** Record end-of-tick stats. Call last in the loop. `parseCpu`: Memory parse of this global (MemHack) */
export function recordTickStats(parseCpu?: number): void {
    const stats = getStats();
    if (lastRecordedTick === undefined) {
        countStat("globalReset");
        if (parseCpu !== undefined && parseCpu >= 0) stats.memoryParse = Math.round(parseCpu * 1000) / 1000;
    }
    lastRecordedTick = Game.time;
    const cpu = Game.cpu.getUsed();
    stats.tick = Game.time;
    stats.cpu = cpu;
    stats.cpuAvg = stats.cpuAvg ? stats.cpuAvg * 0.98 + cpu * 0.02 : cpu;
    stats.cpuMax = Math.max(stats.cpuMax ?? 0, cpu);
    stats.bucket = Game.cpu.bucket;

    if (Game.time % 10 !== 0) return;

    // Heap of the isolate (official server and isolated-vm private servers; absent in the simulator)
    const heap = Game.cpu.getHeapStatistics?.();
    if (heap) {
        const used = heap.used_heap_size + heap.externally_allocated_size;
        const limit = heap.heap_size_limit;
        stats.heap = { used, limit, ratio: Math.round((used / limit) * 1000) / 1000 };
    }

    const creepsByRoom: { [room: string]: number } = {};
    for (const name in Game.creeps) {
        const home = Game.creeps[name].memory.room ?? Game.creeps[name].room.name;
        creepsByRoom[home] = (creepsByRoom[home] ?? 0) + 1;
    }

    stats.rooms = {};
    for (const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if (!room.controller?.my) continue;
        const roles: { [role: string]: number } = {};
        for (const creep of room.find(FIND_MY_CREEPS)) {
            const role = creep.memory.role ?? "none";
            roles[role] = (roles[role] ?? 0) + 1;
        }
        stats.rooms[roomName] = {
            rcl: room.controller.level,
            progress: room.controller.progress,
            energyAvailable: room.energyAvailable,
            energyCapacity: room.energyCapacityAvailable,
            creeps: creepsByRoom[roomName] ?? 0,
            roles,
            structures: room.find(FIND_MY_STRUCTURES).length,
            constructionSites: room.find(FIND_MY_CONSTRUCTION_SITES).length
        };
    }
}
