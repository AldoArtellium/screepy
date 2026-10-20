/**
 * In-process Screeps simulation (screeps-server-mockup), run INSIDE the screepy-mockup container
 * by run.mjs. Not meant to be started by hand on the host.
 *
 * Args: --code <bundle> --room <name> --ticks <n> --memory <json> --out <report.json> [--verbose]
 *       [--log-every <ticks>] [--dump-memory] (Memory + segments in <report>-memory.json)
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
/** Initial Memory: JSON, or "@path" (relative to the repo, e.g. a -memory.json dump: its `memory` key is used) */
const MEMORY_INIT = (() => {
  const value = opt("memory", "{}");
  if (!value.startsWith("@")) return value;
  const data = JSON.parse(fs.readFileSync(value.slice(1), "utf-8"));
  return JSON.stringify(data.memory && data.segments ? data.memory : data);
})();
/**
 * Invader raids: "tick:body+body,tick:body" with the backend's raid bodies (smallMelee, smallRanged,
 * smallHealer, bigMelee, bigRanged, bigHealer), e.g. --raid 12000:bigMelee+bigRanged. The creeps
 * appear on the first exit tiles of the room and run the engine's invader AI. "@ROOM" after the bodies
 * puts them in another room of the fixture (a remote), e.g. --raid 12000:smallMelee@W7N4. A "*" after a body
 * boosts it like the backend's boosted invaders (RAID_BOOSTS), e.g. --raid 12000:smallMelee*@W7N4.
 */
const RAIDS = (opt("raid", "") || "")
  .split(",")
  .filter(Boolean)
  .map((r) => {
    const [t, spec] = r.split(":");
    const [bodies, room] = spec.split("@");
    return { tick: Number(t), bodies: bodies.split("+"), room };
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
/** Boosts of backend/lib/cronjobs.js createCreep for boosted invaders */
const RAID_BOOSTS = { tough: "GO", ranged_attack: "KO", work: "ZH", attack: "UH", heal: "LO" };
/**
 * Enemy player (offense tests): "ROOM:RCL[:defenders[:ringHits]]", e.g. --enemy W8N3:3 or W8N3:5:2:100000.
 * A base around a spawn (no safe mode: a new player starts with one, where attacks fail with
 * ERR_NO_BODYPART): full towers for the RCL, ramparts on spawn and towers, a ring of ramparts at
 * range 5 of the spawn (ringHits, default 30000), scripts/mockup/enemy-bot.js as its code.
 */
const ENEMY = opt("enemy", null);
/** Global control level of the bot (default 1), e.g. 2 to allow a second room (expansion tests) */
const GCL = Number(opt("gcl", 1));
/**
 * Fast-forwarded start (same idea as pserver-test.mjs --preset): "rcl4", "rcl5" or "rcl7" sets the controller
 * level and adds a storage with energy, the extensions of the level on a checkerboard around the
 * spawn and a container by each source, e.g. to test attacks without growing the room for 12000 ticks.
 */
const PRESETS = {
  rcl4: { rcl: 4, extensions: 20, storageEnergy: 100000 },
  rcl5: { rcl: 5, extensions: 30, storageEnergy: 150000 },
  rcl7: { rcl: 7, extensions: 50, storageEnergy: 300000 }
};
const PRESET = opt("preset", null);
/**
 * Invader stronghold: "ROOM:LEVEL", e.g. --stronghold W7N4:1. An invader core (bunker template of the
 * level) deploying 5 ticks later on the room's spawn spot: the engine builds its towers, ramparts and
 * defenders (level 2+) and refills its towers.
 */
const STRONGHOLD = opt("stronghold", null);
/**
 * Leftover structures (room cleanup and dismantler tests): JSON array or "@file", each entry
 * { type, room?, x, y | dx, dy (from our spawn spot) | line: "y=43" / "x=10", hits?, owner?: true,
 *   store?, structureType? (construction sites) }. room defaults to the start room; a line covers every
 * non-wall tile of that row or column (1..48) not taken by a natural object; owner puts the structure
 * under the inactive player "Ruins" (an abandoned base), else it is unowned (walls).
 * e.g. --structures '[{"type":"constructedWall","room":"W7N4","line":"y=43","hits":10000},{"type":"extension","dx":3,"dy":0,"owner":true}]'
 */
const STRUCTURES = (() => {
  const value = opt("structures", null);
  if (!value) return null;
  return JSON.parse(value.startsWith("@") ? fs.readFileSync(value.slice(1), "utf-8") : value);
})();
/** CPU limit of the bot (default: the mockup's, 100), e.g. 8 to drain the bucket and test throttling */
const CPU_LIMIT = opt("cpu-limit", null);
/**
 * Plan-based fast-forward (--preset rcl6, rcl8, or planN for any level 5-8): once the bot stored its room
 * plan, the controller jumps to that level and the plan's storage (300k energy), extensions, towers,
 * source/controller containers, roads and main ramparts (600k hits) are built for it, like the private
 * server preset. rcl4/rcl5/rcl7 are the quick presets above (PRESETS).
 */
/**
 * With a plan preset: resources added to the storage, e.g. --minerals H:20000,O:20000,XLHO2:3000 (lab and
 * boost tests), and --labs: the plan's terminal and labs (as many as the level allows) built at once
 */
const MINERALS = Object.fromEntries(
  (opt("minerals", "") || "").split(",").filter(Boolean).map((s) => {
    const [r, n] = s.split(":");
    return [r, Number(n)];
  })
);
const LABS = flag("labs");
const QUICK_PRESET = PRESET && PRESETS[PRESET] ? PRESET : null;
const PLAN_PRESET = PRESET && !QUICK_PRESET ? PRESET : null;
/**
 * World state: --save-state <file> writes every room object, the game time and the bot's Memory at
 * the end of the run; --load-state <file> starts from such a file (same room, objects re-owned by the
 * new user, Memory.stats counters reset). Lets RCL 5+ changes be compared from one advanced state
 * instead of 25k+ ticks from scratch.
 */
const SAVE_STATE = opt("save-state", null);
const LOAD_STATE = opt("load-state", null);
/** With --load-state: controller level forced on load (progress 0), e.g. 5 to test RCL 5 code from an RCL 4 economy */
const SET_RCL = Number(opt("set-rcl", 0));
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
// Regression gate (CI): minimum world.points at the end, only checked when given
const MIN_POINTS = opt("min-points") === undefined ? null : Number(opt("min-points"));
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

/** Fast-forwarded room (see PRESETS) */
async function applyQuickPreset(server, fixture, spot, userId) {
  const preset = PRESETS[PRESET];
  if (!preset) throw new Error(`Unknown preset ${PRESET} (available: ${Object.keys(PRESETS).join(", ")})`);
  const { db } = server.common.storage;
  const r = fixture.rooms[ROOM];
  const time = await server.world.gameTime;
  const taken = new Set([spot.y * 50 + spot.x, ...r.objects.map((o) => o.y * 50 + o.x)]);
  const free = (x, y) => x > 1 && x < 48 && y > 1 && y < 48 && (Number(r.terrain[y * 50 + x]) & 1) === 0 && !taken.has(y * 50 + x);
  const insert = async (doc) => {
    taken.add(doc.y * 50 + doc.x);
    await db["rooms.objects"].insert({ room: ROOM, user: userId, notifyWhenAttacked: true, ...doc });
  };
  await db["rooms.objects"].update({ room: ROOM, type: "controller" }, { $set: { level: preset.rcl, progress: 0, downgradeTime: time + 20000 } });
  const spots = [];
  for (let radius = 2; radius <= 8; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const x = spot.x + dx;
        const y = spot.y + dy;
        if ((x + y) % 2 === (spot.x + spot.y) % 2 && free(x, y)) spots.push({ x, y });
      }
    }
  }
  const s = spots.shift();
  await insert({ type: "storage", x: s.x, y: s.y, hits: 10000, hitsMax: 10000, store: { energy: preset.storageEnergy }, storeCapacity: 1000000 });
  const capacity = preset.rcl >= 8 ? 200 : preset.rcl === 7 ? 100 : 50;
  for (let i = 0; i < preset.extensions && spots.length; i++) {
    const e = spots.shift();
    await insert({ type: "extension", x: e.x, y: e.y, hits: 1000, hitsMax: 1000, off: false, store: { energy: capacity }, storeCapacityResource: { energy: capacity } });
  }
  for (const source of r.objects.filter((o) => o.type === "source")) {
    let best = null;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const x = source.x + dx;
        const y = source.y + dy;
        if (!(dx || dy) || !free(x, y)) continue;
        const d = Math.max(Math.abs(x - spot.x), Math.abs(y - spot.y));
        if (!best || d < best.d) best = { x, y, d };
      }
    }
    if (best) await insert({ type: "container", x: best.x, y: best.y, hits: 250000, hitsMax: 250000, store: {}, storeCapacity: 2000, nextDecayTime: time + 500 });
  }
  log(`Preset ${PRESET}: RCL ${preset.rcl}, ${preset.extensions} extensions, storage ${preset.storageEnergy}, source containers`);
}

/** Defaults of the structures --structures places (engine object fields) */
const STRUCTURE_DEFAULTS = {
  constructedWall: { hits: 10000, hitsMax: 300000000 },
  rampart: { hits: 10000, hitsMax: 300000000, isPublic: false },
  extension: { hits: 1000, hitsMax: 1000, store: { energy: 0 }, storeCapacityResource: { energy: 50 } },
  spawn: { hits: 5000, hitsMax: 5000, store: { energy: 0 }, storeCapacityResource: { energy: 300 }, name: "RuinSpawn" },
  tower: { hits: 3000, hitsMax: 3000, store: { energy: 0 }, storeCapacityResource: { energy: 1000 } },
  storage: { hits: 10000, hitsMax: 10000, store: {}, storeCapacity: 1000000 },
  container: { hits: 250000, hitsMax: 250000, store: {}, storeCapacity: 2000 },
  link: { hits: 1000, hitsMax: 1000, store: { energy: 0 }, storeCapacityResource: { energy: 800 }, cooldown: 0 },
  road: { hits: 5000, hitsMax: 5000 }
};

/** Leftover structures (see STRUCTURES); returns their ids, to follow what is left */
async function setupStructures(server, fixture, spot, specs) {
  const { db } = server.common.storage;
  const time = await server.world.gameTime;
  const ruinsUser = "ruins";
  if (specs.some((s) => s.owner)) {
    await db.users.insert({ _id: ruinsUser, username: "Ruins", cpu: 0, cpuAvailable: 0, gcl: 1, active: 0, badge: {} });
  }
  const ids = [];
  for (const spec of specs) {
    const room = spec.room || ROOM;
    const r = fixture.rooms[room];
    if (!r) throw new Error(`--structures: room ${room} is not in the fixture`);
    const wall = (x, y) => (Number(r.terrain[y * 50 + x]) & 1) === 1;
    const taken = new Set(r.objects.map((o) => o.y * 50 + o.x));
    let tiles;
    if (spec.line) {
      const [axis, value] = spec.line.split("=");
      tiles = Array.from({ length: 48 }, (_, i) => (axis === "y" ? { x: i + 1, y: Number(value) } : { x: Number(value), y: i + 1 }));
      tiles = tiles.filter((t) => !wall(t.x, t.y) && !taken.has(t.y * 50 + t.x));
    } else if (spec.dx !== undefined) tiles = [{ x: spot.x + spec.dx, y: spot.y + spec.dy }];
    else tiles = [{ x: spec.x, y: spec.y }];
    const { type, room: _r, x: _x, y: _y, dx: _dx, dy: _dy, line: _l, owner, ...fields } = spec;
    for (const t of tiles) {
      const doc =
        type === "constructionSite"
          ? { progress: 0, progressTotal: 1000, ...fields }
          : { ...(STRUCTURE_DEFAULTS[type] || { hits: 1000, hitsMax: 1000 }), ...fields };
      if (type === "rampart") doc.nextDecayTime = time + 1000000;
      if (type === "road") doc.nextDecayTime = time + 1000000;
      const inserted = await db["rooms.objects"].insert({ room, x: t.x, y: t.y, type, ...(owner ? { user: ruinsUser } : {}), ...doc });
      ids.push(inserted._id);
    }
    await db.rooms.update({ _id: room }, { $set: { active: true } });
  }
  log(`Leftover structures: ${ids.length} placed`);
  return ids;
}

/** Placed leftover structures still standing, by room and type */
async function structuresLeft(server, ids) {
  const objects = await server.common.storage.db["rooms.objects"].find({ _id: { $in: ids } });
  const byType = {};
  for (const o of objects) byType[`${o.room}:${o.type}`] = (byType[`${o.room}:${o.type}`] || 0) + 1;
  return { placed: ids.length, left: objects.length, byType };
}

/** Invader stronghold (see STRONGHOLD) */
async function setupStronghold(server, fixture, spec) {
  const [room, levelText] = spec.split(":");
  const level = Number(levelText || 1);
  const r = fixture.rooms[room];
  if (!r) throw new Error(`Stronghold room ${room} is not in the fixture`);
  const spot = findSpawnSpot(r.terrain, r.objects);
  const { db } = server.common.storage;
  const time = await server.world.gameTime;
  await db.rooms.update({ _id: room }, { $set: { active: true } });
  await db["rooms.objects"].insert({
    type: "invaderCore", room, x: spot.x, y: spot.y, user: "2", level, templateName: `bunker${level}`, strongholdId: `test${room}`,
    hits: 100000, hitsMax: 100000, deployTime: time + 5, depositType: "silicon", effects: [], actionLog: {}
  });
  log(`Stronghold level ${level} in ${room} at ${spot.x},${spot.y}`);
  return { room };
}

async function strongholdStatus(server, stronghold) {
  const objects = await server.common.storage.db["rooms.objects"].find({ room: stronghold.room, user: "2" });
  const count = (type) => objects.filter((o) => o.type === type).length;
  return { cores: count("invaderCore"), towers: count("tower"), ramparts: count("rampart"), creeps: count("creep") };
}

/** Positions of a plan type in Memory.rooms[room].plan (RoomPlan.ts packing: ((x << 6) | y) + 65) */
function planPositions(plan, type) {
  const packed = (plan.t && plan.t[type]) || "";
  const out = [];
  for (let i = 0; i < packed.length; i++) {
    const code = packed.charCodeAt(i) - 65;
    out.push({ x: code >> 6, y: code & 63 });
  }
  return out;
}

/** Room plans of the bot: segment store "plans" (src/planner/RoomPlanner.ts, JSON split over segments 3-4) */
async function readPlans(server, user) {
  const { env } = server.common.storage;
  const parts = (await env.hmget(env.keys.MEMORY_SEGMENTS + user.id, [3, 4])) || [];
  const text = parts.map((p) => p || "").join("");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** Applies PLAN_PRESET to the bot's room from its stored plan; false while there is no plan yet */
async function applyPlanPreset(server, user, memory) {
  const plan = (await readPlans(server, user))[ROOM] || (memory.rooms && memory.rooms[ROOM] && memory.rooms[ROOM].plan);
  if (!plan || !plan.t) return false;
  const match = /^(?:rcl|plan)([5-8])$/.exec(PLAN_PRESET);
  if (!match) throw new Error(`Unknown preset ${PLAN_PRESET} (quick: ${Object.keys(PRESETS).join(", ")}; plan-based: rcl6, rcl8, plan5..plan8)`);
  const rcl = Number(match[1]);
  const { db } = server.common.storage;
  const time = await server.world.gameTime;
  await db["rooms.objects"].update({ room: ROOM, type: "controller" }, { $set: { level: rcl, progress: 0, downgradeTime: time + 200000 } });
  const taken = new Set((await db["rooms.objects"].find({ room: ROOM })).filter((o) => o.type !== "road").map((o) => o.y * 50 + o.x));
  const insert = async (pos, doc) => {
    if (taken.has(pos.y * 50 + pos.x)) return false;
    taken.add(pos.y * 50 + pos.x);
    await db["rooms.objects"].insert({ room: ROOM, x: pos.x, y: pos.y, user: user.id, ...doc });
    return true;
  };
  const extEnergy = { 7: 100, 8: 200 }[rcl] || 50;
  const counts = { extension: { 5: 30, 6: 40, 7: 50, 8: 60 }[rcl], tower: { 5: 2, 6: 3, 7: 4, 8: 6 }[rcl] };
  await insert(planPositions(plan, "storage")[0], { type: "storage", hits: 10000, hitsMax: 10000, store: { energy: 300000, ...MINERALS }, storeCapacity: 1000000 });
  let labs = 0;
  if (LABS) {
    await insert(planPositions(plan, "terminal")[0], { type: "terminal", hits: 3000, hitsMax: 3000, store: { energy: 10000 }, storeCapacity: 300000 });
    const maxLabs = { 6: 3, 7: 6, 8: 10 }[rcl] || 0;
    // Source labs first: every other lab reacts with them
    const sources = planPositions(plan, "lab.source");
    const key = (p) => p.y * 50 + p.x;
    const ordered = [...sources, ...planPositions(plan, "lab").filter((p) => !sources.some((s) => key(s) === key(p)))];
    for (const pos of ordered) {
      if (labs >= maxLabs) break;
      if (await insert(pos, { type: "lab", hits: 500, hitsMax: 500, mineralAmount: 0, store: { energy: 0 }, storeCapacity: 5000, storeCapacityResource: { energy: 2000 }, cooldown: 0, actionLog: { runReaction: null, reverseReaction: null } })) labs++;
    }
  }
  let ext = 0;
  for (const pos of planPositions(plan, "extension")) {
    if (ext >= counts.extension) break;
    if (await insert(pos, { type: "extension", hits: 1000, hitsMax: 1000, off: false, store: { energy: extEnergy }, storeCapacityResource: { energy: extEnergy } })) ext++;
  }
  let towers = 0;
  for (let i = 0; i < 6 && towers < counts.tower; i++) {
    for (const pos of planPositions(plan, `tower.${i}`)) {
      if (await insert(pos, { type: "tower", hits: 3000, hitsMax: 3000, store: { energy: 1000 }, storeCapacityResource: { energy: 1000 }, actionLog: { attack: null, heal: null, repair: null } })) towers++;
    }
  }
  for (const type of ["container.source", "container.controller"]) {
    for (const pos of planPositions(plan, type)) await insert(pos, { type: "container", hits: 250000, hitsMax: 250000, store: {}, storeCapacity: 2000, nextDecayTime: time + 500 });
  }
  const ramps = new Set(planPositions(plan, "rampart.ramp").map((p) => p.y * 50 + p.x));
  let ramparts = 0;
  for (const pos of planPositions(plan, "rampart")) {
    if (ramps.has(pos.y * 50 + pos.x)) continue;
    await db["rooms.objects"].insert({ room: ROOM, x: pos.x, y: pos.y, user: user.id, type: "rampart", hits: 600000, hitsMax: 600000, nextDecayTime: time + 100, isPublic: false });
    ramparts++;
  }
  const terrain = fixtureTerrain;
  let roads = 0;
  for (const pos of planPositions(plan, "road")) {
    if (taken.has(pos.y * 50 + pos.x) || (Number(terrain[pos.y * 50 + pos.x]) & 1)) continue;
    await db["rooms.objects"].insert({ room: ROOM, x: pos.x, y: pos.y, type: "road", hits: 5000, hitsMax: 5000, nextDecayTime: time + 1000 });
    roads++;
  }
  log(`Preset ${PRESET} at tick ${time}: storage, ${ext} extensions, ${towers} towers, ${ramparts} ramparts, ${roads} roads${LABS ? `, terminal, ${labs} labs` : ""}${Object.keys(MINERALS).length ? `, storage minerals ${JSON.stringify(MINERALS)}` : ""}`);
  return true;
}
let fixtureTerrain = "";

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
    // Endgame structures (count by type) and non-energy resources in storage, terminal and containers
    endgame: Object.fromEntries(
      ["terminal", "extractor", "lab", "factory", "powerSpawn", "nuker", "observer"]
        .map((t) => [t, mine.filter((o) => o.type === t).length])
        .filter(([, n]) => n > 0)
    ),
    // Boosted body parts of our creeps in the room, by role (name prefix) and compound
    boostedParts: mine
      .filter((o) => o.type === "creep")
      .reduce((acc, o) => {
        for (const part of o.body || []) {
          if (part.boost) {
            const key = `${String(o.name).split("_")[0]}:${part.boost}`;
            acc[key] = (acc[key] || 0) + 1;
          }
        }
        return acc;
      }, {}),
    minerals: objects
      .filter((o) => (o.user === userId || o.type === "container") && ["storage", "terminal", "container", "lab"].includes(o.type))
      .reduce((acc, o) => {
        for (const [r, n] of Object.entries(o.store || {})) if (r !== "energy" && n) acc[`${o.type}:${r}`] = (acc[`${o.type}:${r}`] || 0) + n;
        return acc;
      }, {}),
    siteTypes: objects
      .filter((o) => o.type === "constructionSite" && o.user === userId)
      .reduce((acc, o) => ({ ...acc, [o.structureType]: (acc[o.structureType] || 0) + 1 }), {}),
    terminalEnergy: mine.filter((o) => o.type === "terminal").reduce((sum, o) => sum + ((o.store && o.store.energy) || 0), 0),
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

/** Strips the LokiJS bookkeeping of a document */
function plain(doc) {
  const { $loki, meta, ...rest } = doc;
  return rest;
}

/** Non-empty RawMemory segments of the bot, by id */
async function readSegments(env, userId) {
  const ids = Array.from({ length: 100 }, (_, i) => i);
  const values = (await env.hmget(env.keys.MEMORY_SEGMENTS + userId, ids)) || [];
  return Object.fromEntries(ids.map((id, i) => [id, values[i]]).filter(([, v]) => v));
}

async function saveState(server, userId, file) {
  const { db, env } = server.common.storage;
  const state = {
    room: ROOM,
    userId,
    gameTime: Number(await server.world.gameTime),
    gcl: (await db.users.findOne({ _id: userId })).gcl,
    memory: await env.get(env.keys.MEMORY + userId),
    // RawMemory segments (plans, intel, remote paths live there)
    segments: await readSegments(env, userId),
    objects: (await db["rooms.objects"].find({})).map(plain)
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state));
  fs.renameSync(`${file}.tmp`, file);
  log(`State saved to ${file} (tick ${state.gameTime}, ${state.objects.length} objects)`);
}

/** Replaces the world's objects, game time and Memory by a saved state (see SAVE_STATE) */
async function loadState(server, userId, file) {
  const { db, env } = server.common.storage;
  const state = JSON.parse(fs.readFileSync(file, "utf-8"));
  if (state.room !== ROOM) throw new Error(`State ${file} is for ${state.room}, not ${ROOM}`);
  await db["rooms.objects"].removeWhere({});
  const rooms = new Set();
  // Every user reference (owner, controller reservation and sign...) but the NPCs ("2" invaders,
  // "3" source keepers) is ours: the saved world has a single player
  const reown = (value) => {
    if (!value || typeof value !== "object") return;
    for (const [key, v] of Object.entries(value)) {
      if (key === "user" && typeof v === "string" && v !== "2" && v !== "3") value[key] = userId;
      else reown(v);
    }
  };
  for (const o of state.objects) {
    reown(o);
    if (o.user === userId) rooms.add(o.room);
    await db["rooms.objects"].insert(o);
  }
  for (const room of rooms) {
    await db.rooms.update({ _id: room }, { $set: { active: true } });
    await env.sadd(env.keys.ACTIVE_ROOMS, room);
  }
  if (SET_RCL) {
    await db["rooms.objects"].update(
      { room: ROOM, type: "controller" },
      { $set: { level: SET_RCL, progress: 0, downgradeTime: state.gameTime + 50000 } }
    );
  }
  await db.users.update({ _id: userId }, { $set: { gcl: state.gcl } });
  await env.set(env.keys.GAMETIME, state.gameTime);
  const memory = JSON.parse(state.memory || "{}");
  if (memory.stats) memory.stats.counters = {};
  delete memory.moduleErrors;
  await env.set(env.keys.MEMORY + userId, JSON.stringify(memory));
  if (state.segments && Object.keys(state.segments).length) await env.hmset(env.keys.MEMORY_SEGMENTS + userId, state.segments);
  log(`State loaded from ${file} (tick ${state.gameTime}, ${state.objects.length} objects, rooms ${[...rooms].join(" ")})`);
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
  fixtureTerrain = fixture.rooms[ROOM].terrain;
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
  if (QUICK_PRESET) await applyQuickPreset(server, fixture, spot, user.id);
  const stronghold = STRONGHOLD ? await setupStronghold(server, fixture, STRONGHOLD) : null;
  const leftovers = STRUCTURES ? await setupStructures(server, fixture, spot, STRUCTURES) : null;
  await env.set(env.keys.MEMORY + user.id, MEMORY_INIT);
  if (LOAD_STATE) await loadState(server, user.id, LOAD_STATE);
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
  const exitTilesOf = (room) => {
    const tiles = [];
    for (let i = 1; i < 49; i++) {
      for (const [x, y] of [[i, 0], [0, i], [49, i], [i, 49]]) {
        if (!(Number(fixture.rooms[room].terrain[y * 50 + x]) & 1)) tiles.push([x, y]);
      }
    }
    return tiles;
  };
  let presetDone = !PLAN_PRESET;
  // An engine process killed (e.g. out of memory) leaves the loop waiting forever: give up
  let lastTickAt = Date.now();
  setInterval(() => {
    if (Date.now() - lastTickAt < 180000) return;
    console.error(`No tick for 3 minutes (tick ${tick}): an engine process died, giving up`);
    process.exit(2);
  }, 10000).unref();
  for (tick = 1; tick <= TICKS; tick++) {
    if (!presetDone) presetDone = await applyPlanPreset(server, user, await readMemory(user));
    for (const raid of RAIDS.filter((r) => r.tick === tick)) {
      const names = [];
      const raidRoom = raid.room || ROOM;
      if (!fixture.rooms[raidRoom]) throw new Error(`Raid room ${raidRoom} is not in the fixture`);
      const exitTiles = exitTilesOf(raidRoom);
      for (const [i, type] of raid.bodies.entries()) {
        const [x, y] = exitTiles[(i * 3) % exitTiles.length];
        const boosted = type.endsWith("*");
        const body = RAID_BODIES[boosted ? type.slice(0, -1) : type];
        if (!body) throw new Error(`Unknown raid body ${type}`);
        const name = `invader_${raidRoom}_${tick}_${i}`;
        await db["rooms.objects"].insert({
          type: "creep", user: "2", body: body.map((t) => (boosted && RAID_BOOSTS[t] ? { type: t, hits: 100, boost: RAID_BOOSTS[t] } : { type: t, hits: 100 })), hits: body.length * 100,
          hitsMax: body.length * 100, ticksToLive: 1500, x, y, room: raidRoom, fatigue: 0, store: {}, storeCapacity: 0, name
        });
        names.push(name);
      }
      raidLog.push({ tick, bodies: raid.bodies, names });
      log(`Raid at tick ${tick}: ${raid.bodies.join(" + ")}${raid.room ? ` in ${raid.room}` : ""}`);
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
    // Long runs: keep the latest state on disk, so a crashed run can be resumed with --load-state
    if (SAVE_STATE && tick % 2000 === 0 && tick !== TICKS) await saveState(server, user.id, SAVE_STATE);
    lastTickAt = Date.now();
    if (tick % LOG_EVERY === 0 || tick === TICKS) {
      const w = await snapshot(server, user.id);
      const elapsed = (Date.now() - t0) / 1000;
      log(
        `tick ${tick}/${TICKS}`,
        `RCL ${w.rcl} (${w.progress}) | creeps ${w.creeps} | energy ${w.energy}/${w.energyCapacity}`,
        `| ext ${w.extensions} cont ${w.containers} roads ${w.roads}+${w.remoteRoads} sites ${w.sites} storage ${w.storage}`,
        `| cpu avg ${(cpuSum / Math.max(1, cpuSamples)).toFixed(2)}`,
        PRESET ? `| endgame ${JSON.stringify(w.endgame)} sites ${JSON.stringify(w.siteTypes)} terminal ${w.terminalEnergy} minerals ${JSON.stringify(w.minerals)} boosted ${JSON.stringify(w.boostedParts)}` : "",
        Object.keys(w.ownedRooms).length > 1 ? `| rooms ${JSON.stringify(w.ownedRooms)}` : "",
        enemy ? `| enemy ${JSON.stringify(await enemyStatus(server, enemy))}` : "",
        stronghold ? `| stronghold ${JSON.stringify(await strongholdStatus(server, stronghold))}` : "",
        leftovers ? `| leftovers ${JSON.stringify(await structuresLeft(server, leftovers))}` : "",
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

  if (SAVE_STATE) await saveState(server, user.id, SAVE_STATE);
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
  if (stronghold) console.log(`Stronghold ${stronghold.room}: ${JSON.stringify(await strongholdStatus(server, stronghold))}`);
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
  // RawMemory segments (engine: env hash memorySegments:<user>)
  const { env: envStorage } = server.common.storage;
  const segmentIds = Array.from({ length: 100 }, (_, i) => i);
  const segmentValues = (await envStorage.hmget(envStorage.keys.MEMORY_SEGMENTS + user.id, segmentIds)) || [];
  const segments = Object.fromEntries(segmentIds.map((id, i) => [id, segmentValues[i]]).filter(([, v]) => v));
  const segmentSize = Object.fromEntries(Object.entries(segments).map(([k, v]) => [k, String(v).length]));
  if (Object.keys(segmentSize).length)
    console.log(`Segments ${Object.entries(segmentSize).map(([k, v]) => `${k}:${v}`).join(", ")}`);
  if (flag("dump-memory") && OUT) {
    const dumpFile = OUT.replace(/\.json$/, "-memory.json");
    fs.mkdirSync(path.dirname(dumpFile), { recursive: true });
    fs.writeFileSync(dumpFile, JSON.stringify({ memory, segments }, null, 1));
    console.log(`Memory dump: ${dumpFile}`);
  }
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
  if (MIN_POINTS !== null) checks.push([`Points >= ${MIN_POINTS}`, world.points >= MIN_POINTS, `${world.points} points`]);
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
    stronghold: stronghold ? await strongholdStatus(server, stronghold) : null,
    leftovers: leftovers ? await structuresLeft(server, leftovers) : null,
    stats,
    errors: moduleErrors,
    consoleErrors,
    consoleErrorCount: errorCount,
    moduleState,
    memorySize,
    segmentSize
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
