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

/** Record end-of-tick stats. Call last in the loop. */
export function recordTickStats(): void {
    const stats = getStats();
    if (lastRecordedTick === undefined) countStat("globalReset");
    lastRecordedTick = Game.time;
    const cpu = Game.cpu.getUsed();
    stats.tick = Game.time;
    stats.cpu = cpu;
    stats.cpuAvg = stats.cpuAvg ? stats.cpuAvg * 0.98 + cpu * 0.02 : cpu;
    stats.cpuMax = Math.max(stats.cpuMax ?? 0, cpu);
    stats.bucket = Game.cpu.bucket;

    if (Game.time % 10 !== 0) return;

    const creepsByRoom: { [room: string]: number } = {};
    for (const name in Game.creeps) {
        const home = Game.creeps[name].memory.room ?? Game.creeps[name].room.name;
        creepsByRoom[home] = (creepsByRoom[home] ?? 0) + 1;
    }

    stats.rooms = {};
    for (const roomName in Game.rooms) {
        const room = Game.rooms[roomName];
        if (!room.controller?.my) continue;
        const queue = room.memory.taskQueue ?? [];
        stats.rooms[roomName] = {
            rcl: room.controller.level,
            progress: room.controller.progress,
            phase: room.memory.phase ?? 0,
            energyAvailable: room.energyAvailable,
            energyCapacity: room.energyCapacityAvailable,
            creeps: creepsByRoom[roomName] ?? 0,
            idleCreeps: room.find(FIND_MY_CREEPS, { filter: c => !c.spawning && !c.memory.currentTask }).length,
            pendingTasks: queue.filter(t => t.status === "pending").length,
            structures: room.find(FIND_MY_STRUCTURES).length,
            constructionSites: room.find(FIND_MY_CONSTRUCTION_SITES).length
        };
    }
}
