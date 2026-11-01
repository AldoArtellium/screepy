#!/usr/bin/env node
/**
 * Prometheus exporter of the bot's live stats (Memory.stats, src/utils/stats.ts) on the official server.
 *
 * Polls GET /api/user/memory?path=stats and GET /api/auth/me every POLL_SECONDS and serves the last
 * values as Prometheus text on http://0.0.0.0:PORT/metrics. Read-only; the token comes from
 * screeps.json (`main.token`) or SCREEPS_TOKEN and is never printed.
 *
 * The official API allows 1440 GET /api/user/memory per day: the default 120 s poll uses 720, leaving
 * room for scripts/live-inspect.mjs.
 *
 * Env: SCREEPS_CONFIG (default ./screeps.json), SCREEPS_SERVER (main), SCREEPS_SHARD (shard0),
 *      SCREEPS_TOKEN (overrides the config), POLL_SECONDS (120), PORT (9101).
 * Usage: node monitoring/exporter.mjs [--once]   (--once prints the metrics and exits)
 */
import fs from "node:fs";
import http from "node:http";
import zlib from "node:zlib";

const SERVER = process.env.SCREEPS_SERVER ?? "main";
const SHARD = process.env.SCREEPS_SHARD ?? "shard0";
const POLL_SECONDS = Number(process.env.POLL_SECONDS ?? 120);
const PORT = Number(process.env.PORT ?? 9101);

function loadConfig() {
  const file = process.env.SCREEPS_CONFIG ?? "screeps.json";
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8"))[SERVER] ?? {} : {};
  const token = process.env.SCREEPS_TOKEN ?? cfg.token;
  if (!token) throw new Error(`no token: set SCREEPS_TOKEN or "${SERVER}.token" in ${file}`);
  const base = `${cfg.protocol ?? "https"}://${cfg.hostname ?? "screeps.com"}:${cfg.port ?? 443}${(cfg.path ?? "/").replace(/\/$/, "")}/api`;
  return { base, token };
}

const { base, token } = loadConfig();

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

function build(stats, me, scrape) {
  const r = new Registry();
  const shard = { shard: SHARD };
  r.add("screeps_up", "gauge", "1 when the last poll succeeded", scrape.ok ? 1 : 0, shard);
  r.add("screeps_poll_timestamp_seconds", "gauge", "Unix time of the last successful poll", scrape.at, shard);
  r.add("screeps_poll_errors_total", "counter", "Failed polls since the exporter started", scrape.errors, shard);
  if (!stats) return r.render();

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
  if (stats.remote) {
    // No cap: report the rooms mined, so the cap line meets the rooms line
    r.add("screeps_remote_max_rooms", "gauge", "Remote rooms the CPU budget allows (rooms mined when uncapped)", stats.remote.maxRooms ?? stats.remote.rooms, shard);
    r.add("screeps_remote_rooms", "gauge", "Remote rooms mined", stats.remote.rooms, shard);
    r.add("screeps_remote_room_cpu", "gauge", "Measured CPU per tick of one remote room", stats.remote.roomCpu, shard);
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
    r.add("screeps_room_stored_energy", "gauge", "Energy in the storage and terminal", s.storedEnergy, l);
    for (const [role, n] of Object.entries(s.roles ?? {})) r.add("screeps_room_role_creeps", "gauge", "Creeps per role in the room", n, { ...l, role });
  }
  if (me) {
    r.add("screeps_credits", "gauge", "Market credits", me.money, shard);
    r.add("screeps_gcl_points", "gauge", "GCL points", me.gcl, shard);
    r.add("screeps_cpu_limit", "gauge", "Account CPU limit", me.cpuShard?.[SHARD] ?? me.cpu, shard);
    r.add("screeps_power_points", "gauge", "Power processed (GPL points)", me.power, shard);
  }
  return r.render();
}

// --- Poll loop ------------------------------------------------------------------------------------

const state = { stats: undefined, me: undefined, scrape: { ok: false, at: undefined, errors: 0 } };

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
}

await poll();
if (process.argv.includes("--once")) {
  process.stdout.write(build(state.stats, state.me, state.scrape));
  process.exit(state.scrape.ok ? 0 : 1);
}
setInterval(poll, POLL_SECONDS * 1000);
http
  .createServer((req, res) => {
    if (req.url === "/metrics") {
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      res.end(build(state.stats, state.me, state.scrape));
    } else {
      res.writeHead(404).end();
    }
  })
  .listen(PORT, () => console.log(`exporter on :${PORT}/metrics, polling ${SERVER} ${SHARD} every ${POLL_SECONDS}s`));
