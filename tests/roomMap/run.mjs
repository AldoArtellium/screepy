/**
 * Offline check of monitoring/roomMap.mjs, the room maps the Grafana exporter serves: room name
 * coordinates, terrain decoding, creep summaries from /api/game/room-objects, the decaying traffic
 * heat and the SVG of one room and of the world mosaic.
 *
 *   node tests/roomMap/run.mjs
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const map = await import(pathToFileURL(join(ROOT, "monitoring", "roomMap.mjs")).href);

let failures = 0;
function check(name, fn) {
    try {
        fn();
        console.log(`ok   ${name}`);
    } catch (err) {
        failures++;
        console.log(`FAIL ${name}: ${err.message}`);
    }
}

check("room coordinates: W/N negative, E/S positive, adjacent rooms one apart", () => {
    assert.deepEqual(map.roomCoords("W0N0"), { x: -1, y: -1 });
    assert.deepEqual(map.roomCoords("E0S0"), { x: 0, y: 0 });
    assert.deepEqual(map.roomCoords("W27N5"), { x: -28, y: -6 });
    assert.deepEqual(map.roomCoords("W28N5"), { x: -29, y: -6 });
    assert.deepEqual(map.roomCoords("W27N6"), { x: -28, y: -7 });
    assert.equal(map.roomCoords("sim"), undefined);
});

check("terrain: 2500 tiles, 0 plain, 1 wall, 2 swamp, 3 wall", () => {
    const encoded = "0123".repeat(625);
    const t = map.decodeTerrain(encoded);
    assert.equal(t.length, 2500);
    assert.deepEqual([...t.slice(0, 4)], [0, 1, 2, 1]);
    assert.equal(map.decodeTerrain("12"), undefined);
});

check("creep role: name prefix before the last underscore", () => {
    assert.equal(map.creepRole("remoteHauler_1fz"), "remoteHauler");
    assert.equal(map.creepRole("squad_duo_a1"), "squad_duo");
    assert.equal(map.creepRole("Invader1"), "Invader1");
});

const ME = "me1";
const objects = [
    { type: "creep", name: "harvester_a", x: 10, y: 11, user: ME, body: [{ type: "work", hits: 100 }, { type: "move", hits: 50 }] },
    { type: "creep", name: "bad<guy>", x: 20, y: 21, user: "foe", body: [{ type: "attack", hits: 100 }] },
    { type: "powerCreep", name: "pc", x: 1, y: 2, user: ME },
    { type: "spawn", x: 25, y: 25, user: ME },
    { type: "road", x: 26, y: 25 },
    { type: "source", x: 5, y: 5 },
];
const users = { [ME]: { username: "me" }, foe: { username: "Foe & Co" } };

check("summary: creeps with role, owner name, mine flag and body health", () => {
    const s = map.summarize(objects, users, ME);
    assert.equal(s.creeps.length, 2);
    const mine = s.creeps.find(c => c.mine);
    assert.deepEqual(
        { name: mine.name, role: mine.role, owner: mine.owner, x: mine.x, y: mine.y, health: mine.health },
        { name: "harvester_a", role: "harvester", owner: "me", x: 10, y: 11, health: 0.75 }
    );
    const foe = s.creeps.find(c => !c.mine);
    assert.equal(foe.owner, "Foe & Co");
    assert.equal(foe.role, "hostile");
    assert.equal(s.structures.length, 3);
});

check("heat: our creeps add one per poll, decay halves after the half-life", () => {
    const heat = new map.Heat(2);
    const s = map.summarize(objects, users, ME);
    heat.record("W1N1", s.creeps);
    assert.equal(heat.get("W1N1")[11 * 50 + 10], 1);
    assert.equal(heat.get("W1N1")[21 * 50 + 20], 0, "hostiles are not traffic");
    heat.record("W1N1", []);
    heat.record("W1N1", []);
    assert.ok(Math.abs(heat.get("W1N1")[11 * 50 + 10] - 0.5) < 1e-6);
});

check("room SVG: terrain, structures, one circle per creep, escaped names", () => {
    const terrain = map.decodeTerrain("1".repeat(50) + "0".repeat(2450));
    const s = map.summarize(objects, users, ME);
    const svg = map.renderRoomSvg({ room: "W1N1", terrain, snapshot: { ...s, at: 0 }, heat: undefined, scale: 10 });
    assert.ok(svg.startsWith("<svg"), "svg root");
    assert.ok(svg.includes('viewBox="0 0 500 500"'));
    assert.equal((svg.match(/class="creep/g) ?? []).length, 2);
    assert.ok(svg.includes("bad&lt;guy&gt;"), "creep name escaped");
    assert.ok(svg.includes("Foe &amp; Co"), "owner escaped");
    assert.ok(!svg.includes("<guy>"));
});

check("room SVG without snapshot or terrain still renders a placeholder", () => {
    const svg = map.renderRoomSvg({ room: "W1N1", terrain: undefined, snapshot: undefined, scale: 4 });
    assert.ok(svg.includes("W1N1"));
    assert.ok(svg.includes('viewBox="0 0 200 200"'));
});

check("world SVG: rooms placed by coordinates in their bounding box", () => {
    const rooms = [
        { room: "W1N1", terrain: undefined, snapshot: undefined },
        { room: "W2N2", terrain: undefined, snapshot: undefined },
    ];
    const svg = map.renderWorldSvg(rooms, 2);
    // W2N2 is top left (x -3, y -3), W1N1 bottom right (x -2, y -2): a 2 x 2 rooms box of 100 px rooms
    assert.ok(svg.includes('viewBox="0 0 200 200"'), svg.slice(0, 120));
    assert.ok(svg.includes('transform="translate(100,100)"'), "W1N1 at the bottom right");
    assert.ok(svg.includes('transform="translate(0,0)"'), "W2N2 at the top left");
});

if (failures) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
}
console.log("\nall room map checks passed");
