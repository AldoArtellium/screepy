#!/usr/bin/env node
/**
 * Local private-server test harness.
 *
 * Builds the bot, deploys it to the local docker server (docker compose up -d),
 * respawns a test user in a fresh room, runs N ticks and checks health metrics
 * written by the bot in Memory.stats / Memory.moduleErrors / Memory.moduleState.
 *
 * Usage: npm run test:server -- [--ticks 3000] [--room W5N5] [--tick-ms 1]
 *                                [--min-rcl 2] [--max-cpu 20] [--no-build]
 *                                [--code path/to/main.js]   (upload another bundle, e.g. a baseline)
 *                                [--preset rcl4]            (start from a fast-forwarded room)
 *                                [--memory '<json>']        (initial Memory, e.g. feature switches)
 *                                [--list-rooms]             (list candidate rooms and exit)
 *
 * Exit code 0 when every check passes, 1 otherwise.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = "http://localhost:21025";
const USER = { username: "screepy", email: "screepy@localhost", password: "screepy" };

// ---------- args ----------
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? def : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);

const TICKS = Number(opt("ticks", 3000));
/** Minimum tick duration; 1 = as fast as the engine can go (~50 ms/tick with 2 processors) */
const TICK_MS = Number(opt("tick-ms", 1));
const MIN_RCL = Number(opt("min-rcl", opt("preset") === "rcl4" ? 4 : TICKS >= 2000 ? 2 : 1));
const MAX_CPU = Number(opt("max-cpu", 20));
const MIN_CREEPS = Number(opt("min-creeps", 3));
const MAX_FAIL_RATIO = Number(opt("max-fail-ratio", 0.1));
const ROOM = opt("room", null);
/** Initial Memory (JSON), e.g. --memory '{"config":{"staticMiners":false}}' for A/B tests */
const MEMORY_INIT = opt("memory", "{}");
JSON.parse(MEMORY_INIT); // fail fast on invalid JSON
/** Bundle to upload (e.g. a baseline build of another commit) */
const CODE = opt("code", join(ROOT, "dist", "main.js"));
const BUILD = !flag("no-build") && !args.includes("--code");
/** Start from a fast-forwarded room (see PRESETS), e.g. --preset rcl4 */
const PRESET = opt("preset", null);

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

/** Run a command in the server CLI (only reachable from inside the container) */
function cli(command) {
  const snippet =
    "const h=require('http');const q=h.request({host:'127.0.0.1',port:21026,path:'/cli',method:'POST'," +
    "headers:{'Content-Type':'text/plain'}},r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>process.stdout.write(b))});" +
    "q.end(process.argv[1]);";
  return execFileSync(
    "docker",
    ["compose", "exec", "-T", "screeps", "/screeps/deps/node/bin/node", "-e", snippet, command],
    { cwd: ROOT, encoding: "utf-8", env: { ...process.env, MSYS_NO_PATHCONV: "1" }, maxBuffer: 64 * 1024 * 1024 }
  ).trim();
}

let token = null;
async function api(path, body, attempt = 1) {
  let res;
  try {
    res = await fetch(`${SERVER}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        ...(token && { "X-Token": token, "X-Username": token })
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (err) {
    // The backend sometimes resets connections under load (e.g. right after bulk DB writes)
    if (attempt >= 5) throw err;
    await sleep(2000 * attempt);
    return api(path, body, attempt + 1);
  }
  const newToken = res.headers.get("x-token");
  if (newToken) token = newToken;
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

async function readMemory(path) {
  const res = await api(`/api/user/memory?path=${encodeURIComponent(path)}&shard=test1`);
  if (!res.data) return undefined;
  const raw = res.data.startsWith("gz:") ? gunzipSync(Buffer.from(res.data.slice(3), "base64")).toString() : res.data;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// ---------- steps ----------
async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const v = await api("/api/version");
      if (v.ok) return;
    } catch {
      // not up yet
    }
    await sleep(5000);
  }
  throw new Error("Server not reachable on :21025. Did you run `docker compose up -d`?");
}

async function login() {
  const reg = await api("/api/register/submit", USER);
  if (reg.ok) log(`Registered user ${USER.username}`);
  const res = await api("/api/auth/signin", { email: USER.username, password: USER.password });
  if (!res.token) throw new Error(`Sign-in failed: ${JSON.stringify(res)}`);
  token = res.token;
  const me = await api("/api/auth/me");
  return me._id;
}

function build() {
  log("Building bot (rollup)...");
  execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["rollup", "-c"], {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32"
  });
}

async function upload() {
  const main = readFileSync(CODE, "utf-8");
  const res = await api("/api/user/code", { branch: "default", modules: { main } });
  if (!res.ok) throw new Error(`Code upload failed: ${JSON.stringify(res)}`);
  await api("/api/user/set-active-branch", { branch: "default", activeName: "activeWorld" });
  log(`Uploaded ${CODE} (${(main.length / 1024).toFixed(0)} KB)`);
}

/** Pick a free room with 2 sources and a good spawn spot */
function pickRoom() {
  const objects = JSON.parse(
    cli(
      "storage.db['rooms.objects'].find({type:{$in:['controller','source','keeperLair']}})" +
        ".then(r=>JSON.stringify(r.map(o=>[o.room,o.type,o.x,o.y,o.user||null])))"
    )
  );
  const rooms = JSON.parse(
    cli("storage.db.rooms.find({}).then(r=>JSON.stringify(r.map(o=>[o._id,o.status,o.openTime||null])))")
  );
  const open = new Set(rooms.filter(([, status, openTime]) => status === "normal" && !openTime).map((r) => r[0]));

  const byRoom = {};
  for (const [room, type, x, y, user] of objects) {
    byRoom[room] ??= { sources: [], controller: null, keeper: false, owned: false };
    if (type === "source") byRoom[room].sources.push({ x, y });
    if (type === "keeperLair") byRoom[room].keeper = true;
    if (type === "controller") {
      byRoom[room].controller = { x, y };
      if (user) byRoom[room].owned = true;
    }
  }

  const candidates = Object.entries(byRoom)
    .filter(([name, r]) =>
      ROOM ? name === ROOM : open.has(name) && r.sources.length === 2 && r.controller && !r.keeper && !r.owned
    )
    .map(([name]) => name);
  if (candidates.length === 0) throw new Error(ROOM ? `Room ${ROOM} not found` : "No free 2-source room found");

  // Deterministic choice: first candidate by name
  candidates.sort();
  if (flag("list-rooms")) {
    console.log("Room     spawn   avg range to sources / controller");
    for (const name of candidates) {
      const spot = findSpawnSpot(name, byRoom[name]);
      if (!spot) continue;
      const range = (p) => Math.max(Math.abs(p.x - spot.x), Math.abs(p.y - spot.y));
      const avgSource = byRoom[name].sources.reduce((sum, p) => sum + range(p), 0) / byRoom[name].sources.length;
      console.log(
        `${name.padEnd(8)} ${String(spot.x).padStart(2)},${String(spot.y).padStart(2)}   ${avgSource.toFixed(1)} / ${range(byRoom[name].controller)}`
      );
    }
    process.exit(0);
  }
  for (const name of candidates) {
    const spot = findSpawnSpot(name, byRoom[name]);
    if (spot) return { room: name, ...spot };
  }
  throw new Error("No spawn spot found");
}

function findSpawnSpot(room, info) {
  const terrain = JSON.parse(
    cli(`storage.db['rooms.terrain'].findOne({room:'${room}'}).then(t=>JSON.stringify(t.terrain))`)
  );
  const wall = (x, y) => (Number(terrain[y * 50 + x]) & 1) === 1;
  const points = [...info.sources, info.controller];

  let best = null;
  for (let x = 8; x <= 41; x++) {
    for (let y = 8; y <= 41; y++) {
      let ok = true;
      for (let dx = -3; dx <= 3 && ok; dx++)
        for (let dy = -3; dy <= 3 && ok; dy++) if (wall(x + dx, y + dy)) ok = false;
      if (!ok) continue;
      if (points.some((p) => Math.max(Math.abs(p.x - x), Math.abs(p.y - y)) < 5)) continue;
      const score = points.reduce((s, p) => s + Math.max(Math.abs(p.x - x), Math.abs(p.y - y)), 0);
      if (!best || score < best.score) best = { x, y, score };
    }
  }
  return best && { x: best.x, y: best.y };
}

async function respawn(userId) {
  // Respawn the user (removes rooms/creeps) and wipe its Memory for a clean run
  cli(`utils.respawnUser('${USER.username}')`);
  cli(`storage.env.set('memory:${userId}', ${JSON.stringify(MEMORY_INIT)})`);
  await sleep(1000);
}

/** Leftovers of previous runs (respawn keeps them): remove so every run starts from the same state */
const LEFTOVER_TYPES = ["ruin", "road", "container", "constructionSite", "energy", "tombstone", "wall", "rampart"];

function cleanRoom(room) {
  const removed = cli(
    `storage.db['rooms.objects'].removeWhere({room:'${room}',type:{$in:${JSON.stringify(LEFTOVER_TYPES)}}})` +
      ".then(r=>String(r.n ?? (r.result && r.result.n)))"
  );
  log(`Cleaned ${room}: ${removed} leftover objects removed`);
}

async function placeSpawn(spot) {
  const res = await api("/api/game/place-spawn", {
    room: spot.room,
    x: spot.x,
    y: spot.y,
    name: "Spawn1",
    shard: "test1"
  });
  if (!res.ok) throw new Error(`place-spawn failed: ${JSON.stringify(res)}`);
  log(`Spawn placed in ${spot.room} at ${spot.x},${spot.y}`);
}

/**
 * Fast-forward a fresh room by writing objects straight into the server DB (test setup only).
 * Lets late-game modules (remote mining, labs...) be tested without playing 50k+ ticks.
 */
const PRESETS = {
  rcl4: { rcl: 4, extensions: 20, storageEnergy: 50000, containers: true }
};

async function applyPreset(name, spot, userId) {
  const preset = PRESETS[name];
  if (!preset) throw new Error(`Unknown preset ${name} (available: ${Object.keys(PRESETS).join(", ")})`);

  const room = spot.room;
  const time = await gameTime();
  const terrain = JSON.parse(
    cli(`storage.db['rooms.terrain'].findOne({room:'${room}'}).then(t=>JSON.stringify(t.terrain))`)
  );
  const objects = JSON.parse(
    cli(`storage.db['rooms.objects'].find({room:'${room}'}).then(r=>JSON.stringify(r.map(o=>[o.type,o.x,o.y])))`)
  );
  const taken = new Set(objects.map(([, x, y]) => y * 50 + x));
  const free = (x, y) =>
    x > 1 && x < 48 && y > 1 && y < 48 && (Number(terrain[y * 50 + x]) & 1) === 0 && !taken.has(y * 50 + x);
  const insert = (doc) => {
    taken.add(doc.y * 50 + doc.x);
    cli(
      `storage.db['rooms.objects'].insert(${JSON.stringify({ room, user: userId, notifyWhenAttacked: true, ...doc })})`
    );
  };

  // Controller level (downgrade timer reset)
  cli(
    `storage.db['rooms.objects'].update({room:'${room}',type:'controller'},` +
      `{$set:{level:${preset.rcl},progress:0,downgradeTime:${time + 20000}}})`
  );

  // Base structures on a checkerboard spiral around the spawn (keeps walking lanes)
  const spots = [];
  for (let r = 2; r <= 8; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = spot.x + dx;
        const y = spot.y + dy;
        if ((x + y) % 2 === (spot.x + spot.y) % 2 && free(x, y)) spots.push({ x, y });
      }
    }
  }

  if (preset.storageEnergy) {
    const s = spots.shift();
    insert({
      type: "storage",
      x: s.x,
      y: s.y,
      hits: 10000,
      hitsMax: 10000,
      store: { energy: preset.storageEnergy },
      storeCapacity: 1000000
    });
  }
  for (let i = 0; i < preset.extensions; i++) {
    const s = spots.shift();
    if (!s) break;
    const capacity = preset.rcl >= 8 ? 200 : preset.rcl === 7 ? 100 : 50;
    insert({
      type: "extension",
      x: s.x,
      y: s.y,
      hits: 1000,
      hitsMax: 1000,
      off: false,
      store: { energy: capacity },
      storeCapacityResource: { energy: capacity }
    });
  }

  // Source containers on the free tile next to each source closest to the spawn
  if (preset.containers) {
    for (const [type, sx, sy] of objects) {
      if (type !== "source") continue;
      let best = null;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const x = sx + dx;
          const y = sy + dy;
          if ((dx || dy) && free(x, y)) {
            const d = Math.max(Math.abs(x - spot.x), Math.abs(y - spot.y));
            if (!best || d < best.d) best = { x, y, d };
          }
        }
      }
      if (best) {
        insert({
          type: "container",
          x: best.x,
          y: best.y,
          hits: 250000,
          hitsMax: 250000,
          store: {},
          storeCapacity: 2000,
          nextDecayTime: time + 500
        });
      }
    }
  }

  log(
    `Preset ${name}: RCL ${preset.rcl}, ${preset.extensions} extensions, storage ${preset.storageEnergy}, containers`
  );
}

/** RCL threshold sums, to express controller progress as a single number */
const RCL_POINTS = [0, 0, 200, 45200, 180200, 585200, 1800200, 5445200, 16380200];

/** Ground truth from the server (independent of the bot's own Memory) */
async function roomSnapshot(room, userId) {
  const { objects } = await api(`/api/game/room-objects?shard=test1&room=${room}`);
  const mine = objects.filter((o) => o.user === userId);
  const controller = objects.find((o) => o.type === "controller");
  const energyStructures = mine.filter((o) => o.type === "spawn" || o.type === "extension");
  const rcl = controller?.user === userId ? controller.level : 0;
  const progress = controller?.progress ?? 0;
  return {
    rcl,
    progress,
    points: (RCL_POINTS[rcl] ?? 0) + progress,
    creeps: mine.filter((o) => o.type === "creep").length,
    energy: energyStructures.reduce((sum, o) => sum + (o.store?.energy ?? 0), 0),
    energyCapacity: energyStructures.reduce((sum, o) => sum + (o.storeCapacityResource?.energy ?? 0), 0),
    extensions: mine.filter((o) => o.type === "extension").length,
    containers: objects.filter((o) => o.type === "container").length,
    sites: objects.filter((o) => o.type === "constructionSite" && o.user === userId).length
  };
}

async function gameTime() {
  const res = await api("/api/game/time?shard=test1");
  return res.time;
}

// ---------- main ----------
async function main() {
  await waitForServer();
  if (flag("list-rooms")) pickRoom(); // prints and exits, touches nothing
  if (BUILD) build();

  // Fresh mongo database: import the default world map (also wipes users)
  if (cli("storage.db.rooms.count({})") === "0") {
    log("Empty world, importing default map (system.resetAllData)...");
    cli("system.resetAllData()");
  }

  cli("system.resumeSimulation()");
  cli(`system.setTickDuration(${TICK_MS})`);

  const userId = await login();
  await respawn(userId);
  await upload();
  const spot = pickRoom();
  cleanRoom(spot.room);
  await placeSpawn(spot);
  if (PRESET) await applyPreset(PRESET, spot, userId);

  const start = await gameTime();
  const end = start + TICKS;
  log(`Running ${TICKS} ticks (${start} -> ${end}), min tick duration ${TICK_MS}ms`);

  let stats;
  let world;
  for (;;) {
    await sleep(5000);
    const now = await gameTime();
    world = await roomSnapshot(spot.room, userId);
    stats = await readMemory("stats");
    const errors = (await readMemory("moduleErrors")) ?? [];
    log(
      `tick ${now - start}/${TICKS}`,
      `RCL ${world.rcl} (${world.progress}) | creeps ${world.creeps} | energy ${world.energy}/${world.energyCapacity}`,
      `| ext ${world.extensions} cont ${world.containers} sites ${world.sites}`,
      stats ? `| cpu avg ${stats.cpuAvg.toFixed(1)}` : "",
      errors.length ? `| ${errors.length} module errors` : ""
    );
    if (now >= end) break;
  }

  // ---------- report ----------
  const errors = (await readMemory("moduleErrors")) ?? [];
  const moduleState = (await readMemory("moduleState")) ?? {};
  const counters = stats?.counters ?? {};
  const completed = counters.taskCompleted ?? 0;
  const failed = counters.taskFailed ?? 0;
  const failRatio = completed + failed > 0 ? failed / (completed + failed) : 0;

  const checks = [
    ["No module errors", errors.length === 0, `${errors.length} errors`],
    [
      `RCL >= ${MIN_RCL}`,
      world.rcl >= MIN_RCL,
      `RCL ${world.rcl}, progress ${world.progress}, total points ${world.points}`
    ],
    [`Creeps >= ${MIN_CREEPS}`, world.creeps >= MIN_CREEPS, `${world.creeps} creeps`],
    [
      `Avg CPU <= ${MAX_CPU}`,
      (stats?.cpuAvg ?? 0) <= MAX_CPU,
      stats ? `${stats.cpuAvg.toFixed(2)} (max ${stats.cpuMax.toFixed(1)})` : "n/a (no Memory.stats)"
    ],
    [
      `Task failure ratio <= ${MAX_FAIL_RATIO * 100}%`,
      // Too few tasks for a ratio to mean anything
      failRatio <= MAX_FAIL_RATIO || completed + failed < 20,
      `${failed} failed / ${completed} completed (${(failRatio * 100).toFixed(1)}%)`
    ]
  ];

  console.log("\n================ REPORT ================");
  console.log(`Room ${spot.room}, ${TICKS} ticks`);
  for (const [name, ok, detail] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(32)} ${detail}`);

  const failures = Object.entries(counters).filter(([k]) => k.startsWith("taskFailed:"));
  if (failures.length) {
    console.log("\nFailed tasks by type:");
    for (const [k, v] of failures.sort((a, b) => b[1] - a[1])) console.log(`  ${k.slice(11).padEnd(24)} ${v}`);
  }

  const cpuByModule = Object.entries(moduleState)
    .filter(([, s]) => s.avgCpu !== undefined)
    .sort((a, b) => b[1].avgCpu - a[1].avgCpu)
    .slice(0, 8);
  if (cpuByModule.length) {
    console.log("\nCPU per run (avg), top modules:");
    for (const [name, s] of cpuByModule) console.log(`  ${name.padEnd(24)} ${s.avgCpu.toFixed(2)}`);
  }

  if (errors.length) {
    console.log("\nModule errors (latest):");
    for (const e of errors.slice(-5))
      console.log(`  [${e.tick}] ${e.module}: ${e.message.split("\n").slice(0, 3).join(" | ")}`);
  }

  const otherCounters = Object.entries(counters).filter(([k]) => !k.startsWith("task"));
  if (otherCounters.length) console.log("\nOther counters:", Object.fromEntries(otherCounters));

  const report = {
    date: new Date().toISOString(),
    code: CODE,
    room: spot.room,
    ticks: TICKS,
    world,
    checks,
    stats,
    errors,
    moduleState
  };
  mkdirSync(join(ROOT, "test-results"), { recursive: true });
  const file = join(ROOT, "test-results", `pserver-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`\nFull report: ${file}`);

  process.exit(checks.every((c) => c[1]) ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
