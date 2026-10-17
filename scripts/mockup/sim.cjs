/**
 * In-process Screeps simulation (screeps-server-mockup), run INSIDE the screepy-mockup container
 * by run.mjs. Not meant to be started by hand on the host.
 *
 * Args: --code <bundle> --room <name> --ticks <n> --memory <json> --out <report.json> [--verbose]
 *       [--log-every <ticks>]
 */
/* eslint-disable no-console */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const util = require("util");
// Storage server and driver must agree on the host (Node 17+ resolves "localhost" to ::1 first)
process.env.STORAGE_HOST = process.env.STORAGE_HOST || "127.0.0.1";
const { ScreepsServer } = require("screeps-server-mockup");

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? def : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);

const CODE = opt("code");
const ROOM = opt("room", "W7N3");
const TICKS = Number(opt("ticks", 3000));
const MEMORY_INIT = opt("memory", "{}");
const OUT = opt("out");
const VERBOSE = flag("verbose");
const LOG_EVERY = Number(opt("log-every", 500));
const PROFILE = flag("profile");
// Speed-ups that do not change the simulation (fast.cjs preload + main loop below); --no-fast: as upstream
const FAST = !flag("no-fast");
// Engine processor processes (rooms of a tick are processed in parallel)
const PROCESSORS = Number(opt("processors", FAST ? 2 : 1));
// Same checks and defaults as pserver-test.mjs
const MIN_RCL = Number(opt("min-rcl", TICKS >= 2000 ? 2 : 1));
const MAX_CPU = Number(opt("max-cpu", 20));
const MIN_CREEPS = Number(opt("min-creeps", 3));
const MAX_FAIL_RATIO = Number(opt("max-fail-ratio", 0.1));
const USERNAME = "screepy";

/** RCL threshold sums, to express controller progress as a single number (same as pserver-test.mjs) */
const RCL_POINTS = [0, 0, 200, 45200, 180200, 585200, 1800200, 5445200, 16380200];

const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

/** Same spawn spot as pserver-test.mjs findSpawnSpot (7x7 plain area, >= 5 from sources/controller) */
function findSpawnSpot(terrain, objects) {
  const wall = (x, y) => (Number(terrain[y * 50 + x]) & 1) === 1;
  const points = objects.filter((o) => o.type === "source" || o.type === "controller");
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

async function setupWorld(server, fixture) {
  const { db, env } = server.common.storage;
  await server.world.reset();
  for (const [name, r] of Object.entries(fixture.rooms)) {
    await db.rooms.insert({
      _id: name,
      status: r.status,
      active: name === ROOM,
      sourceKeepers: r.sourceKeepers,
      ...(r.invaderGoal && { invaderGoal: r.invaderGoal })
    });
    await db["rooms.terrain"].insert({ room: name, type: "terrain", terrain: r.terrain });
    for (const o of r.objects) {
      const doc = { room: name, ...o };
      if (o.type === "source") doc.ticksToRegeneration = 300;
      await db["rooms.objects"].insert(doc);
    }
  }
  // Rooms around the fixture block: fully walled so exits don't lead into undefined rooms
  const terrain = await db["rooms.terrain"].find();
  const known = new Set(terrain.map((t) => t.room));
  const walled = "1".repeat(2500);
  for (const name of Object.keys(fixture.rooms)) {
    const m = /^([WE])(\d+)([NS])(\d+)$/.exec(name);
    const wx = m[1] === "E" ? +m[2] : -m[2] - 1;
    const wy = m[3] === "S" ? +m[4] : -m[4] - 1;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = wx + dx;
      const ny = wy + dy;
      const n = `${nx >= 0 ? "E" + nx : "W" + (-nx - 1)}${ny >= 0 ? "S" + ny : "N" + (-ny - 1)}`;
      if (!known.has(n)) {
        known.add(n);
        terrain.push({ room: n, terrain: walled });
      }
    }
  }
  const compressed = await util.promisify(zlib.deflate)(JSON.stringify(terrain));
  await env.set(env.keys.TERRAIN_DATA, compressed.toString("base64"));
  await server.driver.updateAccessibleRoomsList();
}

/** Stage times of the main loop (--profile) */
const stageMs = {};
let lastStage;
function stage(name) {
  if (!PROFILE) return;
  const now = performance.now();
  if (lastStage) stageMs[lastStage.name] = (stageMs[lastStage.name] || 0) + now - lastStage.t;
  lastStage = name && { name, t: now };
}

/** One tick: same stages as screeps-server-mockup ScreepsServer.tick (engine main.js loop) */
async function runTick(server) {
  const { driver } = server;
  // tickStarted / roomsDone notifications (and the pause flag) only serve the backend, absent here
  stage("notifyTickStarted");
  if (!FAST) await driver.notifyTickStarted();
  stage("getAllUsers");
  const users = await driver.getAllUsers();
  stage("users (runner)");
  await server.usersQueue.addMulti(users.map((u) => u._id.toString()));
  await server.usersQueue.whenAllDone();
  stage("getAllRoomsNames");
  const rooms = (await driver.getAllRoomsNames()) || [];
  stage("rooms (processor)");
  await server.roomsQueue.addMulti(rooms);
  await server.roomsQueue.whenAllDone();
  stage("commit1");
  await driver.commitDbBulk();
  stage("global processor");
  await require("@screeps/engine/src/processor/global")();
  stage("commit2+gameTime");
  await driver.commitDbBulk();
  const gameTime = await driver.incrementGameTime();
  stage("accessibleRooms+status");
  // The engine main loop refreshes these every 20 ticks (mockup upstream: every tick); the room
  // statuses of a mockup world never change
  if (!FAST || gameTime > lastAccessibleRoomsUpdate + 20) {
    await driver.updateAccessibleRoomsList();
    await driver.updateRoomStatusData();
    lastAccessibleRoomsUpdate = gameTime;
  }
  stage("notifyRoomsDone+custom");
  if (!FAST) await driver.notifyRoomsDone(gameTime);
  await driver.config.mainLoopCustomStage();
  stage(null);
  if (PROFILE) roomCounts.push(rooms.length);
}
const roomCounts = [];
let lastAccessibleRoomsUpdate = 0;

/** CPU time (user+sys, ms) of this process and its children, from /proc */
function processCpu(server) {
  const out = { main: (process.cpuUsage().user + process.cpuUsage().system) / 1000 };
  const tck = 100; // USER_HZ
  for (const [name, p] of Object.entries(server.processes)) {
    try {
      const f = fs.readFileSync(`/proc/${p.pid}/stat`, "utf-8").split(") ")[1].split(" ");
      out[name] = ((+f[11] + +f[12]) * 1000) / tck;
    } catch {
      out[name] = null;
    }
  }
  return out;
}

async function snapshot(server, userId) {
  const { db } = server.common.storage;
  const objects = await db["rooms.objects"].find({ room: ROOM });
  const mine = objects.filter((o) => o.user === userId);
  const controller = objects.find((o) => o.type === "controller");
  const energyStructures = mine.filter((o) => o.type === "spawn" || o.type === "extension");
  const rcl = controller && controller.user === userId ? controller.level : 0;
  const progress = (controller && controller.progress) || 0;
  return {
    rcl,
    progress,
    points: (RCL_POINTS[rcl] || 0) + progress,
    creeps: mine.filter((o) => o.type === "creep").length,
    energy: energyStructures.reduce((sum, o) => sum + ((o.store && o.store.energy) || 0), 0),
    energyCapacity: energyStructures.reduce(
      (sum, o) => sum + ((o.storeCapacityResource && o.storeCapacityResource.energy) || 0),
      0
    ),
    extensions: mine.filter((o) => o.type === "extension").length,
    containers: objects.filter((o) => o.type === "container").length,
    roads: objects.filter((o) => o.type === "road").length,
    sites: objects.filter((o) => o.type === "constructionSite" && o.user === userId).length,
    storage: mine.filter((o) => o.type === "storage").reduce((sum, o) => sum + ((o.store && o.store.energy) || 0), 0),
    remoteRoads: (await db["rooms.objects"].find({ type: "road" })).filter((o) => o.room !== ROOM).length,
    // Creeps in every room by name prefix (role), to compare bots
    creepsByRoom: await creepCensus(db, userId)
  };
}

async function creepCensus(db, userId) {
  const census = {};
  for (const creep of await db["rooms.objects"].find({ type: "creep", user: userId })) {
    const prefix = String(creep.name).split(/[-_\d]/)[0] || "?";
    const room = (census[creep.room] = census[creep.room] || {});
    room[prefix] = (room[prefix] || 0) + 1;
  }
  return census;
}

async function readMemory(user) {
  try {
    return JSON.parse(await user.memory);
  } catch {
    return {};
  }
}

async function main() {
  const fixtureFile = path.join(__dirname, "fixtures", `${ROOM}.json`);
  if (!fs.existsSync(fixtureFile)) {
    throw new Error(
      `No fixture for ${ROOM} (${fixtureFile}). Extract it from the private server: ` +
        `node scripts/mockup/extract-fixtures.mjs ${ROOM}`
    );
  }
  const fixture = JSON.parse(fs.readFileSync(fixtureFile, "utf-8"));
  const main = fs.readFileSync(CODE, "utf-8");

  const serverOpts = { path: "/tmp/mockup-server", logdir: "/tmp/mockup-server/logs" };
  if (FAST && process.platform !== "win32") {
    // Storage RPC over a Unix socket instead of TCP on localhost: STORAGE_PORT goes straight to
    // net.listen / net.connect, which take a socket path
    serverOpts.port = path.join(serverOpts.path, "storage.sock");
    fs.mkdirSync(serverOpts.path, { recursive: true });
    fs.rmSync(serverOpts.port, { force: true });
  }
  const server = new ScreepsServer(serverOpts);
  server.on("error", (e) => console.error("[server]", e));
  await setupWorld(server, fixture);

  const spot = findSpawnSpot(fixture.rooms[ROOM].terrain, fixture.rooms[ROOM].objects);
  if (!spot) throw new Error(`No spawn spot found in ${ROOM}`);
  const user = await server.world.addBot({ username: USERNAME, room: ROOM, x: spot.x, y: spot.y, modules: { main } });
  const { env, pubsub } = server.common.storage;
  await env.set(env.keys.MEMORY + user.id, MEMORY_INIT);
  log(`Bundle ${CODE} (${(main.length / 1024).toFixed(0)} KB), spawn in ${ROOM} at ${spot.x},${spot.y}`);

  // Console output and uncaught errors of the bot
  const consoleErrors = [];
  let errorCount = 0;
  let tick = 0;
  await pubsub.subscribe(`user:${user.id}/console`, (event) => {
    const { messages, error } = JSON.parse(event);
    const lines = (messages && messages.log) || [];
    if (VERBOSE) for (const l of lines) console.log(`  [${tick}] ${l}`);
    for (const l of lines.filter((l) => /error|exception|uncaught/i.test(String(l)))) {
      errorCount++;
      if (consoleErrors.length < 50) consoleErrors.push({ tick, message: String(l).slice(0, 2000) });
    }
    if (error) {
      errorCount++;
      if (consoleErrors.length < 50) consoleErrors.push({ tick, message: String(error).slice(0, 2000) });
      if (VERBOSE) console.log(`  [${tick}] ERROR ${error}`);
    }
  });

  // CPU used each tick: published by the runner (same value as users.lastUsedCpu), no extra query
  let cpuSum = 0;
  let cpuMax = 0;
  let cpuSamples = 0;
  const addCpu = (cpu) => {
    cpuSum += cpu;
    cpuMax = Math.max(cpuMax, cpu);
    cpuSamples++;
  };
  if (FAST)
    await pubsub.subscribe(`user:${user.id}/cpu`, (event) => {
      const { cpu } = JSON.parse(event);
      if (typeof cpu === "number") addCpu(cpu);
    });

  await server.start();
  const processorPath = path.join(path.dirname(require.resolve("@screeps/engine")), "processor.js");
  for (let i = 2; i <= PROCESSORS; i++) {
    server.startProcess(`engine_processor${i}`, processorPath, {
      DRIVER_MODULE: "@screeps/driver",
      MODFILE: path.resolve(server.opts.path, "db.json"),
      STORAGE_PORT: `${server.opts.port}`
    });
  }
  const startTime = await server.world.gameTime;
  const t0 = Date.now();
  const { db } = server.common.storage;
  for (tick = 1; tick <= TICKS; tick++) {
    await runTick(server);
    if (!FAST) {
      stage("sim: users.findOne");
      const u = await db.users.findOne({ _id: user.id });
      if (u && typeof u.lastUsedCpu === "number") addCpu(u.lastUsedCpu);
      stage(null);
    }
    if (tick % LOG_EVERY === 0 || tick === TICKS) {
      const w = await snapshot(server, user.id);
      const elapsed = (Date.now() - t0) / 1000;
      log(
        `tick ${tick}/${TICKS}`,
        `RCL ${w.rcl} (${w.progress}) | creeps ${w.creeps} | energy ${w.energy}/${w.energyCapacity}`,
        `| ext ${w.extensions} cont ${w.containers} roads ${w.roads}+${w.remoteRoads} sites ${w.sites} storage ${w.storage}`,
        `| cpu avg ${(cpuSum / Math.max(1, cpuSamples)).toFixed(2)}`,
        `| ${(tick / elapsed).toFixed(1)} ticks/s`,
        errorCount ? `| ${errorCount} console errors` : ""
      );
    }
  }
  const elapsedMs = Date.now() - t0;
  if (PROFILE) {
    console.log("\n---- profile (wall ms/tick per main loop stage) ----");
    for (const [k, v] of Object.entries(stageMs)) console.log(`${k.padEnd(28)} ${(v / TICKS).toFixed(2)}`);
    const rc = roomCounts.reduce((a, b) => a + b, 0) / roomCounts.length;
    console.log(`active rooms/tick           ${rc.toFixed(2)}`);
    console.log("---- process CPU (ms/tick, whole run incl. setup) ----");
    for (const [k, v] of Object.entries(processCpu(server))) console.log(`${k.padEnd(28)} ${v === null ? "n/a" : (v / TICKS).toFixed(2)}`);
  }

  const world = await snapshot(server, user.id);
  const memory = await readMemory(user);
  const stats = memory.stats;
  const moduleErrors = memory.moduleErrors || [];
  const moduleState = memory.moduleState || {};
  const counters = (stats && stats.counters) || {};
  const completed = counters.taskCompleted || 0;
  const failed = counters.taskFailed || 0;
  const cpuAvg = cpuSamples ? cpuSum / cpuSamples : null;

  console.log("\n================ MOCKUP REPORT ================");
  console.log(`Room ${ROOM} (spawn ${spot.x},${spot.y}), ${TICKS} ticks, bundle ${CODE}`);
  console.log(`RCL ${world.rcl}, progress ${world.progress}, total points ${world.points}`);
  console.log(`Creeps ${world.creeps} | ext ${world.extensions} | containers ${world.containers} | roads ${world.roads}`);
  console.log(
    `Avg CPU ${cpuAvg === null ? "n/a" : cpuAvg.toFixed(2)} (max ${cpuMax.toFixed(1)})` +
      (stats && stats.cpuAvg !== undefined ? ` | Memory.stats.cpuAvg ${stats.cpuAvg.toFixed(2)}` : "")
  );
  console.log(`Tasks ${completed} completed / ${failed} failed`);
  console.log(`Module errors ${moduleErrors.length} | console errors ${errorCount}`);
  console.log(
    `Speed ${(TICKS / (elapsedMs / 1000)).toFixed(1)} ticks/s (${(elapsedMs / TICKS).toFixed(1)} ms/tick, ${(elapsedMs / 1000).toFixed(0)} s)`
  );
  const failRatio = completed + failed > 0 ? failed / (completed + failed) : 0;
  const checks = [
    ["No module errors", moduleErrors.length === 0, `${moduleErrors.length} errors`],
    [`RCL >= ${MIN_RCL}`, world.rcl >= MIN_RCL, `RCL ${world.rcl}, progress ${world.progress}, total points ${world.points}`],
    [`Creeps >= ${MIN_CREEPS}`, world.creeps >= MIN_CREEPS, `${world.creeps} creeps`],
    [`Avg CPU <= ${MAX_CPU}`, (cpuAvg || 0) <= MAX_CPU, cpuAvg === null ? "n/a" : `${cpuAvg.toFixed(2)} (max ${cpuMax.toFixed(1)})`],
    [
      `Task failure ratio <= ${MAX_FAIL_RATIO * 100}%`,
      failRatio <= MAX_FAIL_RATIO || completed + failed < 20,
      `${failed} failed / ${completed} completed (${(failRatio * 100).toFixed(1)}%)`
    ]
  ];
  console.log("");
  for (const [name, ok, detail] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(32)} ${detail}`);
  for (const e of moduleErrors.slice(-5))
    console.log(`  [${e.tick}] ${e.module}: ${String(e.message).split("\n").slice(0, 3).join(" | ")}`);
  for (const e of consoleErrors.slice(-5)) console.log(`  [${e.tick}] console: ${e.message.split("\n")[0]}`);

  const report = {
    date: new Date().toISOString(),
    engine: "mockup",
    code: CODE,
    room: ROOM,
    spawn: spot,
    ticks: TICKS,
    startTime,
    elapsedMs,
    ticksPerSecond: TICKS / (elapsedMs / 1000),
    world,
    checks,
    cpu: { avg: cpuAvg, max: cpuMax },
    stats,
    errors: moduleErrors,
    consoleErrors,
    consoleErrorCount: errorCount,
    moduleState
  };
  if (OUT) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(`\nFull report: ${OUT}`);
  }
  server.stop();
  process.exit(checks.every((c) => c[1]) ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
