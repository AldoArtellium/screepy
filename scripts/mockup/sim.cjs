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
/**
 * Invader raids: "tick:body+body,tick:body" with the backend's raid bodies (smallMelee, smallRanged,
 * smallHealer, bigMelee, bigRanged, bigHealer), e.g. --raid 12000:bigMelee+bigRanged. The creeps
 * appear on the first exit tiles of the room and run the engine's invader AI.
 */
const RAIDS = (opt("raid", "") || "")
  .split(",")
  .filter(Boolean)
  .map((r) => {
    const [t, bodies] = r.split(":");
    return { tick: Number(t), bodies: bodies.split("+") };
  });
/** Bodies of backend/lib/cronjobs.js createCreep */
const RAID_BODIES = {
  bigHealer: [...Array(24).fill("move"), ...Array(25).fill("heal"), "move"],
  bigRanged: [...Array(6).fill("tough"), ...Array(24).fill("move"), ...Array(18).fill("ranged_attack"), "work", "move"],
  bigMelee: [...Array(16).fill("tough"), ...Array(24).fill("move"), ...Array(3).fill("ranged_attack"), ...Array(4).fill("work"), "attack", "attack", "move"],
  smallHealer: ["move", "move", "move", "move", "heal", "heal", "heal", "heal", "heal", "move"],
  smallRanged: ["tough", "tough", "move", "move", "move", "move", "ranged_attack", "ranged_attack", "ranged_attack", "move"],
  smallMelee: ["tough", "tough", "move", "move", "move", "move", "ranged_attack", "work", "attack", "move"]
};
/**
 * Enemy player (offense tests): "ROOM:RCL[:defenders[:ringHits]]", e.g. --enemy W8N3:3 or W8N3:5:2:100000.
 * A base around a spawn (no safe mode: a new player starts with one, where attacks fail with
 * ERR_NO_BODYPART): full towers for the RCL, ramparts on spawn and towers, a ring of ramparts at
 * range 5 of the spawn (ringHits, default 30000), scripts/mockup/enemy-bot.js as its code.
 */
const ENEMY = opt("enemy", null);
/** Global control level of the bot (default 1), e.g. 2 to allow a second room (expansion tests) */
const GCL = Number(opt("gcl", 1));
/** CPU limit of the bot (default: the mockup's, 100), e.g. 8 to drain the bucket and test throttling */
const CPU_LIMIT = opt("cpu-limit", null);
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

/** Enemy base for offense tests (see ENEMY) */
async function setupEnemy(server, fixture, spec) {
  const [room, rclText, defendersText, ringText] = spec.split(":");
  const rcl = Number(rclText);
  const r = fixture.rooms[room];
  if (!r) throw new Error(`Enemy room ${room} is not in the fixture`);
  const spot = findSpawnSpot(r.terrain, r.objects);
  const code = fs.readFileSync(path.join(__dirname, "enemy-bot.js"), "utf-8");
  const enemy = await server.world.addBot({ username: "enemy", room, x: spot.x, y: spot.y, gcl: 10, modules: { main: code } });
  const { db, env } = server.common.storage;
  await env.set(env.keys.MEMORY + enemy.id, JSON.stringify({ defenders: Number(defendersText || 0) }));
  const time = await server.world.gameTime;
  await db["rooms.objects"].update({ room, type: "controller" }, { $set: { level: rcl, progress: 0, downgradeTime: time + 100000, safeModeAvailable: 0, safeMode: null } });
  await db.rooms.update({ _id: room }, { $set: { active: true } });
  const wall = (x, y) => (Number(r.terrain[y * 50 + x]) & 1) === 1;
  const taken = new Set([spot.y * 50 + spot.x, ...r.objects.map((o) => o.y * 50 + o.x)]);
  const towers = { 3: 1, 4: 1, 5: 2, 6: 2, 7: 3, 8: 6 }[rcl] || 0;
  const rampartHits = { 2: 300000, 3: 1000000, 4: 3000000, 5: 10000000, 6: 30000000, 7: 100000000, 8: 300000000 }[rcl] || 300000;
  const ringHits = Math.min(Number(ringText || 30000), rampartHits);
  const insert = (doc) => db["rooms.objects"].insert({ room, user: enemy.id, ...doc });
  const rampart = (x, y, hits) => insert({ type: "rampart", x, y, hits, hitsMax: rampartHits, nextDecayTime: time + 100000, isPublic: false });
  const placed = [];
  for (let radius = 2; radius <= 3 && placed.length < towers; radius++) {
    for (let dx = -radius; dx <= radius && placed.length < towers; dx++) {
      for (let dy = -radius; dy <= radius && placed.length < towers; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius || (dx + dy) % 2 !== 0) continue;
        const x = spot.x + dx;
        const y = spot.y + dy;
        if (wall(x, y) || taken.has(y * 50 + x)) continue;
        taken.add(y * 50 + x);
        placed.push({ x, y });
        await insert({ type: "tower", x, y, hits: 3000, hitsMax: 3000, store: { energy: 1000 }, storeCapacityResource: { energy: 1000 }, actionLog: { attack: null, heal: null, repair: null } });
      }
    }
  }
  for (const p of [spot, ...placed]) await rampart(p.x, p.y, Math.min(ringHits * 3, rampartHits));
  let ring = 0;
  for (let dx = -5; dx <= 5; dx++) {
    for (let dy = -5; dy <= 5; dy++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== 5) continue;
      const x = spot.x + dx;
      const y = spot.y + dy;
      if (x < 2 || y < 2 || x > 47 || y > 47 || wall(x, y) || taken.has(y * 50 + x)) continue;
      await rampart(x, y, ringHits);
      ring++;
    }
  }
  log(`Enemy in ${room} (RCL ${rcl}): spawn ${spot.x},${spot.y}, ${placed.length} towers, ${ring} ring ramparts of ${ringHits} hits`);
  return { id: enemy.id, room };
}

async function enemyStatus(server, enemy) {
  const objects = await server.common.storage.db["rooms.objects"].find({ room: enemy.room, user: enemy.id });
  const count = (type) => objects.filter((o) => o.type === type).length;
  const towerEnergy = objects.filter((o) => o.type === "tower").reduce((sum, o) => sum + ((o.store && o.store.energy) || 0), 0);
  return { spawns: count("spawn"), towers: count("tower"), towerEnergy, ramparts: count("rampart"), creeps: count("creep") };
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
    creepsByRoom: await creepCensus(db, userId),
    // Every room we own and its level (expansion)
    ownedRooms: Object.fromEntries(
      (await db["rooms.objects"].find({ type: "controller", user: userId })).map((c) => [c.room, c.level])
    )
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
  // GCL level n needs GCL_MULTIPLY * (n - 1) ^ GCL_POW control points
  const gcl = GCL > 1 ? Math.ceil(1000000 * Math.pow(GCL - 1, 2.4)) + 1 : 1;
  const user = await server.world.addBot({ username: USERNAME, room: ROOM, x: spot.x, y: spot.y, gcl, modules: { main } });
  const { env, pubsub } = server.common.storage;
  // The enemy first: adding a second user resets the first one's Memory
  const enemy = ENEMY ? await setupEnemy(server, fixture, ENEMY) : null;
  await env.set(env.keys.MEMORY + user.id, MEMORY_INIT);
  if (CPU_LIMIT !== null) {
    await server.common.storage.db.users.update({ _id: user.id }, { $set: { cpu: Number(CPU_LIMIT), cpuAvailable: 10000 } });
    log(`CPU limit ${CPU_LIMIT}, bucket 10000`);
  }
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
  const raidLog = [];
  const exitTiles = [];
  for (let i = 1; i < 49; i++) {
    for (const [x, y] of [[i, 0], [0, i], [49, i], [i, 49]]) {
      if (!(Number(fixture.rooms[ROOM].terrain[y * 50 + x]) & 1)) exitTiles.push([x, y]);
    }
  }
  for (tick = 1; tick <= TICKS; tick++) {
    for (const raid of RAIDS.filter((r) => r.tick === tick)) {
      const names = [];
      for (const [i, type] of raid.bodies.entries()) {
        const [x, y] = exitTiles[(i * 3) % exitTiles.length];
        const body = RAID_BODIES[type];
        if (!body) throw new Error(`Unknown raid body ${type}`);
        const name = `invader_${ROOM}_${tick}_${i}`;
        await db["rooms.objects"].insert({
          type: "creep", user: "2", body: body.map((t) => ({ type: t, hits: 100 })), hits: body.length * 100,
          hitsMax: body.length * 100, ticksToLive: 1500, x, y, room: ROOM, fatigue: 0, store: {}, storeCapacity: 0, name
        });
        names.push(name);
      }
      raidLog.push({ tick, bodies: raid.bodies, names });
      log(`Raid at tick ${tick}: ${raid.bodies.join(" + ")}`);
    }
    for (const raid of raidLog) {
      if (raid.over) continue;
      const alive = await db["rooms.objects"].count({ type: "creep", user: "2", name: { $in: raid.names } });
      if (alive === 0) {
        raid.over = tick;
        log(`Raid of tick ${raid.tick} over after ${tick - raid.tick} ticks`);
      }
    }
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
        Object.keys(w.ownedRooms).length > 1 ? `| rooms ${JSON.stringify(w.ownedRooms)}` : "",
        enemy ? `| enemy ${JSON.stringify(await enemyStatus(server, enemy))}` : "",
        CPU_LIMIT !== null ? `| bucket ${(await server.common.storage.db.users.findOne({ _id: user.id })).cpuAvailable | 0}` : "",
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
  // The official server charges 0.2 CPU per intent, the mockup engine doesn't
  const intentsPerTick = counters.intents !== undefined ? counters.intents / TICKS : null;
  const officialCpu = cpuAvg !== null && intentsPerTick !== null ? cpuAvg + 0.2 * intentsPerTick : null;
  if (officialCpu !== null)
    console.log(`Intents ${intentsPerTick.toFixed(2)}/tick | official CPU estimate ${officialCpu.toFixed(2)}`);
  const roleCpu = Object.keys(counters)
    .filter((k) => k.startsWith("cpu:"))
    .map((k) => {
      const role = k.slice(4);
      const creepTicks = counters[`creepTicks:${role}`] || 1;
      return { role, perTick: counters[k] / TICKS, perCreep: counters[k] / creepTicks };
    })
    .sort((a, b) => b.perTick - a.perTick);
  if (roleCpu.length)
    console.log(
      "CPU by role (per tick / per creep): " +
        roleCpu.map((r) => `${r.role} ${r.perTick.toFixed(2)}/${r.perCreep.toFixed(3)}`).join(", ")
    );
  if (enemy) console.log(`Enemy ${enemy.room}: ${JSON.stringify(await enemyStatus(server, enemy))}`);
  for (const raid of raidLog) {
    console.log(`Raid tick ${raid.tick} (${raid.bodies.join("+")}): ${raid.over ? `cleared after ${raid.over - raid.tick} ticks` : "still alive at the end"}`);
  }
  if (raidLog.length) {
    const pick = (re) => Object.entries(counters).filter(([k]) => re.test(k)).map(([k, v]) => `${k}=${Math.round(v)}`).join(" ");
    console.log(`Defense: ${pick(/^(tower:attack|safeMode|spawned:(guardian|brawler))$/)} | spawns ${await db["rooms.objects"].count({ room: ROOM, type: "spawn" })}`);
  }
  console.log(`Tasks ${completed} completed / ${failed} failed`);
  console.log(`Module errors ${moduleErrors.length} | console errors ${errorCount}`);
  const memorySize = Object.fromEntries(Object.entries(memory).map(([k, v]) => [k, JSON.stringify(v).length]));
  console.log(`Memory ${JSON.stringify(memory).length} chars | ${Object.entries(memorySize).sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k, v]) => `${k} ${v}`).join(", ")}`);
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
    cpu: { avg: cpuAvg, max: cpuMax, intentsPerTick, officialEstimate: officialCpu, byRole: roleCpu },
    raids: raidLog,
    enemy: enemy ? await enemyStatus(server, enemy) : null,
    stats,
    errors: moduleErrors,
    consoleErrors,
    consoleErrorCount: errorCount,
    moduleState,
    memorySize
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
