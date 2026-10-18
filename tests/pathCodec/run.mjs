/**
 * Offline check of utils/pathCodec: random walks across room exits (W/E and N/S zero lines
 * included) decode to exactly the same positions.
 *
 *   node tests/pathCodec/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-pathcodec-build");
const require = createRequire(import.meta.url);

execFileSync(process.execPath, [
    join(ROOT, "node_modules", "typescript", "bin", "tsc"),
    "--outDir", OUT, "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
    "--types", "screeps", join(ROOT, "src", "utils", "pathCodec.ts"),
]);

globalThis.RoomPosition = class {
    constructor(x, y, roomName) {
        Object.assign(this, { x, y, roomName });
    }
};
const { encodePath, decodePath } = require(join(OUT, "pathCodec.js"));

/** Room name and local coordinates of a world tile (independent of the codec) */
function at(wx, wy) {
    const rx = Math.floor(wx / 50), ry = Math.floor(wy / 50);
    const name = (rx >= 0 ? "E" + rx : "W" + (-rx - 1)) + (ry >= 0 ? "S" + ry : "N" + (-ry - 1));
    return new RoomPosition(wx - rx * 50, wy - ry * 50, name);
}

let failures = 0;
let chars = 0, oldChars = 0, tiles = 0;
for (let run = 0; run < 2000; run++) {
    let wx = Math.floor(Math.random() * 300) - 150, wy = Math.floor(Math.random() * 300) - 150;
    const path = [];
    const length = 1 + Math.floor(Math.random() * 200);
    for (let i = 0; i < length; i++) {
        // Mostly adjacent steps, sometimes a jump (new segment)
        if (Math.random() < 0.01) { wx += 7; wy -= 3; }
        else { wx += Math.floor(Math.random() * 3) - 1; wy += Math.floor(Math.random() * 3) - 1; }
        path.push(at(wx, wy));
    }
    const packed = encodePath(path);
    const decoded = decodePath(packed);
    const same = decoded.length === path.length &&
        decoded.every((p, i) => p.x === path[i].x && p.y === path[i].y && p.roomName === path[i].roomName);
    if (!same) {
        failures++;
        if (failures < 5) console.log("MISMATCH", packed);
    }
    chars += packed.length;
    oldChars += path.map(p => `${p.roomName},${p.x},${p.y}`).join(";").length;
    tiles += path.length;
}
if (decodePath("").length !== 0) failures++;
console.log(`${failures ? "FAIL" : "PASS"}: ${failures} mismatches; ${(chars / tiles).toFixed(2)} chars/tile (old format ${(oldChars / tiles).toFixed(2)})`);
process.exit(failures ? 1 : 0);
