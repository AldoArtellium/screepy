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
const { buildVariation, listVariations } = require(join(OUT, "planner", "RoomPlanner.js"));
const { RoomPlan } = require(join(OUT, "planner", "RoomPlan.js"));

const dataDir = join(ROOT, "tests", "planner", "data");
const rooms = process.argv.length > 2 ? process.argv.slice(2) : readdirSync(dataDir).map(f => f.replace(".json", ""));

/** Rendering priority: first matching type wins */
const SYMBOLS = [
    ["spawn", "S"], ["extension", "E"], ["tower", "T"], ["storage", "O"], ["terminal", "M"], ["factory", "F"],
    ["link", "L"], ["extractor", "X"], ["upgrader.0", "U"], ["harvester", "H"], ["container", "C"],
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
    const input = { roomName: room, terrain, controller, sources, minerals };
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
    const structureTypes = ["spawn", "extension", "tower", "storage", "terminal", "factory", "link", "container", "extractor"];
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
    const expect = { spawn: 3, tower: 6, storage: 1, "container.controller": 1, "upgrader.0": 1 };
    for (const [type, n] of Object.entries(expect)) if (plan.count(type) !== n) errors.push(`${type}: ${plan.count(type)} != ${n}`);
    // Roads to the ramparts may go through a few extensions (Hivemind removes them from the plan)
    if (plan.count("extension") < 55) errors.push(`extension: ${plan.count("extension")} < 55`);
    const center = plan.getCenter();
    for (const type of structureTypes) if (center && plan.has(center, type)) errors.push(`${type} on the center`);
    if (best.score < -10) errors.push(`score ${best.score.toFixed(1)}: unreachable spots`);
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
    console.log(`${room}: ${errors.length ? "FAIL " + errors.join("; ") : "PASS"} - best ${best.key} ${best.score.toFixed(3)} ` +
        `(first ${scores[0]}), ${variations.length} variations in ${ms.toFixed(0)} ms, ${pathCalls} paths, ` +
        `${plan.count("extension")} ext, ${plan.count("spawn")} spawns, ${plan.count("tower")} towers, ${plan.count("road")} roads`);
    if (errors.length) failures++;
}
process.exit(failures ? 1 : 0);
