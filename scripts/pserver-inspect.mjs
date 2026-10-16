#!/usr/bin/env node
/**
 * Snapshot of the test user's state on the local server (run while/after scripts/pserver-test.mjs).
 * Prints creeps (position, store, current task), task queue, stats and module errors.
 *
 * Usage: npm run inspect:server [-- --room W1N3] [--memory some.path]
 */

import { gunzipSync } from "node:zlib";

const SERVER = "http://localhost:21025";
const args = process.argv.slice(2);
const opt = name => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : args[i + 1];
};

const signin = await (
    await fetch(`${SERVER}/api/auth/signin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "screepy", password: "screepy" })
    })
).json();
const token = signin.token;
if (!token) throw new Error(`Sign-in failed: ${JSON.stringify(signin)}`);

const get = async path => (await fetch(`${SERVER}${path}`, { headers: { "X-Token": token, "X-Username": token } })).json();
const memory = async path => {
    const res = await get(`/api/user/memory?shard=test1&path=${encodeURIComponent(path)}`);
    if (!res.data) return undefined;
    const raw = res.data.startsWith("gz:") ? gunzipSync(Buffer.from(res.data.slice(3), "base64")).toString() : res.data;
    return JSON.parse(raw);
};

// Raw memory path dump
if (opt("memory")) {
    console.log(JSON.stringify(await memory(opt("memory")), null, 2));
    process.exit(0);
}

const stats = await memory("stats");
const room = opt("room") ?? Object.keys(stats?.rooms ?? {})[0];
if (!room) throw new Error("No owned room found in Memory.stats");

const { time } = await get("/api/game/time?shard=test1");
console.log(`Tick ${time} - room ${room}`);
console.log("Stats:", JSON.stringify(stats.rooms[room]));
console.log("CPU:", `avg ${stats.cpuAvg.toFixed(2)} max ${stats.cpuMax.toFixed(1)} bucket ${stats.bucket}`);
console.log("Counters:", JSON.stringify(stats.counters));

const creepMemory = (await memory("creeps")) ?? {};
const { objects } = await get(`/api/game/room-objects?shard=test1&room=${room}`);

console.log("\nStructures:");
for (const o of objects.filter(o => ["spawn", "source", "controller", "container", "extension"].includes(o.type))) {
    const extra = o.type === "source" ? `energy ${o.energy}` : o.type === "controller" ? `level ${o.level} progress ${o.progress}` : JSON.stringify(o.store ?? {});
    console.log(`  ${o.type.padEnd(11)} ${String(o.x).padStart(2)},${String(o.y).padStart(2)}  ${extra}`);
}

console.log("\nCreeps:");
for (const c of objects.filter(o => o.type === "creep")) {
    const task = creepMemory[c.name]?.currentTask;
    const body = c.body.map(b => b.type[0].toUpperCase()).join("");
    const taskInfo = task ? `${task.type} [${task.state}] since ${time - task.startedAt}t stuck ${task.stuckTicks ?? 0}` : "IDLE";
    console.log(`  ${c.name.padEnd(28)} ${String(c.x).padStart(2)},${String(c.y).padStart(2)} ${body.padEnd(8)} store ${JSON.stringify(c.store)} -> ${taskInfo}`);
}

const queue = (await memory(`rooms.${room}.taskQueue`)) ?? [];
console.log(`\nTask queue (${queue.length}):`);
for (const t of queue) console.log(`  ${t.type.padEnd(22)} prio ${String(t.priority).padStart(3)} ${t.status.padEnd(11)} ${t.assignedTo ?? ""}`);

const errors = (await memory("moduleErrors")) ?? [];
if (errors.length) {
    console.log(`\nModule errors (${errors.length}):`);
    for (const e of errors.slice(-5)) console.log(`  [${e.tick}] ${e.module}: ${e.message.split("\n")[0]}`);
}
