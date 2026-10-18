/**
 * Offline room planner check: compiles src/planner with tsc into a temp folder, runs it on the
 * terrains of tests/planner/data/*.json (dumped from the local server) with mocked game globals,
 * checks the plan and writes an ASCII rendering to test-results/plan-<room>.txt.
 *
 *   node tests/planner/run.mjs [ROOM...]
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-planner-build");
const require = createRequire(import.meta.url);

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash", join(ROOT, "src", "planner", "RoomPlanner.ts"),
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside src/planner (Memory.logLevel...) don't prevent emitting
}

const mocks = require("./mocks.cjs");
const { buildVariation, extendRoomPlan, listVariations } = require(join(OUT, "planner", "RoomPlanner.js"));
const { RoomPlan } = require(join(OUT, "planner", "RoomPlan.js"));

const dataDir = join(ROOT, "tests", "planner", "data");
const rooms = process.argv.length > 2 ? process.argv.slice(2) : readdirSync(dataDir).map(f => f.replace(".json", ""));

/** Rendering priority: first matching type wins */
const SYMBOLS = [
    ["spawn", "S"], ["extension", "E"], ["tower", "T"], ["storage", "O"], ["terminal", "M"], ["factory", "F"],
    ["link", "L"], ["lab", "B"], ["powerSpawn", "P"], ["nuker", "N"], ["observer", "V"], ["helper_parking", "h"],
    ["extractor", "X"], ["upgrader.0", "U"], ["harvester", "H"], ["container", "C"],
    ["center", "@"], ["bay_center", "b"], ["rampart.ramp", "r"], ["rampart", "R"], ["road", "+"], ["exit", ">"],
];

let failures = 0;
for (const room of rooms) {
    const { terrain: data, objects } = JSON.parse(readFileSync(join(dataDir, `${room}.json`), "utf-8"));
    const terrain = mocks.makeTerrain(room, data);
    const controller = objects.find(o => o.type === "controller");
    const sources = objects.filter(o => o.type === "source");
    const minerals = objects.filter(o => o.type === "mineral");

    // Every variation, like RoomPlanner over several ticks; the best score wins
    const spawn = objects.find(o => o.type === "spawn");
    const input = { roomName: room, terrain, controller, sources, minerals, ...(spawn && { spawn }) };
    const variations = listVariations(input);
    mocks.resetCpu();
    let best = null;
    let pathCalls = 0;
    const scores = [];
    for (const variation of variations) {
        const result = buildVariation(input, variation);
        pathCalls += result.pathCalls;
        scores.push(`${variation.key}=${result.score.toFixed(3)}`);
        if (result.plan && (!best || result.score > best.score)) best = { ...result, key: variation.key };
    }
    const ms = Game.cpu.getUsed();
    const plan = best?.plan ?? null;

    const errors = [];
    if (!plan) {
        console.log(`${room}: FAIL (no plan)`);
        failures++;
        continue;
    }

    // Round trip through Memory format
    const copy = RoomPlan.deserialize(room, plan.serialize());
    for (const type of plan.types()) if (copy.count(type) !== plan.count(type)) errors.push(`serialize ${type}`);

    // Structures must not overlap each other, nor walls (except the extractor)
    const structureTypes = ["spawn", "extension", "tower", "storage", "terminal", "factory", "link", "container", "extractor",
        "lab", "powerSpawn", "nuker", "observer"];
    const owner = new Map();
    for (const type of structureTypes) {
        for (const pos of plan.getLocations(type)) {
            const k = pos.x + 50 * pos.y;
            if (owner.has(k)) errors.push(`${type} over ${owner.get(k)} at ${pos.x},${pos.y}`);
            owner.set(k, type);
            if (type !== "extractor" && terrain.get(pos.x, pos.y) & 1) errors.push(`${type} on wall at ${pos.x},${pos.y}`);
            if (type !== "container" && plan.has(pos, "road")) errors.push(`${type} on road at ${pos.x},${pos.y}`);
        }
    }
    const expect = { spawn: 3, tower: 6, storage: 1, "container.controller": 1, "upgrader.0": 1, lab: 10, "lab.source": 2,
        powerSpawn: 1, nuker: 1, observer: 1, helper_parking: 1 };
    for (const [type, n] of Object.entries(expect)) if (plan.count(type) !== n) errors.push(`${type}: ${plan.count(type)} != ${n}`);
    // Roads to the ramparts may go through a few extensions (Hivemind removes them from the plan)
    if (plan.count("extension") < 55) errors.push(`extension: ${plan.count("extension")} < 55`);
    const center = plan.getCenter();
    for (const type of structureTypes) if (center && plan.has(center, type)) errors.push(`${type} on the center`);
    if (best.score < -10) errors.push(`score ${best.score.toFixed(1)}: unreachable spots`);
    // Every lab within range 2 of both source labs (reactions)
    const sourceLabs = plan.getLocations("lab.source");
    for (const lab of plan.getLocations("lab")) {
        if (sourceLabs.some(s => Math.max(Math.abs(s.x - lab.x), Math.abs(s.y - lab.y)) > 2)) errors.push(`lab ${lab.x},${lab.y} out of range`);
    }

    // PLAN_VERSION 3 plan of the same variation, extended in place: nothing moves, new structures on free safe tiles
    const legacy = buildVariation({ ...input, legacy: true }, variations.find(v => v.key === best.key)).plan;
    const before = new Map();
    for (const type of legacy.types()) before.set(type, legacy.getLocations(type).map(p => p.x + 50 * p.y).join());
    const legacyBlocked = new Set();
    for (const type of [...structureTypes, "road", "rampart", "center", "harvester", "upgrader.0", "bay_center"]) {
        for (const p of legacy.getLocations(type)) legacyBlocked.add(p.x + 50 * p.y);
    }
    const extended = extendRoomPlan(input, RoomPlan.deserialize(room, legacy.serialize()));
    const extendErrors = [];
    for (const [type, positions] of before) {
        const after = extended.getLocations(type).map(p => p.x + 50 * p.y);
        if (!positions.split(",").every(k => !k || after.includes(Number(k)))) extendErrors.push(`${type} moved`);
    }
    for (const type of ["lab", "powerSpawn", "nuker", "observer", "helper_parking"]) {
        for (const p of extended.getLocations(type)) {
            if (legacyBlocked.has(p.x + 50 * p.y)) extendErrors.push(`${type} over the old plan at ${p.x},${p.y}`);
            if (!legacy.has(p, "safe")) extendErrors.push(`${type} outside the safe area at ${p.x},${p.y}`);
        }
    }
    errors.push(...extendErrors);
    if (plan.count("container.source") !== sources.length) errors.push(`container.source: ${plan.count("container.source")}`);
    for (const s of sources) if (plan.count("harvester." + s.id) !== 1) errors.push(`harvester.${s.id} missing`);

    // Render
    const special = new Map();
    for (const s of sources) special.set(s.x + 50 * s.y, "$");
    special.set(controller.x + 50 * controller.y, "K");
    const lines = [];
    lines.push(`Room plan ${room} - best ${best.key} (${best.score.toFixed(3)}) of ${variations.length} variations - center ${plan.getCenter()} - ${pathCalls} paths - ${ms.toFixed(0)} ms (node, mocked PathFinder)`);
    lines.push(SYMBOLS.map(([t, c]) => `${c}=${t}`).join(" ") + " $=source K=controller #=wall ~=swamp");
    lines.push("   " + Array.from({ length: 50 }, (_, x) => (x % 10).toString()).join(""));
    for (let y = 0; y < 50; y++) {
        let row = y.toString().padStart(2, " ") + " ";
        for (let x = 0; x < 50; x++) {
            const k = x + 50 * y;
            let c = special.get(k);
            if (!c) {
                for (const [type, sym] of SYMBOLS) {
                    if (plan.has({ x, y }, type)) {
                        c = sym;
                        break;
                    }
                }
            }
            if (!c) {
                const t = terrain.get(x, y);
                c = t & 1 ? "#" : t & 2 ? "~" : ".";
            }
            row += c;
        }
        lines.push(row);
    }
    lines.push("");
    lines.push("Counts: " + plan.types().sort().map(t => `${t}=${plan.count(t)}`).join(", "));
    lines.push("Bays: " + Array.from({ length: 20 }, (_, i) => plan.count("extension.bay." + i)).filter(n => n).join(" "));
    lines.push("Towers in order: " + Array.from({ length: 6 }, (_, i) => plan.getLocations("tower." + i)[0]).map(p => p && `${p.x},${p.y}`).join(" "));
    lines.push("Spawns in order: " + Array.from({ length: 3 }, (_, i) => plan.getLocations("spawn." + i)[0]).map(p => p && `${p.x},${p.y}`).join(" "));
    lines.push("Scores: " + scores.join(" "));
    if (errors.length) lines.push("ERRORS: " + errors.join("; "));

    mkdirSync(join(ROOT, "test-results"), { recursive: true });
    writeFileSync(join(ROOT, "test-results", `plan-${room}.txt`), lines.join("\n") + "\n");
    console.log(`  extended v3 plan: ${extended.count("lab")} labs, ${extended.count("powerSpawn")} power spawn, ${extended.count("nuker")} nuker, ` +
        `${extended.count("observer")} observer, ${extended.count("helper_parking")} parking${extendErrors.length ? "" : ", nothing moved"}`);
    console.log(`${room}: ${errors.length ? "FAIL " + errors.join("; ") : "PASS"} - best ${best.key} ${best.score.toFixed(3)} ` +
        `(first ${scores[0]}), ${variations.length} variations in ${ms.toFixed(0)} ms, ${pathCalls} paths, ` +
        `${plan.count("extension")} ext, ${plan.count("spawn")} spawns, ${plan.count("tower")} towers, ${plan.count("road")} roads`);
    // Defense geometry: ramparts, safe area, tower distances to the center (in build order) and the
    // tower damage factor on the core (spawns + storage), first 1 / 3 / 6 towers
    const rng = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    const falloff = r => (r <= 5 ? 1 : r >= 20 ? 0.25 : 1 - ((r - 5) / 15) * 0.75);
    const ordered = Array.from({ length: 6 }, (_, i) => plan.getLocations("tower." + i)[0]).filter(Boolean);
    const core = [...plan.getLocations("spawn"), ...plan.getLocations("storage")];
    const cover = n => (sumOf(core, c => sumOf(ordered.slice(0, n), t => falloff(rng(t, c)))) / core.length).toFixed(2);
    const ramparts = plan.getLocations("rampart");
    const rampCover = (sumOf(ramparts, r => sumOf(ordered, t => falloff(rng(t, r)))) / Math.max(1, ramparts.length)).toFixed(2);
    console.log(`  defense: ${plan.count("rampart")} ramparts (${plan.count("rampart.ramp")} on-ramps), ${plan.count("safe")} safe tiles, ` +
        `towers at ${ordered.map(t => rng(t, center)).join("/")} from center, core cover 1/3/6 towers ${cover(1)}/${cover(3)}/${cover(6)}, rampart cover ${rampCover}`);
    if (errors.length) failures++;
}

function sumOf(items, f) {
    return items.reduce((s, i) => s + f(i), 0);
}
process.exit(failures ? 1 : 0);
