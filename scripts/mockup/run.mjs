#!/usr/bin/env node
/**
 * Fast bot test in an in-process Screeps engine (screeps-server-mockup, same engine as the private
 * server: screeps 4.3.0), run in the screepy-mockup Docker image (built on first use).
 * Independent from the docker compose private server: runs can go in parallel.
 *
 * Usage: npm run test:mockup -- [--ticks 3000] [--room W7N3] [--code path/to/main.js] [--no-build]
 *                               [--memory '<json>' | @file.json] [--min-rcl 2] [--max-cpu 20] [--log-every 500]
 *                               [--min-points <n>] (regression gate: fail below n world points)
 *                               [--verbose]       (print the bot console)
 *                               [--dump-memory]   (Memory and segments at the end, <report>-memory.json)
 *                               [--processors 2]  (engine processor processes, 1 with --no-fast)
 *                               [--no-fast]       (unpatched engine: no fast.cjs speed-ups)
 *                               [--profile]       (wall time per main loop stage, CPU per process)
 *                               [--list-rooms]    (rooms with a fixture)
 *                               [--rebuild-image] (force a docker build)
 *                               [--image-hash]    (print the image label hash and exit, see CI)
 *                               [--native]        (no Docker: needs `npm install` in scripts/mockup,
 *                                                  i.e. a C++ toolchain for @screeps/driver)
 *
 * Rooms come from scripts/mockup/fixtures/<room>.json (real terrain + objects of the room and its
 * neighbours, see extract-fixtures.mjs). Report: test-results/mockup-<timestamp>.json.
 * Exit code 0 when every check passes (same checks as pserver-test.mjs), 1 otherwise.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const IMAGE = "screepy-mockup";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? def : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);

if (flag("list-rooms")) {
  for (const f of readdirSync(join(HERE, "fixtures")).filter((f) => f.endsWith(".json"))) {
    const fx = JSON.parse(readFileSync(join(HERE, "fixtures", f), "utf-8"));
    const objs = fx.rooms[fx.room].objects;
    console.log(
      `${fx.room.padEnd(8)} sources ${objs.filter((o) => o.type === "source").length}, neighbours ${Object.keys(fx.rooms).length - 1}, extracted ${fx.extractedAt}`
    );
  }
  process.exit(0);
}
// Hash of the image inputs, for CI: build the image with this screepy.hash label (cached) and
// ensureImage() then reuses it instead of rebuilding
if (flag("image-hash")) {
  console.log(imageHash());
  process.exit(0);
}

const CODE = resolve(opt("code", join(ROOT, "dist", "main.js")));
const BUILD = !flag("no-build") && !args.includes("--code");
const NATIVE = flag("native");
// fast.cjs: speed-ups that do not change the simulation (includes nodelay.cjs); --no-fast: nodelay only
const PRELOAD = flag("no-fast") ? "nodelay.cjs" : "fast.cjs";

if (BUILD) {
  console.log("Building bot (rollup)...");
  execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["rollup", "-c"], {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32"
  });
}
if (!existsSync(CODE)) throw new Error(`Bundle not found: ${CODE}`);

/** Hash of everything the image is built from: rebuild when it changes */
function imageHash() {
  const h = createHash("sha256");
  const walk = (p) => {
    if (statSync(p).isDirectory()) for (const f of readdirSync(p).sort()) walk(join(p, f));
    else h.update(relative(HERE, p)).update(readFileSync(p));
  };
  for (const f of ["Dockerfile", "package.json", "vendor"]) walk(join(HERE, f));
  return h.digest("hex").slice(0, 16);
}

function ensureImage() {
  const hash = imageHash();
  let current = null;
  try {
    current = execFileSync("docker", ["image", "inspect", IMAGE, "--format", '{{index .Config.Labels "screepy.hash"}}'], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    // no image yet
  }
  if (current === hash && !flag("rebuild-image")) return;
  console.log(`Building Docker image ${IMAGE} (first use or changed, ~4 min)...`);
  execFileSync("docker", ["build", "-t", IMAGE, "--label", `screepy.hash=${hash}`, HERE], { stdio: "inherit" });
}

// Arguments for sim.cjs: everything except the launcher's own options
const passthrough = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (["--code"].includes(a)) i++;
  else if (["--no-build", "--native", "--rebuild-image"].includes(a)) continue;
  else passthrough.push(a);
}
// Random suffix: two runs started in the same millisecond must not share a container name or report
const stamp = `${Date.now()}-${randomBytes(3).toString("hex")}`;
const outHost = join(ROOT, "test-results", `mockup-${stamp}.json`);

let status;
if (NATIVE) {
  status = spawnSync(
    process.execPath,
    ["-r", join(HERE, PRELOAD), join(HERE, "sim.cjs"), "--code", CODE, "--out", outHost, ...passthrough],
    { stdio: "inherit", env: { ...process.env, NODE_PATH: join(HERE, "node_modules") } }
  ).status;
} else {
  ensureImage();
  const toPosix = (p) => p.split(sep).join("/");
  const mounts = ["-v", `${ROOT}:/repo`];
  let code;
  const rel = relative(ROOT, CODE);
  if (!rel.startsWith("..") && !isAbsolute(rel)) code = `/repo/${toPosix(rel)}`;
  else {
    mounts.push("-v", `${dirname(CODE)}:/code:ro`);
    code = `/code/${basename(CODE)}`;
  }
  status = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      "none",
      "--name",
      `screepy-mockup-${stamp}`,
      ...mounts,
      "-w",
      "/repo",
      IMAGE,
      "node",
      "-r",
      `/repo/scripts/mockup/${PRELOAD}`,
      "/repo/scripts/mockup/sim.cjs",
      "--code",
      code,
      "--out",
      `/repo/test-results/mockup-${stamp}.json`,
      ...passthrough
    ],
    { stdio: "inherit", env: { ...process.env, MSYS_NO_PATHCONV: "1" } }
  ).status;
}
if (existsSync(outHost)) console.log(`Report (host path): ${outHost}`);
process.exit(status ?? 1);
