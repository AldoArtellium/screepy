/**
 * Offline check of defense/nukeDefense (incoming nukes: damage, protected tiles, repairs, evacuation) and
 * military/nukeTarget (our own strikes: impact point, value, synchronisation).
 *
 *   node tests/nukes/run.mjs
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(tmpdir(), "screepy-nukes-build");
const require = createRequire(import.meta.url);
const SOURCES = [join(ROOT, "src", "defense", "nukeDefense.ts"), join(ROOT, "src", "military", "nukeTarget.ts")];

try {
    execFileSync(
        process.execPath,
        [
            join(ROOT, "node_modules", "typescript", "bin", "tsc"),
            "--outDir", OUT, "--rootDir", join(ROOT, "src"), "--module", "commonjs", "--target", "es2019", "--skipLibCheck",
            "--types", "screeps,lodash",
            ...SOURCES,
        ],
        { stdio: "pipe" }
    );
} catch {
    // Type errors outside these files (global declarations) don't prevent emitting
}

let failures = 0;
function check(label, ok, detail) {
    console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
    if (!ok) failures++;
}

// ------------------------------------------------------------------ defense
const d = require(join(OUT, "defense", "nukeDefense.js"));
const nuke = { x: 25, y: 25, timeToLand: 40000 };

check("center takes 10M", d.nukeDamageAt([nuke], 25, 25) === 10000000);
check("range 2 takes 5M", d.nukeDamageAt([nuke], 27, 23) === 5000000);
check("range 3 takes nothing", d.nukeDamageAt([nuke], 28, 25) === 0);
check("two nukes add up", d.nukeDamageAt([nuke, { ...nuke, x: 26 }], 25, 25) === 15000000);

const RCL8_MAX = 300000000;
const RCL6_MAX = 30000000;
const rich = 1e9;
const base = [
    { x: 25, y: 25, type: "spawn" },
    { x: 26, y: 25, type: "extension" },
    { x: 24, y: 24, type: "tower" },
    { x: 23, y: 23, type: "storage" },
    { x: 30, y: 30, type: "terminal" }
];
const plan = d.planNukeDefense([nuke], base, [], RCL8_MAX, rich);
const types = (tiles) => tiles.map(t => t.types.join("+")).sort().join(",");
check("spawn at the center, tower and storage in the splash protected", types(plan.protect) === "spawn,storage,tower", types(plan.protect));
check("extension in the splash abandoned (rebuilt for less)", types(plan.abandon) === "extension", types(plan.abandon));
const spawnTile = plan.protect.find(t => t.types[0] === "spawn");
check("spawn rampart above the damage", spawnTile.needed > 10000000 && spawnTile.needed < 10500000, `${spawnTile.needed}`);
check("terminal out of range ignored", !plan.protect.concat(plan.abandon).some(t => t.types.includes("terminal")));
check("deficit sums the missing hits", plan.deficit === plan.protect.reduce((s, t) => s + t.needed, 0));

const ramparted = d.planNukeDefense([nuke], base, [{ x: 25, y: 25, hits: 10000000 }], RCL8_MAX, rich);
const spawnRamparted = ramparted.protect.find(t => t.types[0] === "spawn");
check("existing rampart hits lower the cost", spawnRamparted.cost < spawnTile.cost / 10, `${spawnRamparted.cost} vs ${spawnTile.cost}`);

const triple = d.planNukeDefense([nuke, nuke, nuke], base.slice(0, 1), [], RCL6_MAX, rich);
check("30M on the spawn above the RCL 6 rampart limit: abandoned", triple.protect.length === 0 && triple.abandon.length === 1);

const poor = d.planNukeDefense([nuke], base, [], RCL8_MAX, 120000);
check("tight budget: best worth per energy first (storage and tower before the spawn)", types(poor.protect) === "storage,tower", types(poor.protect));

check("repair work: 10M hits over 40k ticks = 5 WORK", d.repairWork(10000000, 40000) === 5, `${d.repairWork(10000000, 40000)}`);
check("repair work: late detection asks for more", d.repairWork(10000000, 2000) === 100);
check("repair work: nothing missing, none", d.repairWork(0, 100) === 0);

check("rampart site allowed in the radius", d.siteAllowed([nuke], 25, 25, true));
check("extension site refused in the radius", !d.siteAllowed([nuke], 26, 26, false));
check("extension site allowed out of the radius", d.siteAllowed([nuke], 30, 30, false));
check("no site at all right before the impact", !d.siteAllowed([{ ...nuke, timeToLand: 300 }], 40, 40, true));

check("ticks per tile: 1 MOVE per part", d.ticksPerTile(5, 5) === 1);
check("ticks per tile: upgrader 15 WORK 3 MOVE", d.ticksPerTile(3, 18) === 6);
check("no MOVE: can't leave", !isFinite(d.ticksPerTile(0, 10)));
check("evacuation: fast creep at least the minimum", d.evacuationTicks(5, 1) === d.MIN_EVACUATION_TICKS);
check("evacuation: slow creep far from the exit leaves earlier", d.evacuationTicks(20, 6) > 150, `${d.evacuationTicks(20, 6)}`);
check("evacuation never starts before the border guard", d.evacuationTicks(40, 20) === d.BORDER_GUARD_TICKS);
check("spawn hold covers a full body and the longest evacuation", d.SPAWN_HOLD_TICKS >= 150 + d.BORDER_GUARD_TICKS);

// ------------------------------------------------------------------ offense
const t = require(join(OUT, "military", "nukeTarget.js"));
const enemy = [
    { x: 20, y: 20, type: "spawn", rampartHits: 0 },
    { x: 21, y: 21, type: "tower", rampartHits: 0 },
    { x: 22, y: 20, type: "storage", rampartHits: 3000000 },
    { x: 35, y: 35, type: "spawn", rampartHits: 0 },
    { x: 10, y: 40, type: "terminal", rampartHits: 50000000 },
    { x: 19, y: 19, type: "extension", rampartHits: 0 }
];
const best = t.bestImpact(enemy);
const names = (impact) => impact.destroyed.map(s => s.type).sort().join(",");
check("impact on the cluster: spawn, tower, storage (3M rampart) and the extension", best && names(best) === "extension,spawn,storage,tower", best && `${best.x},${best.y} ${names(best)}`);
check("cluster value: the worth table", best.value === 150000 + 80000 + 150000 + 3000, `${best.value}`);
check("a 10M rampart holds the splash: storage kept", t.impactAt([{ x: 22, y: 20, type: "storage", rampartHits: 10000000 }], 20, 20).destroyed.length === 0);
check("a 10M rampart falls to the center", t.impactAt([{ x: 22, y: 20, type: "storage", rampartHits: 9000000 }], 22, 20).destroyed.length === 1);
check("a second nuke finishes a 7M rampart the first one ate into", t.impactAt([{ x: 22, y: 20, type: "storage", rampartHits: 7000000 }], 21, 20, [{ x: 20, y: 20 }]).destroyed.length === 1);
check("one nuke alone leaves the 7M rampart", t.impactAt([{ x: 22, y: 20, type: "storage", rampartHits: 7000000 }], 21, 20).destroyed.length === 0);
check("50M rampart: nothing to destroy, no impact", t.bestImpact([{ x: 10, y: 40, type: "terminal", rampartHits: 50000000 }]) === null);
check("unvalued structures only: no impact", t.bestImpact([{ x: 10, y: 10, type: "road", rampartHits: 0 }]) === null);
check("impact on a room corner stays in the room", (() => { const i = t.bestImpact([{ x: 0, y: 1, type: "spawn", rampartHits: 0 }]); return i && i.x >= 0 && i.y >= 0; })());

check("mission waits while the nuke is far", t.missionWaits(40000));
check("mission starts in the last ticks before the impact", !t.missionWaits(t.SQUAD_LEAD_TICKS));
check("no nuke: no wait", !t.missionWaits(undefined));
check("squad lead longer than the border guard (the squad waits outside, not in the room)", t.SQUAD_LEAD_TICKS > d.BORDER_GUARD_TICKS);

console.log(failures ? `${failures} failure(s)` : "all checks passed");
process.exit(failures ? 1 : 0);
