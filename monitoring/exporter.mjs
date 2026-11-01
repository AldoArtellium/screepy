#!/usr/bin/env node
/**
 * Prometheus exporter of the bot's live state on the official server, plus live room maps.
 *
 * Two sources, chosen by cost:
 * - One websocket (wss://screeps.com/socket/websocket) pushes every tick: the CPU of the tick
 *   (`user:<id>/cpu`) and the object diffs of each tracked room (`room:<shard>/<room>`). It gives the
 *   creep positions, the hostiles and a decaying traffic heat without any HTTP request.
 * - HTTP polls only what the websocket can't give: Memory.stats (the memory channel pushes objects as
 *   "[object Object]") and /auth/me every POLL_SECONDS, Memory.remoteMining.sources (the remote rooms
 *   to track) every ROOMS_POLL_SECONDS. The official API allows 1440 GET /api/user/memory per day:
 *   120 s + 600 s use 864, leaving room for scripts/live-inspect.mjs.
 *
 * Serves on http://0.0.0.0:PORT: /metrics (Prometheus text), /map/<room>.svg, /map/world.svg,
 * /map/live.html?room=<room|world> (refreshes every 2 s, embedded by the Grafana dashboard) and
 * /map/rooms.json. Read-only; the token comes from screeps.json (`main.token`) or SCREEPS_TOKEN and is
 * never printed.
 *
 * Env: SCREEPS_CONFIG (./screeps.json), SCREEPS_SERVER (main), SCREEPS_SHARD (shard0), SCREEPS_TOKEN,
 *      POLL_SECONDS (120), ROOMS_POLL_SECONDS (600), EXTRA_ROOMS (comma list), HEAT_HALF_LIFE_TICKS
 *      (3000), PORT (9101).
 * Usage: node monitoring/exporter.mjs [--once]   (--once prints the HTTP metrics and exits)
 */
import fs from "node:fs";
import http from "node:http";
import zlib from "node:zlib";
import { Heat, decodeTerrain, renderRoomSvg, renderWorldSvg, summarize } from "./roomMap.mjs";

const SERVER = process.env.SCREEPS_SERVER ?? "main";
const SHARD = process.env.SCREEPS_SHARD ?? "shard0";
const POLL_SECONDS = Number(process.env.POLL_SECONDS ?? 120);
const ROOMS_POLL_SECONDS = Number(process.env.ROOMS_POLL_SECONDS ?? 600);
const EXTRA_ROOMS = (process.env.EXTRA_ROOMS ?? "").split(",").map(s => s.trim()).filter(Boolean);
const HEAT_HALF_LIFE_TICKS = Number(process.env.HEAT_HALF_LIFE_TICKS ?? 3000);
const PORT = Number(process.env.PORT ?? 9101);
const ONCE = process.argv.includes("--once");

function loadConfig() {
  const file = process.env.SCREEPS_CONFIG ?? "screeps.json";
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8"))[SERVER] ?? {} : {};
  const token = process.env.SCREEPS_TOKEN ?? cfg.token;
  if (!token) throw new Error(`no token: set SCREEPS_TOKEN or "${SERVER}.token" in ${file}`);
  const protocol = cfg.protocol ?? "https";
  const host = `${cfg.hostname ?? "screeps.com"}:${cfg.port ?? 443}${(cfg.path ?? "/").replace(/\/$/, "")}`;
  return { base: `${protocol}://${host}/api`, socket: `${protocol === "https" ? "wss" : "ws"}://${host}/socket/websocket`, token };
}

const { base, socket, token } = loadConfig();

async function get(route, query = "") {
  const res = await fetch(`${base}${route}${query ? `?${query}` : ""}`, { headers: { "X-Token": token, "X-Username": token } });
  if (!res.ok) throw new Error(`GET ${route}: HTTP ${res.status}`);
  return res.json();
}

function unzip(data) {
  if (typeof data === "string" && data.startsWith("gz:")) return JSON.parse(zlib.gunzipSync(Buffer.from(data.slice(3), "base64")).toString());
  return data;
}

// --- Prometheus text ------------------------------------------------------------------------------

const escape = v => String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

class Registry {
  constructor() {
    this.families = new Map();
  }
  add(name, type, help, value, labels = {}) {
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    let family = this.families.get(name);
    if (!family) this.families.set(name, (family = { type, help, samples: [] }));
    const l = Object.entries(labels).map(([k, v]) => `${k}="${escape(v)}"`).join(",");
    family.samples.push(`${name}${l ? `{${l}}` : ""} ${value}`);
  }
  render() {
    const out = [];
    for (const [name, f] of this.families) out.push(`# HELP ${name} ${f.help}`, `# TYPE ${name} ${f.type}`, ...f.samples);
    return out.join("\n") + "\n";
  }
}

function buildHttp(r, stats, me, scrape) {
  const shard = { shard: SHARD };
  r.add("screeps_up", "gauge", "1 when the last poll succeeded", scrape.ok ? 1 : 0, shard);
  r.add("screeps_poll_timestamp_seconds", "gauge", "Unix time of the last successful poll", scrape.at, shard);
  r.add("screeps_poll_errors_total", "counter", "Failed polls since the exporter started", scrape.errors, shard);
  if (!stats) return;

  r.add("screeps_tick", "gauge", "Game.time of the last recorded stats", stats.tick, shard);
  r.add("screeps_cpu_used", "gauge", "CPU used on the last recorded tick", stats.cpu, shard);
  r.add("screeps_cpu_avg", "gauge", "Exponential average of CPU used (alpha 0.02)", stats.cpuAvg, shard);
  r.add("screeps_cpu_max", "gauge", "Max CPU used since the last global reset", stats.cpuMax, shard);
  r.add("screeps_cpu_bucket", "gauge", "CPU bucket", stats.bucket, shard);
  r.add("screeps_memory_parse_cpu", "gauge", "CPU of the Memory parse on the last global", stats.memoryParse, shard);
  if (stats.heap) {
    r.add("screeps_heap_used_bytes", "gauge", "Isolate heap used", stats.heap.used, shard);
    r.add("screeps_heap_limit_bytes", "gauge", "Isolate heap limit", stats.heap.limit, shard);
  }
  for (const [name, value] of Object.entries(stats.counters ?? {})) {
    r.add("screeps_counter_total", "counter", "Memory.stats.counters (cumulative, reset with Memory)", value, { ...shard, name });
  }
  for (const [room, s] of Object.entries(stats.rooms ?? {})) {
    const l = { ...shard, room };
    r.add("screeps_room_rcl", "gauge", "Controller level", s.rcl, l);
    r.add("screeps_room_controller_progress", "gauge", "Controller progress", s.progress, l);
    r.add("screeps_room_energy_available", "gauge", "Spawn energy available", s.energyAvailable, l);
    r.add("screeps_room_energy_capacity", "gauge", "Spawn energy capacity", s.energyCapacity, l);
    r.add("screeps_room_creeps", "gauge", "Creeps whose home is the room", s.creeps, l);
    r.add("screeps_room_structures", "gauge", "Own structures", s.structures, l);
    r.add("screeps_room_construction_sites", "gauge", "Own construction sites", s.constructionSites, l);
    for (const [role, n] of Object.entries(s.roles ?? {})) r.add("screeps_room_role_creeps", "gauge", "Creeps per role in the room", n, { ...l, role });
  }
  if (me) {
    r.add("screeps_credits", "gauge", "Market credits", me.money, shard);
    r.add("screeps_gcl_points", "gauge", "GCL points", me.gcl, shard);
    r.add("screeps_cpu_limit", "gauge", "Account CPU limit", me.cpuShard?.[SHARD] ?? me.cpu, shard);
    r.add("screeps_power_points", "gauge", "Power processed (GPL points)", me.power, shard);
  }
}

function buildLive(r) {
  const shard = { shard: SHARD };
  r.add("screeps_ws_connected", "gauge", "1 while the websocket is authenticated", live.connected ? 1 : 0, shard);
  r.add("screeps_ws_reconnects_total", "counter", "Websocket reconnections since the exporter started", live.reconnects, shard);
  r.add("screeps_ws_cpu_ticks_total", "counter", "Ticks seen on the cpu channel", live.cpuTicks, shard);
  r.add("screeps_ws_cpu_used_total", "counter", "Sum of the CPU of every tick seen (rate / ticks rate = exact mean)", live.cpuSum, shard);
  r.add("screeps_ws_cpu_used", "gauge", "CPU of the last tick seen on the websocket", live.cpuLast, shard);
  r.add("screeps_ws_memory_bytes", "gauge", "Memory size of the last tick seen on the websocket", live.memoryLast, shard);
  r.add("screeps_ws_rooms_tracked", "gauge", "Rooms the websocket follows", live.rooms.size, shard);
  for (const [room, rs] of live.rooms) {
    const l = { ...shard, room };
    r.add("screeps_map_game_time", "gauge", "Game time of the last room update", rs.gameTime, l);
    r.add("screeps_map_room_updates_total", "counter", "Room updates received on the websocket", rs.updates, l);
    if (!rs.snapshot) continue;
    const counts = {};
    for (const c of rs.snapshot.creeps) {
      const key = c.mine ? "mine" : c.owner;
      counts[key] = (counts[key] ?? 0) + 1;
      const cl = { ...l, name: c.name, role: c.role, owner: c.owner, mine: c.mine ? "1" : "0" };
      r.add("screeps_creep_x", "gauge", "Creep x in the room (0-49)", c.x, cl);
      r.add("screeps_creep_y", "gauge", "Creep y in the room (0-49)", c.y, cl);
      r.add("screeps_creep_health", "gauge", "Share of the creep's body hits left", c.health, cl);
    }
    for (const [owner, n] of Object.entries(counts)) {
      r.add("screeps_map_creeps", "gauge", "Creeps visible in the room by owner (mine = ours)", n, { ...l, owner });
    }
    r.add("screeps_map_hostile_creeps", "gauge", "Creeps of other players and NPCs in the room", rs.snapshot.creeps.filter(c => !c.mine).length, l);
  }
}

// --- HTTP polls -----------------------------------------------------------------------------------

const state = { stats: undefined, me: undefined, remoteRooms: [], scrape: { ok: false, at: undefined, errors: 0 } };

async function poll() {
  try {
    const memory = await get("/user/memory", `path=stats&shard=${encodeURIComponent(SHARD)}`);
    const me = await get("/auth/me");
    state.stats = unzip(memory.data) ?? undefined;
    state.me = me;
    state.scrape = { ...state.scrape, ok: true, at: Math.floor(Date.now() / 1000) };
  } catch (err) {
    state.scrape = { ...state.scrape, ok: false, errors: state.scrape.errors + 1 };
    console.error(`${new Date().toISOString()} poll failed: ${err.message}`);
  }
  syncRooms();
  // The websocket needs the user id: start it on the first successful poll, not only at startup
  if (!ONCE && !live.ws && state.me?._id) connect();
}

async function pollRemoteRooms() {
  try {
    const memory = await get("/user/memory", `path=remoteMining.sources&shard=${encodeURIComponent(SHARD)}`);
    const sources = unzip(memory.data) ?? {};
    state.remoteRooms = [...new Set(Object.values(sources).map(s => s?.room).filter(r => typeof r === "string"))];
  } catch (err) {
    console.error(`${new Date().toISOString()} remote rooms poll failed: ${err.message}`);
  }
  syncRooms();
}

// --- Websocket: CPU and room objects every tick ---------------------------------------------------

const live = {
  ws: undefined,
  connected: false,
  reconnects: 0,
  cpuTicks: 0,
  cpuSum: 0,
  cpuLast: undefined,
  memoryLast: undefined,
  /** room -> { objects: Map id -> object, users, gameTime, updates, snapshot, terrain } */
  rooms: new Map(),
  heat: new Heat(HEAT_HALF_LIFE_TICKS)
};

const wantedRooms = () => new Set([...Object.keys(state.stats?.rooms ?? {}), ...state.remoteRooms, ...EXTRA_ROOMS]);
const roomChannel = room => `room:${SHARD}/${room}`;

function syncRooms() {
  const wanted = wantedRooms();
  for (const room of wanted) {
    if (live.rooms.has(room)) continue;
    live.rooms.set(room, { objects: new Map(), users: {}, gameTime: undefined, updates: 0, snapshot: undefined, terrain: undefined });
    if (live.connected) live.ws.send(`subscribe ${roomChannel(room)}`);
    loadTerrain(room);
  }
  for (const room of [...live.rooms.keys()]) {
    if (wanted.has(room)) continue;
    if (live.connected) live.ws.send(`unsubscribe ${roomChannel(room)}`);
    live.rooms.delete(room);
  }
}

async function loadTerrain(room) {
  try {
    const res = await get("/game/room-terrain", `room=${encodeURIComponent(room)}&shard=${encodeURIComponent(SHARD)}&encoded=1`);
    const rs = live.rooms.get(room);
    if (rs) rs.terrain = decodeTerrain(res.terrain?.[0]?.terrain);
  } catch (err) {
    console.error(`${new Date().toISOString()} terrain ${room} failed: ${err.message}`);
  }
}

/** Applies a room channel message: the first is the full room, the next ones diffs (null removes) */
function applyRoom(room, data) {
  const rs = live.rooms.get(room);
  if (!rs || !data) return;
  for (const [id, diff] of Object.entries(data.objects ?? {})) {
    if (diff === null) rs.objects.delete(id);
    else {
      const prev = rs.objects.get(id);
      rs.objects.set(id, prev ? Object.assign(prev, diff) : { _id: id, ...diff });
    }
  }
  Object.assign(rs.users, data.users ?? {});
  if (data.gameTime) rs.gameTime = data.gameTime;
  rs.updates++;
  rs.snapshot = { ...summarize(rs.objects.values(), rs.users, state.me?._id), at: Date.now(), gameTime: rs.gameTime };
  live.heat.record(room, rs.snapshot.creeps);
}

function connect() {
  const ws = new WebSocket(socket);
  live.ws = ws;
  ws.onopen = () => ws.send(`auth ${token}`);
  ws.onmessage = ev => {
    const msg = String(ev.data);
    if (msg.startsWith("auth ")) {
      if (!msg.startsWith("auth ok")) {
        console.error(`${new Date().toISOString()} websocket auth failed`);
        ws.close();
        return;
      }
      live.connected = true;
      ws.send(`subscribe user:${state.me._id}/cpu`);
      for (const [room, rs] of live.rooms) {
        rs.objects.clear(); // the server resends the full room after a subscribe
        ws.send(`subscribe ${roomChannel(room)}`);
      }
      return;
    }
    if (!msg.startsWith("[")) return;
    let channel, data;
    try {
      [channel, data] = JSON.parse(msg);
    } catch {
      return;
    }
    if (channel.endsWith("/cpu")) {
      live.cpuTicks++;
      live.cpuSum += data?.cpu ?? 0;
      live.cpuLast = data?.cpu;
      live.memoryLast = data?.memory;
    } else if (channel.startsWith("room:")) {
      applyRoom(channel.slice(channel.indexOf("/") + 1), data);
    }
  };
  ws.onclose = () => {
    const was = live.connected;
    live.connected = false;
    live.reconnects++;
    if (was) console.error(`${new Date().toISOString()} websocket closed, reconnecting`);
    setTimeout(connect, was ? 1000 : 15000);
  };
  ws.onerror = () => {};
}

// --- Maps -----------------------------------------------------------------------------------------

const roomView = room => {
  const rs = live.rooms.get(room);
  return { room, terrain: rs?.terrain, snapshot: rs?.snapshot, heat: live.heat.get(room) };
};

function livePage(target) {
  const src = `/map/${encodeURIComponent(target)}.svg`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>map</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:#0b0b0b}#m{width:100%;height:100%}#m svg{display:block;width:100%;height:100%}</style>
</head><body><div id="m"></div><script>
const m = document.getElementById("m");
async function tick() {
  try { const r = await fetch(${JSON.stringify(src)} + "?t=" + Date.now(), { cache: "no-store" }); if (r.ok) m.innerHTML = await r.text(); } catch {}
  setTimeout(tick, 2000);
}
tick();
</script></body></html>`;
}

function serveMap(url, res) {
  const path = decodeURIComponent(url.pathname.slice("/map/".length));
  if (path === "rooms.json") {
    const body = [...live.rooms].map(([room, rs]) => ({ room, gameTime: rs.gameTime, creeps: rs.snapshot?.creeps ?? [] }));
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
    return res.end(JSON.stringify(body));
  }
  if (path === "live.html") {
    const target = url.searchParams.get("room") || "world";
    if (!/^[A-Za-z0-9]+$/.test(target)) return res.writeHead(400).end();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(livePage(target));
  }
  const m = /^([A-Za-z0-9]+)\.svg$/.exec(path);
  if (!m) return res.writeHead(404).end();
  const scale = (fallback, max) => Math.min(max, Math.max(1, Number(url.searchParams.get("scale")) || fallback));
  const svg =
    m[1] === "world"
      ? renderWorldSvg([...live.rooms.keys()].map(roomView), scale(4, 20))
      : renderRoomSvg({ ...roomView(m[1]), scale: scale(10, 40) });
  res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
  res.end(svg);
}

// --- Main -----------------------------------------------------------------------------------------

await poll();
if (ONCE) {
  const r = new Registry();
  buildHttp(r, state.stats, state.me, state.scrape);
  process.stdout.write(r.render());
  process.exit(state.scrape.ok ? 0 : 1);
}
await pollRemoteRooms();
setInterval(poll, POLL_SECONDS * 1000);
setInterval(pollRemoteRooms, ROOMS_POLL_SECONDS * 1000);

http
  .createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/metrics") {
      const r = new Registry();
      buildHttp(r, state.stats, state.me, state.scrape);
      buildLive(r);
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      res.end(r.render());
    } else if (url.pathname.startsWith("/map/")) {
      serveMap(url, res);
    } else {
      res.writeHead(404).end();
    }
  })
  .listen(PORT, () => console.log(`exporter on :${PORT} (/metrics, /map/live.html), polling ${SERVER} ${SHARD} every ${POLL_SECONDS}s, websocket per tick`));
