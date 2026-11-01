#!/usr/bin/env node
/**
 * Generates the Grafana dashboard of monitoring/exporter.mjs metrics.
 * Usage: node monitoring/gen-dashboard.mjs monitoring/grafana/dashboards/screepy-shard0.json
 *
 * Counters are cumulative per tick of the game: rates are divided by the tick rate so panels read
 * "per tick" (CPU) or "per 1000 ticks" (economy), independent of the real-time tick duration.
 */
import fs from "node:fs";

const ds = { type: "prometheus", uid: "prometheus" };
const W = "[15m]";
const TICK = `scalar(rate(screeps_tick${W}))`;
let id = 0;
const panels = [];
let y = 0;

const row = title => {
  panels.push({ type: "row", title, id: ++id, collapsed: false, gridPos: { h: 1, w: 24, x: 0, y }, panels: [] });
  y += 1;
};
const target = (expr, legend, refId = "A", extra = {}) => ({ datasource: ds, expr, legendFormat: legend, refId, ...extra });
const perKiloTick = filter => `1000 * sum by (name) (rate(screeps_counter_total{name=~"${filter}"}${W})) / ${TICK}`;

function stat(title, expr, x, w, unit = "none", extra = {}) {
  panels.push({
    type: "stat",
    title,
    id: ++id,
    datasource: ds,
    gridPos: { h: 4, w, x, y },
    targets: [target(expr, "", "A", { instant: true })],
    fieldConfig: {
      defaults: {
        unit,
        decimals: extra.decimals,
        thresholds: extra.thresholds ?? { mode: "absolute", steps: [{ color: "blue", value: null }] },
        mappings: extra.mappings ?? []
      },
      overrides: []
    },
    options: { reduceOptions: { calcs: ["lastNotNull"] }, colorMode: "value", graphMode: extra.graph ? "area" : "none", textMode: "value" }
  });
}

function ts(title, targets, x, w, h = 8, unit = "none", opts = {}) {
  panels.push({
    type: "timeseries",
    title,
    id: ++id,
    datasource: ds,
    gridPos: { h, w, x, y },
    description: opts.description,
    targets: targets.map((t, i) => target(t[0], t[1], String.fromCharCode(65 + i))),
    fieldConfig: {
      defaults: {
        unit,
        min: opts.min,
        max: opts.max,
        decimals: opts.decimals,
        custom: {
          drawStyle: "line",
          lineWidth: 1,
          fillOpacity: opts.stack ? 60 : 10,
          showPoints: "never",
          spanNulls: true,
          stacking: { mode: opts.stack ? "normal" : "none", group: "A" }
        }
      },
      overrides: []
    },
    options: {
      legend: {
        displayMode: opts.table ? "table" : "list",
        placement: opts.table ? "right" : "bottom",
        calcs: opts.table ? ["mean", "lastNotNull"] : [],
        sortBy: opts.table ? "Mean" : undefined,
        sortDesc: true
      },
      tooltip: { mode: "multi", sort: "desc" }
    }
  });
}

// --- Overview
row("Vue d'ensemble");
stat("Exporter", "screeps_up", 0, 3, "none", {
  mappings: [{ type: "value", options: { 0: { text: "DOWN", color: "red" }, 1: { text: "UP", color: "green" } } }],
  thresholds: { mode: "absolute", steps: [{ color: "red", value: null }, { color: "green", value: 1 }] }
});
stat("Tick", "screeps_tick", 3, 4, "none", { decimals: 0 });
stat("CPU moyen / limite", "screeps_cpu_avg / screeps_cpu_limit", 7, 4, "percentunit", {
  decimals: 1,
  graph: true,
  thresholds: { mode: "absolute", steps: [{ color: "green", value: null }, { color: "orange", value: 0.85 }, { color: "red", value: 0.95 }] }
});
stat("Bucket", "screeps_cpu_bucket", 11, 3, "none", {
  graph: true,
  thresholds: { mode: "absolute", steps: [{ color: "red", value: null }, { color: "orange", value: 5000 }, { color: "green", value: 8000 }] }
});
stat("Crédits", "screeps_credits", 14, 4, "short", { decimals: 0, graph: true });
stat("Creeps", "sum(screeps_room_creeps)", 18, 3);
stat("Salles", "count(screeps_room_rcl)", 21, 3);
y += 4;

// --- Maps: iframes of the exporter's live pages (websocket, refreshed every 2 s), then Prometheus views
const EXPORTER = "http://localhost:9101";
const iframe = (title, room, x, w, h, extra = {}) =>
  panels.push({
    type: "text",
    title,
    id: ++id,
    gridPos: { h, w, x, y },
    options: {
      mode: "html",
      content: `<iframe src="${EXPORTER}/map/live.html?room=${room}" style="display:block;width:100%;height:calc(100% - 8px);border:0"></iframe>`
    },
    ...extra
  });
row("Cartes (live, chaque tick)");
iframe("Monde (salles possédées et remotes, trafic sur ~3000 ticks)", "world", 0, 14, 20);
panels.push({
  type: "table",
  title: "Creeps",
  id: ++id,
  datasource: ds,
  gridPos: { h: 20, w: 10, x: 14, y },
  targets: [
    target('max by (room, name, role, owner) (screeps_creep_x{room=~"$room"})', "", "A", { instant: true, format: "table" }),
    target('max by (room, name, role, owner) (screeps_creep_y{room=~"$room"})', "", "B", { instant: true, format: "table" }),
    target('max by (room, name, role, owner) (screeps_creep_health{room=~"$room"})', "", "C", { instant: true, format: "table" })
  ],
  transformations: [
    { id: "merge", options: {} },
    {
      id: "organize",
      options: {
        excludeByName: { Time: true },
        indexByName: { room: 0, name: 1, role: 2, "Value #A": 3, "Value #B": 4, "Value #C": 5, owner: 6 },
        renameByName: { room: "Salle", name: "Creep", role: "Rôle", owner: "Joueur", "Value #A": "x", "Value #B": "y", "Value #C": "Santé" }
      }
    }
  ],
  fieldConfig: {
    defaults: {},
    overrides: [{ matcher: { id: "byName", options: "Santé" }, properties: [{ id: "unit", value: "percentunit" }, { id: "decimals", value: 0 }] }]
  },
  options: { showHeader: true, sortBy: [{ displayName: "Salle", desc: false }] }
});
y += 20;
iframe("$room", "$room", 0, 8, 14, { repeat: "room", repeatDirection: "h", maxPerRow: 3 });
y += 14;
ts("Hostiles par salle", [["screeps_map_hostile_creeps > 0", "{{room}}"]], 0, 8, 8, "short", { min: 0, stack: true });
ts("Creeps visibles par salle (les nôtres)", [['screeps_map_creeps{owner="mine"}', "{{room}}"]], 8, 8, 8, "short", { min: 0, stack: true });
ts(
  "CPU exact par tick (websocket)",
  [
    [`rate(screeps_ws_cpu_used_total${W}) / rate(screeps_ws_cpu_ticks_total${W})`, "moyenne"],
    ["screeps_cpu_limit", "limite"]
  ],
  16,
  8,
  8,
  "none",
  { min: 0, description: "Moyenne de chaque tick vu par le websocket, sans l'échantillonnage du poll HTTP" }
);
y += 8;

// --- CPU
row("CPU");
ts("CPU par tick", [["screeps_cpu_used", "dernier tick"], ["screeps_cpu_avg", "moyenne"], ["screeps_cpu_limit", "limite"]], 0, 12, 8, "none", { min: 0 });
ts("Bucket", [["screeps_cpu_bucket", "bucket"]], 12, 6, 8, "none", { min: 0, max: 10000 });
ts("Heap", [["screeps_heap_used_bytes / screeps_heap_limit_bytes", "heap"]], 18, 6, 8, "percentunit", { min: 0, max: 1 });
y += 8;
ts("CPU par module (par tick)", [[`${perKiloTick("cpu:module:.*")} / 1000`, "{{name}}"]], 0, 12, 10, "none", {
  stack: true,
  table: true,
  decimals: 2,
  min: 0
});
ts("CPU par rôle (par tick)", [[`${perKiloTick("cpu:[^:]+")} / 1000`, "{{name}}"]], 12, 12, 10, "none", {
  stack: true,
  table: true,
  decimals: 2,
  min: 0,
  description: "Biaisé : le CPU par rôle inclut les ordres du dispatcher (voir docs/decisions/economy.md)"
});
y += 10;

// --- Economy
row("Économie (par 1000 ticks)");
ts("Travail", [[perKiloTick("work:.*"), "{{name}}"]], 0, 12, 9, "short", { table: true, min: 0 });
ts("Livraisons", [[perKiloTick("deliver:.*"), "{{name}}"]], 12, 12, 9, "short", { table: true, min: 0 });
y += 9;
const wasted = kind =>
  `sum(rate(screeps_counter_total{name="mining:wasted:${kind}"}${W})) / sum(rate(screeps_counter_total{name="mining:available:${kind}"}${W}))`;
ts("Énergie de source perdue", [[wasted("local"), "local"], [wasted("remote"), "remote"]], 0, 8, 8, "percentunit", {
  min: 0,
  description: "mining:wasted / mining:available"
});
ts("Creeps créés", [[perKiloTick("spawned:.*"), "{{name}}"]], 8, 8, 8, "short", { stack: true, min: 0 });
ts("Intents", [[perKiloTick("intents:.*"), "{{name}}"]], 16, 8, 8, "short", { stack: true, min: 0 });
y += 8;
ts("Throttling", [[perKiloTick("throttled:.*"), "{{name}}"]], 0, 12, 8, "short", { min: 0 });
ts("Remote", [[perKiloTick("remote:.*"), "{{name}}"]], 12, 12, 8, "short", { min: 0 });
y += 8;
ts("Budget remote (salles)", [["screeps_remote_max_rooms", "plafond"], ["screeps_remote_rooms", "minées"]], 0, 8, 8, "short", {
  min: 0,
  decimals: 0,
  description: "remoteIncome.ts budgetRooms : le plafond baisse quand le bucket passe sous 8000 avec un CPU au-dessus de 95 %"
});
ts("CPU d'une salle remote", [["screeps_remote_room_cpu", "CPU/tick"]], 8, 8, 8, "none", { min: 0, decimals: 2 });
ts("Creeps inactifs (ticks par 1000)", [[perKiloTick("idle:.*"), "{{name}}"], [perKiloTick("deliver:none"), "{{name}}"]], 16, 8, 8, "short", {
  min: 0,
  description: "idle:<rôle> : ticks passés à attendre une source ; deliver:none : transporter chargé sans destination"
});
y += 8;

// --- Rooms
row("Salles");
ts("Énergie de spawn", [["screeps_room_energy_available", "{{room}}"]], 0, 12, 8, "short", { min: 0 });
ts("Creeps par salle", [["screeps_room_creeps", "{{room}}"]], 12, 12, 8, "short", { min: 0, stack: true });
y += 8;
ts("Progression du contrôleur (par 1000 ticks)", [[`1000 * deriv(screeps_room_controller_progress${W}) / ${TICK} >= 0`, "{{room}}"]], 0, 12, 8, "short", {
  min: 0
});
ts("Énergie stockée (storage + terminal)", [["screeps_room_stored_energy", "{{room}}"]], 12, 12, 8, "short", { min: 0 });
y += 8;
ts("Chantiers", [["screeps_room_construction_sites", "{{room}}"]], 0, 12, 8, "short", { min: 0 });
y += 8;
ts("Creeps par rôle", [["sum by (role) (screeps_room_role_creeps)", "{{role}}"]], 0, 12, 9, "short", { min: 0, stack: true, table: true });
panels.push({
  type: "table",
  title: "Salles",
  id: ++id,
  datasource: ds,
  gridPos: { h: 9, w: 12, x: 12, y },
  targets: [
    target("max by (room) (screeps_room_rcl)", "", "A", { instant: true, format: "table" }),
    target("max by (room) (screeps_room_creeps)", "", "B", { instant: true, format: "table" }),
    target("max by (room) (screeps_room_energy_capacity)", "", "C", { instant: true, format: "table" }),
    target("max by (room) (screeps_room_structures)", "", "D", { instant: true, format: "table" })
  ],
  transformations: [
    { id: "merge", options: {} },
    {
      id: "organize",
      options: {
        excludeByName: { Time: true },
        renameByName: { room: "Salle", "Value #A": "RCL", "Value #B": "Creeps", "Value #C": "Énergie max", "Value #D": "Structures" }
      }
    }
  ],
  fieldConfig: { defaults: {}, overrides: [] },
  options: { showHeader: true }
});
y += 9;

// --- Account
row("Compte");
ts("Crédits", [["screeps_credits", "crédits"]], 0, 12, 8, "short");
ts("GCL (points par 1000 ticks)", [[`1000 * deriv(screeps_gcl_points${W}) / ${TICK}`, "GCL"]], 12, 12, 8, "short", { min: 0 });
y += 8;

const dashboard = {
  uid: "screepy-shard0",
  title: "Screepy shard0",
  tags: ["screeps"],
  timezone: "browser",
  schemaVersion: 41,
  version: 1,
  refresh: "1m",
  time: { from: "now-24h", to: "now" },
  editable: true,
  panels,
  annotations: { list: [] },
  templating: {
    list: [
      {
        name: "room",
        label: "Salle",
        type: "query",
        datasource: ds,
        query: { query: "label_values(screeps_map_game_time, room)", refId: "rooms" },
        definition: "label_values(screeps_map_game_time, room)",
        refresh: 2,
        multi: true,
        includeAll: true,
        current: { selected: true, text: ["All"], value: ["$__all"] },
        sort: 1
      }
    ]
  }
};
fs.writeFileSync(process.argv[2], JSON.stringify(dashboard, null, 2) + "\n");
console.log(`${panels.length} panels written to ${process.argv[2]}`);
