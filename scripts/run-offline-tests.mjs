// Runs every offline check (tests/<name>/run.mjs) after `npm run build`, like the CI build job.
// Usage: node scripts/run-offline-tests.mjs [name ...]   (no name: every directory under tests/)
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = join(root, "tests");
const names = process.argv.length > 2
    ? process.argv.slice(2)
    : readdirSync(testsDir).filter(name => existsSync(join(testsDir, name, "run.mjs"))).sort();

const failed = [];
for (const name of names) {
    const result = spawnSync(process.execPath, [join(testsDir, name, "run.mjs")], { cwd: root, encoding: "utf8" });
    const ok = result.status === 0;
    console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
    if (!ok) {
        failed.push(name);
        console.log((result.stdout + result.stderr).split("\n").slice(-25).join("\n"));
    }
}
console.log(`${names.length - failed.length}/${names.length} passed${failed.length ? `, failed: ${failed.join(", ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
