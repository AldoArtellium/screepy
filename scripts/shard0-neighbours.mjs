#!/usr/bin/env node
/**
 * Read-only look at the other players around our rooms on the official server: who owns or reserves
 * the rooms within --radius of ours (map-stats), each player's GCL, room count and control points per
 * leaderboard season, and a summary of the room objects of the rooms given with --rooms (controller,
 * structures, stores over 1000, dropped energy, creeps by owner with their parts and a few names).
 *
 * Usage:
 *   node scripts/shard0-neighbours.mjs [--shard shard0] [--radius 5] [--config screeps.json]
 *   options: --rooms W25N2,W26N1 (room objects to summarise), --players a,b (players beyond the
 *            neighbours), --gcl-ticks <n> (sample every player's GCL twice, n ticks apart, for control
 *            points per tick), --save <file.json> (write everything fetched)
 *
 * Only GET /api/auth/me, /api/user/rooms, /api/user/find, /api/leaderboard/find, /api/game/time,
 * /api/game/room-objects and POST /api/game/map-stats (a read). The token comes from screeps.json
 * (`main.token`) and is never printed. Backs off on HTTP 429 (x-ratelimit-reset).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
if (args.includes("--help") || args.includes("-h")) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
  process.exit(0);
}
const SHARD = opt("shard", "shard0");
const RADIUS = Number(opt("radius", 5));
const list = name => (opt(name, "") || "").split(",").filter(Boolean);

function configPath() {
  const explicit = opt("config");
  if (explicit) return explicit;
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.resolve("screeps.json"), path.resolve(scriptDir, "..", "screeps.json")]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("screeps.json not found (use --config)");
}

const cfg = JSON.parse(fs.readFileSync(configPath(), "utf8")).main;
if (!cfg?.token) throw new Error('no "main.token" in screeps.json');
const base = `${cfg.protocol ?? "https"}://${cfg.hostname ?? "screeps.com"}:${cfg.port ?? 443}${(cfg.path ?? "/").replace(/\/$/, "")}/api`;

async function call(route, { query = "", body } = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(`${base}${route}${query ? `?${query}` : ""}`, {
      method: body ? "POST" : "GET",
      headers: { "X-Token": cfg.token, "X-Username": cfg.token, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 429) {
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const wait = reset ? Math.max(1000, reset * 1000 - Date.now()) : 3000 * (attempt + 1);
      console.error(`rate limited on ${route}, waiting ${Math.round(wait / 1000)} s`);
      await new Promise(r => setTimeout(r, Math.min(wait, 120000)));
      continue;
    }
    if (!res.ok) throw new Error(`${route}: HTTP ${res.status}`);
    return res.json();
  }
  throw new Error(`${route}: rate limited`);
}

// --- Room names ---------------------------------------------------------------------------------------

function parseRoom(name) {
  const m = /^([WE])(\d+)([NS])(\d+)$/.exec(name);
  return { x: m[1] === "W" ? Number(m[2]) : -Number(m[2]) - 1, y: m[3] === "N" ? Number(m[4]) : -Number(m[4]) - 1 };
}
const roomName = (x, y) => `${x >= 0 ? `W${x}` : `E${-x - 1}`}${y >= 0 ? `N${y}` : `S${-y - 1}`}`;
const gclLevel = points => Math.floor(Math.pow(points / 1e6, 1 / 2.4)) + 1;
const short = n => (Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

// --- Neighbours ---------------------------------------------------------------------------------------

const me = await call("/auth/me");
const myRooms = (await call("/user/rooms", { query: `id=${me._id}` })).shards?.[SHARD] ?? [];
const time = (await call("/game/time", { query: `shard=${SHARD}` })).time;
console.log(`${SHARD} tick ${time} | ${me.username} GCL ${gclLevel(me.gcl)} (${short(me.gcl)}) | rooms ${myRooms.join(" ")}`);

const area = new Set();
for (const room of myRooms) {
  const { x, y } = parseRoom(room);
  for (let dx = -RADIUS; dx <= RADIUS; dx++) for (let dy = -RADIUS; dy <= RADIUS; dy++) area.add(roomName(x + dx, y + dy));
}
const stats = await call("/game/map-stats", { body: { rooms: [...area], statName: "owner0", shard: SHARD } });
const owners = {};
for (const [room, s] of Object.entries(stats.stats ?? {})) {
  if (!s.own) continue;
  const user = stats.users?.[s.own.user]?.username ?? s.own.user;
  (owners[user] ??= []).push(`${room}:${s.own.level || "res"}`);
}
console.log(`\n== Owners and reservations within ${RADIUS} rooms (room:RCL, res = reserved)`);
for (const [user, rooms] of Object.entries(owners).sort((a, b) => b[1].length - a[1].length)) console.log(`${user.padEnd(18)} ${rooms.join(" ")}`);

// --- Players ------------------------------------------------------------------------------------------

const names = [...new Set([me.username, ...Object.keys(owners).filter(u => !["Invader", "Source Keeper"].includes(u)), ...list("players")])];
const players = {};
console.log("\n== Players: GCL, rooms, control points per season (last 4)");
for (const name of names) {
  const user = (await call("/user/find", { query: `username=${encodeURIComponent(name)}` })).user;
  if (!user) continue;
  const rooms = (await call("/user/rooms", { query: `id=${user._id}` })).shards ?? {};
  const seasons = ((await call("/leaderboard/find", { query: `mode=world&username=${encodeURIComponent(name)}` })).list ?? [])
    .sort((a, b) => a.season.localeCompare(b.season));
  players[name] = { gcl: user.gcl, rooms, seasons };
  const shards = Object.entries(rooms).filter(([, r]) => r.length).map(([s, r]) => `${s}:${r.length}`).join(" ");
  const recent = seasons.slice(-4).map(s => `${s.season} ${short(s.score)} #${s.rank}`).join(" | ");
  console.log(`${name.padEnd(18)} GCL ${String(gclLevel(user.gcl)).padStart(2)} ${short(user.gcl).padStart(6)}  ${shards.padEnd(12)} since ${seasons[0]?.season ?? "-"}  ${recent}`);
}

const gclTicks = Number(opt("gcl-ticks", 0));
if (gclTicks > 0) {
  const sample = async () => ({
    time: (await call("/game/time", { query: `shard=${SHARD}` })).time,
    gcl: Object.fromEntries(await Promise.all(Object.keys(players).map(async n => [n, (await call("/user/find", { query: `username=${encodeURIComponent(n)}` })).user.gcl])))
  });
  const first = await sample();
  let last = first;
  while (last.time - first.time < gclTicks) {
    await new Promise(r => setTimeout(r, 60000));
    last = await sample();
  }
  console.log(`\n== Control points per tick over ${last.time - first.time} ticks`);
  for (const n of Object.keys(players)) console.log(`${n.padEnd(18)} ${((last.gcl[n] - first.gcl[n]) / (last.time - first.time)).toFixed(1)}`);
}

// --- Room objects -------------------------------------------------------------------------------------

const IGNORED = new Set(["source", "mineral", "controller", "constructionSite", "tombstone", "ruin", "energy", "resource", "deposit"]);
const summaries = {};
const roomsToShow = list("rooms");
if (roomsToShow.length) console.log("\n== Room objects");
for (const room of roomsToShow) {
  const res = await call("/game/room-objects", { query: `room=${room}&shard=${SHARD}` });
  const users = Object.fromEntries(Object.entries(res.users ?? {}).map(([id, u]) => [id, u.username]));
  const objects = res.objects ?? [];
  const controller = objects.find(o => o.type === "controller");
  const structures = {};
  const stores = {};
  const creeps = {};
  let dropped = 0;
  let sites = 0;
  for (const o of objects) {
    if (o.type === "creep" || o.type === "powerCreep") {
      const c = (creeps[users[o.user] ?? o.user] ??= { count: 0, parts: {}, names: [] });
      c.count++;
      for (const part of o.body ?? []) c.parts[part.type] = (c.parts[part.type] ?? 0) + 1;
      if (c.names.length < 5) c.names.push(`${o.name}[${o.body?.length ?? "?"}]`);
    } else if (o.type === "energy" || o.type === "resource") dropped += o.energy ?? o.amount ?? 0;
    else if (o.type === "constructionSite") sites++;
    else if (!IGNORED.has(o.type)) {
      structures[o.type] = (structures[o.type] ?? 0) + 1;
      if (o.store && ["storage", "terminal", "factory"].includes(o.type)) {
        stores[o.type] = Object.entries(o.store).filter(([, v]) => v > 1000).map(([k, v]) => `${k}:${short(v)}`).join(",");
      }
    }
  }
  const reservation = controller?.reservation ? `res:${users[controller.reservation.user] ?? controller.reservation.user}` : "-";
  const owner = controller?.user ? users[controller.user] ?? controller.user : reservation;
  summaries[room] = { owner, level: controller?.level, progress: controller?.progress, structures, stores, creeps, dropped, sites };
  console.log(`${room} ${owner} RCL ${controller?.level ?? "-"} progress ${controller?.progress ?? "-"} | dropped ${dropped} | sites ${sites}`);
  console.log(`  structures ${Object.entries(structures).map(([k, v]) => `${k} ${v}`).join(", ") || "-"}`);
  for (const [type, content] of Object.entries(stores)) console.log(`  ${type} ${content || "-"}`);
  for (const [user, c] of Object.entries(creeps)) {
    const parts = Object.entries(c.parts).map(([k, v]) => `${k} ${v}`).join(", ");
    console.log(`  ${user}: ${c.count} creeps, ${Object.values(c.parts).reduce((a, b) => a + b, 0)} parts (${parts}) e.g. ${c.names.join(" ")}`);
  }
}

const save = opt("save");
if (save) fs.writeFileSync(save, JSON.stringify({ time, owners, players, rooms: summaries }, null, 1));
