#!/usr/bin/env node
/**
 * Steamless Screeps client for the local private server, and watcher for test runs.
 *
 * Serves the official client (read from the Steam install's package.nw) in the browser through
 * screeps-steamless-client, pointed at the local docker server. Requires Screeps owned on Steam.
 *
 * Standalone: npm run watch:server -- [--client-port 8080] [--package path/to/package.nw] [--no-open] [--no-client]
 *   Opens the client on the room of the run in progress (started from any session / worktree)
 *   and prints its progress and final report. A client already listening on the port is reused.
 * From the test harness: npm run test:server -- --client
 *
 * package.nw lookup: --package, then $SCREEPS_NW_PACKAGE, then every Steam library folder.
 * Log in with the test user: screepy / screepy.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER, isRunActive, readRun, roomHash } from "./pserver-lib.mjs";

const CLIENT_PACKAGE = "screeps-steamless-client@1.2.1";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

/** Steam install roots by platform (libraries listed in libraryfolders.vdf are added later) */
function steamRoots() {
    switch (process.platform) {
        case "win32":
            return ["C:\\Program Files (x86)\\Steam", "C:\\Program Files\\Steam"];
        case "darwin":
            return [join(homedir(), "Library", "Application Support", "Steam")];
        default:
            return [join(homedir(), ".steam", "steam"), join(homedir(), ".local", "share", "Steam")];
    }
}

/** Locate the Screeps package.nw (the client app shipped with the Steam version) */
export function findPackage(explicit) {
    const override = explicit ?? process.env.SCREEPS_NW_PACKAGE;
    if (override) {
        if (!existsSync(override)) throw new Error(`package.nw not found at ${override}`);
        return override;
    }

    const libraries = new Set();
    for (const root of steamRoots()) {
        libraries.add(root);
        const vdf = join(root, "steamapps", "libraryfolders.vdf");
        if (!existsSync(vdf)) continue;
        for (const [, path] of readFileSync(vdf, "utf-8").matchAll(/"path"\s+"([^"]+)"/g)) {
            libraries.add(path.replace(/\\\\/g, "\\"));
        }
    }
    for (const library of libraries) {
        const candidate = join(library, "steamapps", "common", "Screeps", "package.nw");
        if (existsSync(candidate)) return candidate;
    }
    throw new Error(
        "Screeps package.nw not found (is Screeps installed through Steam?). " +
            "Pass --package <path> or set SCREEPS_NW_PACKAGE."
    );
}

export function openBrowser(url) {
    if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" });
    else spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" });
}

/** True when a steamless client proxying the local server already answers on this port */
async function clientRunning(port) {
    try {
        const res = await fetch(`http://localhost:${port}/(${SERVER})/api/version`);
        return (await res.json()).ok === 1;
    } catch {
        return false;
    }
}

/**
 * Start the steamless client in the background, or reuse the one already on `port` (e.g. opened
 * by another session). Resolves once it answers HTTP; `stop()` kills it if this process started it
 * (also done automatically on process exit).
 */
export async function startClient({ port = 8080, packagePath, open = true, room } = {}) {
    const base = `http://localhost:${port}/(${SERVER})/`;
    const url = base + roomHash(room);

    if (await clientRunning(port)) {
        log(`Steamless client already running: ${url}  (login screepy / screepy)`);
        if (open) openBrowser(url);
        return { url, base, stop: () => {} };
    }

    const nw = findPackage(packagePath);
    const win = process.platform === "win32";
    // Windows: npx is a .cmd, which needs a shell (and quoted args, the Steam path has spaces)
    const child = spawn(
        win ? "npx.cmd" : "npx",
        ["--yes", CLIENT_PACKAGE, "--package", win ? `"${nw}"` : nw, "--port", String(port)],
        { stdio: ["ignore", "pipe", "pipe"], shell: win }
    );
    let output = "";
    child.stdout.on("data", d => (output += d));
    child.stderr.on("data", d => (output += d));

    const stop = () => {
        if (child.exitCode !== null || child.killed) return;
        // Windows: kill the whole tree (cmd -> npx -> node)
        if (win) {
            try {
                execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
            } catch {
                // already gone
            }
        } else child.kill();
    };
    process.on("exit", stop);

    log(`Starting steamless client (${CLIENT_PACKAGE}, first run downloads it)...`);
    for (let i = 0; ; i++) {
        if (child.exitCode !== null) throw new Error(`Steamless client exited:\n${output.trim()}`);
        if (await clientRunning(port)) break;
        if (i === 120) {
            stop();
            throw new Error(`Steamless client did not start on :${port}:\n${output.trim()}`);
        }
        await sleep(1000);
    }

    log(`Steamless client: ${url}  (login screepy / screepy)`);
    if (open) openBrowser(url);
    return { url, base, stop };
}

// ---------- standalone: client + run watcher ----------
function describe(run) {
    const pct = run.ticks ? Math.floor((100 * run.tick) / run.ticks) : 0;
    return [
        `room ${run.room}`,
        `tick ${run.tick}/${run.ticks} (${pct}%)`,
        run.rcl !== undefined ? `RCL ${run.rcl}` : "",
        run.creeps !== undefined ? `creeps ${run.creeps}` : "",
        run.cpuAvg !== undefined ? `cpu avg ${run.cpuAvg.toFixed(1)}` : "",
        run.errors ? `${run.errors} module errors` : ""
    ]
        .filter(Boolean)
        .join(" | ");
}

function printResult(run) {
    if (run.status === "crashed") return log(`Run in ${run.room} crashed: ${run.error}`);
    if (!isRunActive(run) && run.status === "running") return log(`Run in ${run.room} stopped responding (harness killed?)`);
    log(`Run in ${run.room} ${run.status.toUpperCase()}`);
    for (const c of run.checks ?? []) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(32)} ${c.detail}`);
}

async function watch({ port, packagePath, open, withClient }) {
    let run = readRun();
    if (isRunActive(run)) log(`Run in progress: ${describe(run)}`);
    else if (run) {
        log(`No run in progress. Last run (${new Date(run.startedAt).toLocaleString()}):`);
        printResult(run);
    } else log("No test run recorded on the server yet");

    const client = withClient && (await startClient({ port, packagePath, open, room: run?.room }));
    log("Watching for test runs, Ctrl+C to stop");
    process.on("SIGINT", () => process.exit(0));

    let last = run;
    for (;;) {
        await sleep(5000);
        run = readRun();
        if (!run) continue;
        if (run.startedAt !== last?.startedAt) {
            log(`New run started in ${run.room}` + (client ? `: ${client.base}${roomHash(run.room)}` : ""));
            if (client && open) openBrowser(client.base + roomHash(run.room));
        }
        const finished = !isRunActive(run);
        const wasFinished = last && last.startedAt === run.startedAt && !isRunActive(last);
        if (finished && !wasFinished) printResult(run);
        else if (!finished && run.tick !== last?.tick) log(describe(run));
        last = run;
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const args = process.argv.slice(2);
    const opt = (name, def) => {
        const i = args.indexOf(`--${name}`);
        return i === -1 ? def : args[i + 1];
    };
    watch({
        port: Number(opt("client-port", 8080)),
        packagePath: opt("package", undefined),
        open: !args.includes("--no-open"),
        withClient: !args.includes("--no-client")
    }).catch(err => {
        console.error(err.message);
        process.exit(1);
    });
}
