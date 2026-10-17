/**
 * Shared helpers for the local private-server scripts.
 */

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SERVER = "http://localhost:21025";
export const SHARD = "test1";

/** Run a command in the server CLI (only reachable from inside the container) */
export function cli(command) {
    const snippet =
        "const h=require('http');const q=h.request({host:'127.0.0.1',port:21026,path:'/cli',method:'POST'," +
        "headers:{'Content-Type':'text/plain'}},r=>{let b='';r.on('data',d=>b+=d);r.on('end',()=>process.stdout.write(b))});" +
        "q.end(process.argv[1]);";
    return execFileSync(
        "docker",
        ["compose", "exec", "-T", "screeps", "/screeps/deps/node/bin/node", "-e", snippet, command],
        { cwd: ROOT, encoding: "utf-8", env: { ...process.env, MSYS_NO_PATHCONV: "1" }, maxBuffer: 64 * 1024 * 1024 }
    ).trim();
}

/**
 * State of the current/last test run, stored on the server (redis) rather than on disk so any
 * session or git worktree can follow a run started elsewhere (see pserver-client.mjs).
 */
const RUN_KEY = "pserver:run";
/** A "running" state not refreshed for this long belongs to a dead harness */
export const RUN_STALE_MS = 60 * 1000;

export function readRun() {
    try {
        const raw = cli(`storage.env.get('${RUN_KEY}')`);
        return raw && raw !== "null" ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

export function writeRun(run) {
    const value = JSON.stringify({ ...run, updatedAt: Date.now() });
    cli(`storage.env.set('${RUN_KEY}', ${JSON.stringify(value)})`);
}

export const isRunActive = run => run?.status === "running" && Date.now() - run.updatedAt < RUN_STALE_MS;

/** Client URL for a room of the test shard */
export const roomHash = room => (room ? `#!/room/${SHARD}/${room}` : "");
