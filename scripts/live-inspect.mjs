#!/usr/bin/env node
/**
 * Read-only inspection of the bot's history (src/utils/history.ts, RawMemory segments 6-7):
 * counter rates per 1000 ticks (empire and per room), the last spawns, the remote source balance,
 * module and role CPU, the remote sources excluded by their measured balance (src/remote/remoteBalance.ts).
 *
 * Usage:
 *   node scripts/live-inspect.mjs [--server main|pserver] [--shard shard0] [--config screeps.json]
 *   node scripts/live-inspect.mjs --file test-results/mockup-xxx-memory.json   # mockup --dump-memory
 *   options: --last <n> (snapshots in the trend columns, default 6), --spawns <n> (default 20),
 *            --match <regex> (empire counters to print, default the economy ones), --all (every counter)
 *
 * Live mode only reads (GET /api/user/memory, /api/user/memory-segment, /api/game/time; pserver also
 * POST /api/auth/signin to get a token). The token comes from screeps.json (`main.token`, or
 * `pserver.email` / `password`) and is never printed.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const flag = name => args.includes(`--${name}`);
if (flag("help") || flag("h")) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
  process.exit(0);
}

const SERVER = opt("server", "main");
const SHARD = opt("shard", "shard0");
const FILE = opt("file");
const LAST = Number(opt("last", 6));
const SPAWNS = Number(opt("spawns", 20));
const MATCH = new RegExp(
  opt("match", flag("all") ? "." : "^(work:|spawned:|idle:|builder:|deliver:|intents$|mining:|spawn:starved|throttled:|link:transfer|memory:deadCreep)")
);

// --- Data access ----------------------------------------------------------------------------------

function configPath() {
  const explicit = opt("config");
  if (explicit) return explicit;
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.resolve("screeps.json"), path.resolve(scriptDir, "..", "screeps.json")]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("screeps.json not found (use --config)");
}

function unzip(data) {
  if (typeof data === "string" && data.startsWith("gz:")) return JSON.parse(zlib.gunzipSync(Buffer.from(data.slice(3), "base64")).toString());
  return data;
}

async function liveSource() {
  const cfg = JSON.parse(fs.readFileSync(configPath(), "utf8"))[SERVER];
  if (!cfg) throw new Error(`no "${SERVER}" entry in screeps.json`);
  const base = `${cfg.protocol ?? "https"}://${cfg.hostname ?? "screeps.com"}:${cfg.port ?? 443}${(cfg.path ?? "/").replace(/\/$/, "")}/api`;
  let token = cfg.token;
  if (!token) {
    // Private server (screepsmod-auth): sign in with email / password
    const res = await fetch(`${base}/auth/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: cfg.email, password: cfg.password })
    });
    if (!res.ok) throw new Error(`sign in failed: HTTP ${res.status}`);
    token = (await res.json()).token;
  }
  const shardQuery = SERVER === "pserver" ? "" : `shard=${encodeURIComponent(SHARD)}`;
  const get = async (route, query = "") => {
    const q = [query, shardQuery].filter(Boolean).join("&");
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await fetch(`${base}${route}${q ? `?${q}` : ""}`, { headers: { "X-Token": token, "X-Username": token } });
      if (res.status === 429) {
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`GET ${route}: HTTP ${res.status}`);
      return res.json();
    }
    throw new Error(`GET ${route}: rate limited`);
  };
  const time = (await get("/game/time")).time;
  const memory = unzip((await get("/user/memory")).data) ?? {};
  const segments = {};
  for (const id of [6, 7]) segments[id] = (await get("/user/memory-segment", `segment=${id}`)).data ?? "";
  return { label: `${SERVER}${SERVER === "pserver" ? "" : ` ${SHARD}`}`, time, memory, segments };
}

function fileSource(file) {
  const dump = JSON.parse(fs.readFileSync(file, "utf8"));
  return { label: file, time: dump.memory?.stats?.tick, memory: dump.memory ?? {}, segments: dump.segments ?? {} };
}

// --- Decoding (mirror of src/utils/history.ts) ------------------------------------------------------

function decode(text, keys) {
  const values = {};
  if (!text) return values;
  text.split(",").forEach((part, i) => {
    if (part && keys[i] !== undefined) values[keys[i]] = parseInt(part, 36);
  });
  return values;
}

function decodeRoom(text, keys) {
  const [head, counters] = text.split("|");
  const [rcl, progress, energy, creeps] = head.split(",").map(v => parseInt(v, 36) || 0);
  return { rcl, progress, energy, creeps, counters: decode(counters, keys) };
}

function parseSegment(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function decodeHistory(segments) {
  const data = parseSegment(segments[6]) ?? { k: [], e: [] };
  const detail = parseSegment(segments[7]) ?? { s: [], r: [] };
  const keys = data.k ?? [];
  const entries = (data.e ?? []).map(e => ({
    tick: e.t,
    ticks: e.d,
    roomTicks: e.rd ?? e.d,
    cpu: e.cpu,
    bucket: e.bk,
    bucketMin: e.bm,
    counters: decode(e.c, keys),
    rooms: Object.fromEntries(Object.entries(e.r ?? {}).map(([room, text]) => [room, decodeRoom(text, data.rk ?? keys)]))
  }));
  const remotes = (detail.r ?? []).map(([tick, ticks, text]) => ({
    tick,
    ticks,
    sources: Object.fromEntries(
      (text ? text.split(";") : []).map(part => {
        const [key, values] = part.split("=");
        // harvested, delivered, cost (base 36), steady (1 / 0), home (since 2026-10-21), flags (lot J:
        // 1 selected the whole window, 2 threat, 4 container site built; history.ts windowFlags)
        const [harvested, delivered, cost, steady, home, flags] = values.split(",");
        const n = v => parseInt(v, 36) || 0;
        return [
          key,
          { harvested: n(harvested), delivered: n(delivered), cost: n(cost), steady: steady === "1", home: home ?? "", flags: flags ? n(flags) : undefined }
        ];
      })
    )
  }));
  const spawns = (detail.s ?? []).map(([tick, room, role, priority, weight, cost, parts, reason]) => ({ tick, room, role, priority, weight, cost, parts, reason }));
  return { entries, remotes, spawns, lastSnapshot: data.t, sizes: { history: (segments[6] ?? "").length, detail: (segments[7] ?? "").length } };
}

// --- Printing --------------------------------------------------------------------------------------

const per1k = (value, ticks) => (ticks > 0 ? (value * 1000) / ticks : 0);
function fmt(value) {
  const abs = Math.abs(value);
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${(value / 1e3).toFixed(1)}k`;
  if (abs >= 100) return `${Math.round(value)}`;
  if (abs >= 10) return value.toFixed(1);
  return value === 0 ? "0" : value.toFixed(2);
}
const pad = (text, width) => String(text).padStart(width);
const padEnd = (text, width) => String(text).padEnd(width);

function table(header, rows, left = [0]) {
  const widths = header.map((h, i) => Math.max(String(h).length, ...rows.map(r => String(r[i]).length)));
  const line = row => row.map((cell, i) => (left.includes(i) ? padEnd(cell, widths[i]) : pad(cell, widths[i]))).join("  ");
  console.log(line(header));
  for (const row of rows) console.log(line(row));
}

function section(title) {
  console.log(`\n== ${title}`);
}

function printEmpire(entries) {
  const recent = entries.slice(-LAST);
  const totalTicks = entries.reduce((s, e) => s + e.ticks, 0);
  section(`Empire, per 1000 ticks (last ${recent.length} snapshots, mean of ${entries.length} = ${totalTicks} ticks)`);
  table(
    ["tick", ...recent.map(e => e.tick)],
    [
      ["ticks", ...recent.map(e => e.ticks)],
      ["cpu avg", ...recent.map(e => e.cpu)],
      ["bucket (min)", ...recent.map(e => `${e.bucket} (${e.bucketMin})`)]
    ]
  );
  const keys = [...new Set(entries.flatMap(e => Object.keys(e.counters)))].filter(k => MATCH.test(k)).sort();
  const rows = keys.map(key => {
    const mean = per1k(
      entries.reduce((s, e) => s + (e.counters[key] ?? 0), 0),
      totalTicks
    );
    return [key, fmt(mean), ...recent.map(e => fmt(per1k(e.counters[key] ?? 0, e.ticks)))];
  });
  console.log("");
  table(["counter", "mean", ...recent.map(e => e.tick)], rows);
}

const ROOM_COLUMNS = ["harvest", "remoteHarvest", "build", "repair", "upgrade"];

function printRooms(entries) {
  const rooms = [...new Set(entries.flatMap(e => Object.keys(e.rooms)))].sort();
  for (const room of rooms) {
    section(`${room}, energy per 1000 ticks`);
    const rows = entries.slice(-LAST).flatMap(e => {
      const r = e.rooms[room];
      if (!r) return [];
      const spawn = Object.entries(r.counters)
        .filter(([k]) => k.startsWith("spawn:"))
        .reduce((s, [, v]) => s + v, 0);
      return [
        [
          e.tick,
          r.rcl,
          fmt(r.progress),
          fmt(r.energy),
          r.creeps,
          ...ROOM_COLUMNS.map(k => fmt(per1k(r.counters[k] ?? 0, e.roomTicks))),
          fmt(per1k(spawn, e.roomTicks)),
          e.roomTicks !== e.ticks ? `${e.roomTicks}t` : ""
        ]
      ];
    });
    table(["tick", "rcl", "progress", "storage", "creeps", "local", "remote", "build", "repair", "upgrade", "spawn", ""], rows);
    // Spawn energy and idle / fetch ticks by role, mean over every snapshot with the room
    const withRoom = entries.filter(e => e.rooms[room]);
    const ticks = withRoom.reduce((s, e) => s + e.roomTicks, 0);
    const sums = {};
    for (const e of withRoom) for (const [k, v] of Object.entries(e.rooms[room].counters)) sums[k] = (sums[k] ?? 0) + v;
    const list = prefix =>
      Object.entries(sums)
        .filter(([k]) => k.startsWith(prefix))
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k.slice(prefix.length)} ${fmt(per1k(v, ticks))}`)
        .join(", ");
    console.log(`spawn energy by role: ${list("spawn:") || "-"}`);
    console.log(`idle ticks by role:   ${list("idle:") || "-"}${sums["builder:fetch"] ? ` | builder fetch ${fmt(per1k(sums["builder:fetch"], ticks))}` : ""}`);
  }
}

function printSpawns(spawns) {
  const shown = spawns.slice(-SPAWNS);
  section(`Last ${shown.length} spawns (of ${spawns.length} kept)`);
  table(
    ["tick", "room", "role", "prio", "weight", "cost", "parts", "reason"],
    shown.map(s => [s.tick, s.room, s.role, s.priority, s.weight, s.cost, s.parts, s.reason ?? ""]),
    [0, 1, 2, 7]
  );
}

function printRemotes(remotes, memory) {
  if (remotes.length === 0) return;
  const ticks = remotes.reduce((s, r) => s + r.ticks, 0);
  const sums = {};
  for (const r of remotes) {
    for (const [key, v] of Object.entries(r.sources)) {
      const s = (sums[key] ??= { harvested: 0, delivered: 0, cost: 0, last: null });
      s.harvested += v.harvested;
      s.delivered += v.delivered;
      s.cost += v.cost;
    }
  }
  const last = remotes[remotes.length - 1];
  const selected = memory.remoteMining?.sources ?? {};
  section(`Remote balance, energy per 1000 ticks (mean of ${remotes.length} snapshots = ${ticks} ticks; last ${last.ticks} ticks)`);
  const rows = Object.entries(sums)
    .sort((a, b) => (selected[a[0]]?.homeRoom ?? "").localeCompare(selected[b[0]]?.homeRoom ?? "") || b[1].delivered - a[1].delivered)
    .map(([key, s]) => {
      const l = last.sources[key] ?? { harvested: 0, delivered: 0, cost: 0 };
      // Home: the selection's, else the last one the balance recorded (source no longer selected)
      const recorded = [...remotes].reverse().find(r => r.sources[key]?.home)?.sources[key].home;
      const home = selected[key]?.homeRoom ?? (recorded ? `${recorded} (dropped)` : "- (dropped)");
      const steady = remotes.slice(-3).filter(r => r.sources[key]?.steady).length;
      const states = remotes.slice(-3).map(r => windowState(r.sources[key])).join("");
      const net = s.delivered - s.cost;
      return [
        key,
        home,
        selected[key]?.travelTime ?? "-",
        fmt(per1k(s.harvested, ticks)),
        fmt(per1k(s.delivered, ticks)),
        fmt(per1k(s.cost, ticks)),
        fmt(per1k(net, ticks)),
        s.harvested > 0 ? `${Math.round((100 * s.delivered) / s.harvested)}%` : "-",
        fmt(per1k(l.delivered - l.cost, last.ticks)),
        `${steady}/3`,
        states
      ];
    });
  table(["source", "home", "travel", "harvested", "delivered", "cost", "net", "deliv/harv", "net last", "steady", "last 3"], rows, [0, 1]);
  console.log("steady: windows of the last 3 that measure the source cleanly (remote/remoteBalance.ts judges 3 of 3)");
  console.log(
    "last 3 (oldest first): S steady, U selected the whole window but not steady (the unsteady rule judges UUU), " +
      "T threat, B container site built, p selected part of the window, - absent, ? written without flags"
  );
}

/** One letter for a source's state in a balance window (see printRemotes) */
function windowState(balance) {
  if (!balance) return "-";
  if (balance.steady) return "S";
  if (balance.flags === undefined) return "?";
  if (balance.flags & 2) return "T";
  if (balance.flags & 4) return "B";
  return balance.flags & 1 ? "U" : "p";
}

function printExcluded(memory, time) {
  const excluded = memory.remoteExcluded ?? {};
  const keys = Object.keys(excluded);
  section(`Remote sources excluded by their measured balance (${keys.length})`);
  if (keys.length === 0) return;
  table(
    ["source", "home", "reason", "net/1000", "since", "until", "ticks left"],
    keys.map(key => {
      const e = excluded[key];
      return [key, e.home, e.reason ?? "measured", e.net, e.since, e.until, time !== undefined ? e.until - time : "?"];
    }),
    [0, 1]
  );
}

function printMilitary(memory, time) {
  const military = memory.military ?? {};
  const target = military.attack ? `${military.attack} (manual)` : military.target ? `${military.target.room} (${military.target.reason}, roi ${military.target.roi ?? "?"}, since ${military.target.since})` : "none";
  section(`Military: target ${target}`);
  const aggression = Object.entries(military.aggression ?? {}).map(([p, v]) => `${p} ${Math.round(v)}`);
  console.log(`aggression: ${aggression.join(", ") || "none"}`);
  const skipped = Object.entries(military.skipped ?? {});
  if (skipped.length > 0) table(["left alone", "why"], skipped, [0, 1]);
  const recent = (military.log ?? []).filter(e => time === undefined || time - e.time < 50000);
  if (recent.length > 0)
    table(["mission", "result", "tick", "losses", "squad"], recent.map(e => [e.room, e.result, e.time, e.losses, e.squad ?? ""]), [0, 1, 4]);
}

// Usable = close, cheap, fresh enough (src/highway/highwayIntel.ts decides it on each sighting)
function printHighway(memory, time) {
  const log = memory.highwayIntel;
  if (!log) return;
  const objects = Object.values(log.objects ?? {});
  const ticks = time !== undefined ? time - log.since : 0;
  const rate = kind => fmt((objects.filter(o => o.kind === kind && o.usable).length * 10000) / Math.max(1, ticks));
  section(`Highway since ${log.since} (${ticks} ticks): usable deposits ${rate("deposit")}, power banks ${rate("powerBank")} per 10000 ticks`);
  if (objects.length === 0) return;
  table(
    ["room", "kind", "usable", "home", "dist", "cooldown/power", "first seen", "decays in"],
    objects
      .sort((a, b) => a.firstSeen - b.firstSeen)
      .map(o => [
        o.room, o.kind === "deposit" ? o.type : "powerBank", o.usable ? "yes" : "no", o.home ?? "-", o.distance ?? "-",
        o.kind === "deposit" ? o.cooldown : o.power, o.firstSeen, time !== undefined ? o.decayAt - time : "?"
      ]),
    [0, 1, 2, 3]
  );
}

function printCpu(entries, memory) {
  const recent = entries.slice(-LAST);
  const ticks = recent.reduce((s, e) => s + e.ticks, 0);
  const sum = key => recent.reduce((s, e) => s + (e.counters[key] ?? 0), 0);
  const keys = [...new Set(recent.flatMap(e => Object.keys(e.counters)))];
  section(`CPU per tick (last ${recent.length} snapshots, ${ticks} ticks)`);
  const modules = keys
    .filter(k => k.startsWith("cpu:module:"))
    .map(k => [k.slice("cpu:module:".length), sum(k) / ticks, memory.moduleState?.[k.slice("cpu:module:".length)]?.avgCpu])
    .sort((a, b) => b[1] - a[1]);
  table(
    ["module", "cpu/tick", "avgCpu now"],
    modules.map(([name, cpu, now]) => [name, cpu.toFixed(3), now !== undefined ? now.toFixed(3) : "-"])
  );
  // cpu:<role> holds the role's code and its intents but moves (issued by the TrafficManager); with the
  // per role intent counters, code = cpu - 0.2 x (role intents - moves)
  const byRole = keys.some(k => k.startsWith("intents:role:"));
  const roles = keys
    .filter(k => k.startsWith("cpu:") && !k.startsWith("cpu:module:"))
    .map(k => {
      const role = k.slice(4);
      const creepTicks = sum(`creepTicks:${role}`);
      const per = value => (creepTicks > 0 ? value / creepTicks : 0);
      const moves = sum(`intents:move:${role}`);
      const actions = sum(`intents:role:${role}`) - moves;
      return [role, sum(k) / ticks, per(sum(k)), creepTicks / ticks, per(sum(k) - 0.2 * actions), per(actions), per(moves)];
    })
    .sort((a, b) => b[1] - a[1]);
  console.log("");
  table(
    ["role", "cpu/tick", "cpu/creep", "creeps", ...(byRole ? ["code/creep", "actions/creep", "moves/creep"] : [])],
    roles.map(([role, cpu, perCreep, creeps, code, actions, moves]) => [
      role,
      cpu.toFixed(3),
      perCreep.toFixed(3),
      creeps.toFixed(1),
      ...(byRole ? [code.toFixed(3), actions.toFixed(2), moves.toFixed(2)] : [])
    ])
  );
  if (byRole) console.log("code = cpu - 0.2 x actions (intents but moves, which the TrafficManager issues)");
}

// --- Main ------------------------------------------------------------------------------------------

try {
  const source = FILE ? fileSource(FILE) : await liveSource();
  const history = decodeHistory(source.segments);
  const { entries } = history;
  console.log(
    `${source.label} | tick ${source.time ?? "?"} | ${entries.length} snapshots` +
      (entries.length ? ` (${entries[0].tick} -> ${entries[entries.length - 1].tick})` : "") +
      ` | segments history ${history.sizes.history} chars, detail ${history.sizes.detail} chars` +
      ` | Memory ${JSON.stringify(source.memory).length} chars (stats ${JSON.stringify(source.memory.stats ?? {}).length})`
  );
  if (entries.length === 0) console.log("No snapshot yet (the first one comes 1000 ticks after the baseline).");
  else {
    printEmpire(entries);
    printRooms(entries);
    printCpu(entries, source.memory);
  }
  printRemotes(history.remotes, source.memory);
  printExcluded(source.memory, source.time);
  printMilitary(source.memory, source.time);
  printHighway(source.memory, source.time);
  printSpawns(history.spawns);
} catch (e) {
  console.error(`live-inspect: ${e.message}`);
  process.exit(1);
}
