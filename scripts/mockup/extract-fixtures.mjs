#!/usr/bin/env node
/**
 * Extract real rooms (terrain + natural objects) from the local private server into fixtures
 * for the mockup runner. Read-only on the server (mongo via the admin CLI).
 *
 * Usage: node scripts/mockup/extract-fixtures.mjs [W7N3 W9N5 W1N3 ...]
 * Writes scripts/mockup/fixtures/<room>.json with the room and its 8 neighbours.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, cli } from "../pserver-lib.mjs";

const rooms = process.argv.slice(2);
if (rooms.length === 0) rooms.push("W7N3", "W9N5", "W1N3");

/** Natural objects only: anything built/dropped by players is left out */
const KEEP = {
  source: ["energy", "energyCapacity"],
  mineral: ["mineralType", "mineralAmount", "density"],
  controller: [],
  keeperLair: [],
  portal: ["destination"],
  deposit: ["depositType"],
  powerBank: ["power", "hits", "hitsMax"]
};

function parse(name) {
  const m = /^([WE])(\d+)([NS])(\d+)$/.exec(name);
  if (!m) throw new Error(`Bad room name ${name}`);
  return { h: m[1], x: Number(m[2]), v: m[3], y: Number(m[4]) };
}

/** The 3x3 block around a room (W/E and N/S crossings handled) */
function neighbourhood(name) {
  const { h, x, v, y } = parse(name);
  // Signed world coordinates: E0 = 0, W0 = -1
  const wx = h === "E" ? x : -x - 1;
  const wy = v === "S" ? y : -y - 1;
  const out = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = wx + dx;
      const ny = wy + dy;
      out.push(`${nx >= 0 ? "E" + nx : "W" + (-nx - 1)}${ny >= 0 ? "S" + ny : "N" + (-ny - 1)}`);
    }
  }
  return out;
}

const query = (expr) => JSON.parse(cli(`${expr}.then(r=>JSON.stringify(r))`));

mkdirSync(join(ROOT, "scripts", "mockup", "fixtures"), { recursive: true });
for (const room of rooms) {
  const names = neighbourhood(room);
  const roomDocs = query(`storage.db.rooms.find({_id:{$in:${JSON.stringify(names)}}})`);
  const terrains = query(`storage.db['rooms.terrain'].find({room:{$in:${JSON.stringify(names)}}})`);
  const objects = query(
    `storage.db['rooms.objects'].find({room:{$in:${JSON.stringify(names)}},type:{$in:${JSON.stringify(Object.keys(KEEP))}}})`
  );
  const fixture = { room, extractedAt: new Date().toISOString(), rooms: {} };
  for (const name of names) {
    const doc = roomDocs.find((r) => r._id === name);
    const terrain = terrains.find((t) => t.room === name);
    if (!doc || !terrain) continue;
    fixture.rooms[name] = {
      status: doc.status,
      sourceKeepers: !!doc.sourceKeepers,
      ...(doc.invaderGoal && { invaderGoal: doc.invaderGoal }),
      terrain: terrain.terrain,
      objects: objects
        .filter((o) => o.room === name)
        .sort((a, b) => a.type.localeCompare(b.type) || a.x - b.x || a.y - b.y)
        .map((o) => {
          const attrs = Object.fromEntries(KEEP[o.type].filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
          if (o.type === "controller") attrs.level = 0; // unowned, unreserved
          if (o.type === "source") attrs.energy = attrs.energyCapacity; // full, regen not started
          return { type: o.type, x: o.x, y: o.y, ...attrs };
        })
    };
  }
  if (!fixture.rooms[room]) throw new Error(`Room ${room} not found on the server`);
  const file = join(ROOT, "scripts", "mockup", "fixtures", `${room}.json`);
  writeFileSync(file, JSON.stringify(fixture, null, 1) + "\n");
  console.log(`${room}: ${Object.keys(fixture.rooms).length} rooms -> ${file}`);
}
