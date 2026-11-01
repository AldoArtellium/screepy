/**
 * Room maps of the Grafana exporter (monitoring/exporter.mjs): pure helpers that turn the room
 * objects of the official server (websocket room channel or /api/game/room-objects) into creep
 * summaries, a decaying traffic heat and SVG maps of one room or of every tracked room.
 * Offline check: node tests/roomMap/run.mjs
 */

const SIZE = 50;

/** World coordinates of a room: W and N negative (W0 is x -1), E and S from 0; undefined if not a world room */
export function roomCoords(name) {
  const m = /^([WE])(\d+)([NS])(\d+)$/.exec(name);
  if (!m) return undefined;
  const x = m[1] === "W" ? -Number(m[2]) - 1 : Number(m[2]);
  const y = m[3] === "N" ? -Number(m[4]) - 1 : Number(m[4]);
  return { x, y };
}

/** Encoded terrain (2500 digits) to 0 plain, 1 wall, 2 swamp per tile (y * 50 + x); undefined if malformed */
export function decodeTerrain(encoded) {
  if (typeof encoded !== "string" || encoded.length !== SIZE * SIZE) return undefined;
  const t = new Uint8Array(SIZE * SIZE);
  for (let i = 0; i < t.length; i++) {
    const v = encoded.charCodeAt(i) - 48;
    t[i] = v & 1 ? 1 : v & 2 ? 2 : 0;
  }
  return t;
}

/** Role of one of our creeps from its name (role_suffix, see the spawn manager) */
export function creepRole(name) {
  const i = name.lastIndexOf("_");
  return i > 0 ? name.slice(0, i) : name;
}

/** Creeps and structures of a room's objects; `users` maps user ids to { username } */
export function summarize(objects, users, myId) {
  const creeps = [];
  const structures = [];
  for (const o of objects) {
    if (!o || typeof o.x !== "number" || typeof o.y !== "number") continue;
    if (o.type === "creep") {
      const mine = o.user === myId;
      const parts = Array.isArray(o.body) ? o.body : [];
      const hits = parts.reduce((s, p) => s + (p.hits ?? 0), 0);
      creeps.push({
        name: String(o.name ?? o._id ?? "?"),
        x: o.x,
        y: o.y,
        mine,
        role: mine ? creepRole(String(o.name ?? "")) : "hostile",
        owner: users?.[o.user]?.username ?? String(o.user ?? "?"),
        health: parts.length ? hits / (parts.length * 100) : 1,
        parts: parts.length
      });
    } else if (o.type !== "powerCreep" && o.type !== "tombstone" && o.type !== "ruin" && o.type !== "energy" && o.type !== "resource") {
      structures.push({ type: o.type, x: o.x, y: o.y, mine: o.user === undefined || o.user === myId });
    }
  }
  return { creeps, structures };
}

/** Per-room traffic of our creeps, decayed so a tile loses half its weight after `halfLife` records */
export class Heat {
  constructor(halfLife) {
    this.factor = Math.pow(0.5, 1 / halfLife);
    this.rooms = new Map();
  }
  record(room, creeps) {
    let h = this.rooms.get(room);
    if (!h) this.rooms.set(room, (h = new Float32Array(SIZE * SIZE)));
    for (let i = 0; i < h.length; i++) h[i] *= this.factor;
    for (const c of creeps) if (c.mine) h[c.y * SIZE + c.x] += 1;
  }
  get(room) {
    return this.rooms.get(room);
  }
}

// --- SVG ------------------------------------------------------------------------------------------

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const TERRAIN = ["#2b2b2b", "#111111", "#283a1d"];
const STRUCTURE = {
  spawn: ["#ffe56d", 0.9, "c"],
  extension: ["#d8d8a8", 0.5, "c"],
  tower: ["#9fc2ff", 0.8, "r"],
  storage: ["#e0a040", 0.9, "r"],
  terminal: ["#c070ff", 0.9, "r"],
  link: ["#7ad0ff", 0.6, "r"],
  lab: ["#ff8bd1", 0.7, "c"],
  container: ["#a07040", 0.6, "r"],
  extractor: ["#6fd3c0", 0.9, "c"],
  factory: ["#ffaa66", 0.9, "r"],
  observer: ["#a0a0ff", 0.6, "c"],
  powerSpawn: ["#ff5050", 0.9, "c"],
  nuker: ["#55ff55", 0.9, "r"],
  controller: ["#bbbbbb", 1, "c"],
  source: ["#ffd400", 0.8, "r"],
  mineral: ["#4fe0c8", 0.8, "c"],
  constructionSite: ["#55ff55", 0.4, "c"],
  invaderCore: ["#ff3030", 1, "r"],
  keeperLair: ["#803030", 1, "r"],
  portal: ["#4f7fff", 1, "c"]
};

/** Stable colour per role, hostiles red, NPCs (Invader, Source Keeper) orange */
function creepColour(c) {
  if (!c.mine) return c.owner === "Invader" || c.owner === "Source Keeper" ? "#ff9020" : "#ff2020";
  let h = 0;
  for (const ch of c.role) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h},80%,65%)`;
}

function roomBody(room, terrain, snapshot, heat, s) {
  const out = [];
  out.push(`<rect width="${SIZE * s}" height="${SIZE * s}" fill="${TERRAIN[0]}"/>`);
  if (terrain) {
    for (let y = 0; y < SIZE; y++) {
      // One rect per run of the same non-plain terrain on a row keeps the SVG small
      let x = 0;
      while (x < SIZE) {
        const t = terrain[y * SIZE + x];
        let end = x + 1;
        while (end < SIZE && terrain[y * SIZE + end] === t) end++;
        if (t) out.push(`<rect x="${x * s}" y="${y * s}" width="${(end - x) * s}" height="${s}" fill="${TERRAIN[t]}"/>`);
        x = end;
      }
    }
  }
  if (heat) {
    let max = 0;
    for (const v of heat) if (v > max) max = v;
    if (max > 0) {
      out.push(`<g class="heat" fill="#ff3d00">`);
      for (let i = 0; i < heat.length; i++) {
        const a = Math.sqrt(heat[i] / max) * 0.7;
        if (a >= 0.03) out.push(`<rect x="${(i % SIZE) * s}" y="${Math.floor(i / SIZE) * s}" width="${s}" height="${s}" fill-opacity="${a.toFixed(2)}"/>`);
      }
      out.push(`</g>`);
    }
  }
  if (snapshot) {
    for (const st of snapshot.structures) {
      const cx = (st.x + 0.5) * s;
      const cy = (st.y + 0.5) * s;
      if (st.type === "road") {
        out.push(`<rect x="${(st.x + 0.35) * s}" y="${(st.y + 0.35) * s}" width="${0.3 * s}" height="${0.3 * s}" fill="#777"/>`);
      } else if (st.type === "constructedWall") {
        out.push(`<rect x="${st.x * s}" y="${st.y * s}" width="${s}" height="${s}" fill="#000" stroke="#444" stroke-width="${0.1 * s}"/>`);
      } else if (st.type === "rampart") {
        out.push(`<rect x="${st.x * s}" y="${st.y * s}" width="${s}" height="${s}" fill="${st.mine ? "#2fbf4a" : "#bf2f2f"}" fill-opacity="0.35"/>`);
      } else {
        const [fill, size, shape] = STRUCTURE[st.type] ?? ["#888", 0.6, "r"];
        const stroke = st.mine ? "" : ` stroke="#ff2020" stroke-width="${0.15 * s}"`;
        if (shape === "c") out.push(`<circle cx="${cx}" cy="${cy}" r="${(size * s) / 2}" fill="${fill}"${stroke}/>`);
        else out.push(`<rect x="${cx - (size * s) / 2}" y="${cy - (size * s) / 2}" width="${size * s}" height="${size * s}" fill="${fill}"${stroke}/>`);
      }
    }
    for (const c of snapshot.creeps) {
      const title = `${c.name} (${c.mine ? c.role : c.owner}) ${c.x},${c.y} ${Math.round(c.health * 100)}%`;
      out.push(
        `<circle class="creep${c.mine ? "" : " hostile"}" cx="${(c.x + 0.5) * s}" cy="${(c.y + 0.5) * s}" r="${0.42 * s}" fill="${creepColour(c)}" stroke="${c.health < 1 ? "#ff0" : "#000"}" stroke-width="${0.12 * s}"><title>${esc(title)}</title></circle>`
      );
    }
  }
  const mine = snapshot?.creeps.filter(c => c.mine).length ?? 0;
  const hostile = snapshot ? snapshot.creeps.length - mine : 0;
  const label = `${room}${snapshot ? `  ${mine} creeps${hostile ? `  ${hostile} hostiles` : ""}` : "  no data"}`;
  const fs = Math.max(8, 2.2 * s);
  out.push(`<text x="${s}" y="${s + fs}" font-family="monospace" font-size="${fs}" fill="${hostile ? "#ff6060" : "#ffffff"}" stroke="#000" stroke-width="${fs / 8}" paint-order="stroke">${esc(label)}</text>`);
  return out.join("");
}

/** SVG of one room: terrain, traffic heat, structures, creeps (hover title: name, role or owner, health) */
export function renderRoomSvg({ room, terrain, snapshot, heat, scale = 10 }) {
  const px = SIZE * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${px} ${px}" width="${px}" height="${px}">${roomBody(room, terrain, snapshot, heat, scale)}</svg>`;
}

/** SVG of every tracked room placed by its world coordinates (empty rooms of the bounding box left dark) */
export function renderWorldSvg(rooms, scale = 4) {
  const placed = rooms.map(r => ({ ...r, c: roomCoords(r.room) })).filter(r => r.c);
  const px = SIZE * scale;
  if (placed.length === 0) return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${px} ${px}" width="${px}" height="${px}"/>`;
  const minX = Math.min(...placed.map(r => r.c.x));
  const minY = Math.min(...placed.map(r => r.c.y));
  const w = (Math.max(...placed.map(r => r.c.x)) - minX + 1) * px;
  const h = (Math.max(...placed.map(r => r.c.y)) - minY + 1) * px;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#0b0b0b"/>`];
  for (const r of placed) {
    parts.push(`<g transform="translate(${(r.c.x - minX) * px},${(r.c.y - minY) * px})">${roomBody(r.room, r.terrain, r.snapshot, r.heat, scale)}`);
    parts.push(`<rect width="${px}" height="${px}" fill="none" stroke="#555" stroke-width="1"/></g>`);
  }
  parts.push("</svg>");
  return parts.join("");
}
