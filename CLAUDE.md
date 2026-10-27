# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.
Design decisions, deviations from Hivemind and every measurement behind them live in `docs/decisions/`
(one file per domain, linked below); read the relevant one before changing a domain. Keep this file
short: put new measurements there, not here.

## Project Overview

Screepy is a TypeScript-based AI bot for the game [Screeps](https://screeps.com/). The code compiles to JavaScript and gets deployed to Screeps servers where it runs autonomously to control game entities (creeps, spawns, towers). Since October 2026 its economy core follows Hivemind's model (roles, spawn options, resource dispatcher, room planner), ported from Hivemind (MIT, see `THIRD_PARTY_NOTICES.md`). Remote mining, CPU throttling, the full planner, base defense and expansion follow Hivemind too; scouting and the market remain from the previous design. Offense is ours to design (open-source bots keep it private). Exact Hivemind rules with `file:line` sources: `docs/hivemind/hivemind-*.md`; design: `docs/superpowers/specs/2026-10-17-hivemind-economy-rework-design.md`.

## Build & Deploy Commands

```bash
npm install              # Install dependencies (requires Node.js ^24)
npm run build            # TypeScript compilation only (tsc)
npm run compile          # Rollup bundle without deployment
npm run lint             # Run ESLint
npm run lint:fix         # Run ESLint with auto-fix
npm run format           # Format code with Prettier
npm run test             # Clean and build (verification)
npm run push-main        # Deploy to the main server (also push-sim, push-pserver, push-seasonal, push-screepsplus)
node tests/<name>/run.mjs   # Offline checks of pure modules (after npm run build), all run in CI
```

## Testing

Validate with the mockup first (3 rooms), confirm on the private server, then on shard0. Benchmark on several rooms: easy W7N3, medium W9N5 (noisy: compare means of 3 runs), hard W1N3 (sources ~30 tiles away); tuning on one room overfits. Hivemind 3.0.0 reference (8000 ticks): W7N3 107085, W9N5 189, W1N3 20300. Details, server quirks and the speed-ups: `docs/decisions/tooling.md`.

### Mockup (fast, in-process engine in the `screepy-mockup` Docker image; runs in parallel)

```bash
npm run test:mockup                                    # build, 3000 ticks on W7N3, PASS/FAIL checks
npm run test:mockup -- --code test-results/bundles/x.js --room W1N3 --ticks 8000
npm run test:mockup -- --memory '{"foo":1}' --verbose   # initial Memory, print the bot console
npm run test:mockup -- --dump-memory                   # Memory + segments at the end
npm run test:mockup -- --profile                       # wall ms/tick per stage
npm run test:mockup -- --cpu-limit 13                  # lower the CPU limit (intents charged 0.2 like official)
npm run test:mockup -- --preset rcl4|rcl5|rcl7         # fast-forwarded room (storage, extensions, containers)
npm run test:mockup -- --preset rcl6|rcl8|plan5..plan8 --labs --minerals H:20000,X:10000   # plan-based, terminal, labs
npm run test:mockup -- --raid 9000:smallMelee+smallRanged,13500:smallMelee*@W7N4   # invader raids ("*" boosted)
npm run test:mockup -- --enemy W8N3:3[:defenders[:ringHits]] --enemy-refill 10    # enemy base (enemy-bot.js)
npm run test:mockup -- --stronghold W7N4:1 | --siege W7N3:1500 | --blockers W7N3:8:500
npm run test:mockup -- --claim W8N3:2 | --gcl 2 | --structures @file.json | --set-rcl 5
npm run test:mockup -- --save-state s.json | --load-state s.json   # save / resume a world
CODES="before=a.js after=dist/main.js" RUNS=2 JOBS=6 bash scripts/mockup/compare.sh   # bundles x rooms x runs
```

- Reports in `test-results/mockup-*.json`, compare summary in `test-results/mockup-compare-summary.txt`. Runs are nearly deterministic (a few % between runs; single 3000-tick runs spread +-18%).
- From scratch the storage comes around tick 11k on W7N3, 20k+ on W1N3: measure storage-era changes with presets or 30000 ticks.
- Mockup and private server charge 0.2 CPU per successful intent like the official server (inside `Game.cpu.getUsed()`).
- Not the full world (no other players, no backend jobs): confirm on the private server before concluding. Don't run `compare.sh` twice at once.

### Private server and live

```bash
docker compose up -d && npm run test:server         # local server (Steam API key in config.yml), 3000 ticks, PASS/FAIL
npm run inspect:server | npm run watch:server       # live snapshot / follow a run from another session
node scripts/live-inspect.mjs [--server main|pserver]   # shard0 counters, room energy, remotes, spawns (token from screeps.json)
node scripts/shard0-neighbours.mjs --radius 5       # other players around us
```

### CI (`.github/workflows/ci.yml`)

`build` (install, build, lint, compile, every `tests/*/run.mjs`) and `mockup` (3000 ticks on W7N3 and W1N3, `--min-points` 1400 / 600, `--max-cpu 40`). `package.json` pins `@types/lodash` 3.10.2, `@types/screeps` 3.3.8 and picomatch 2.3.1 (no lockfile). ESLint ignores `.claude/`: lint a worktree with `npx eslint --no-ignore src`.

## Configuration

- Copy `screeps.example.json` to `screeps.json` with your Steam API key for deployment
- Copy `config.example.yml` to `config.yml` for local dev server, then `docker compose up -d`

## Architecture

### Game loop (`src/gameLoop.ts`, `src/ModuleManager.ts`)

The ModuleManager runs modules in order with a CPU budget (80% of the limit): `mandatory` modules always run (errors in `Memory.moduleErrors`), others support `runEvery`, `disabled`, `maxSkips` and bucket throttling by `priority` (`always`, `high`, `default`, `low`; `src/utils/throttle.ts`). Per-module CPU in `Memory.moduleState` and the counters `cpu:module:<name>`.

| Module | Frequency | Role |
|---|---|---|
| RoomIntel | mandatory | Hostiles in visible rooms (`room.memory.enemies`), contested remotes |
| RoomPlanner | every 10 | Each owned room's plan, once (segments 3-4) |
| CreepRunner | mandatory | Runs every creep through its role handler (`src/roles/`) |
| SpawnManager | mandatory | Best spawn option per room, one creep per room and tick |
| RoomBuilder | every 20 | Construction sites from the plan |
| RoomCleanup | every 100 | Other players' structures in our rooms, structures off the final plan |
| Defense | every tick | Towers and safe mode (`src/defense/`) |
| Links | every tick (transfer every 3) | Source, controller and storage links (`src/modules/Links.ts`) |
| IntelManager | every tick | Static intel of every seen room (segments 1-2) |
| RemoteMining | every tick (selection every 20) | Remote sources each owned room mines, CPU budget |
| Expansion | every 5 | Claims and bootstraps new rooms (`src/expansion/`) |
| MarketManager | every 20 | Sells surpluses, buys missing minerals |
| TerminalTransfers | every 5 | Terminal sends between owned rooms |
| Labs | every tick | Boosts, then reactions (`src/labs/`) |
| Military | every tick | Targets, squads, looting (`src/military/`) |
| ScoutManager | every 10 | Scouts rooms within 3-5 rooms of the closest owned room |
| MemoryCleanup | every tick (work on elapsed ticks) | Memory of dead creeps and abandoned rooms |
| MiningStats | every tick | Share of source energy harvested |
| RoomVisuals | every tick | Plan, panel, spawn overlay, world map layers (`src/visuals/`) |
| Reports | every tick | Periodic `Game.notify` report and alerts |
| History | every tick (snapshot every 1000) | Counter history, spawn log, remote balance (segments 6-7) |
| TrafficManager | mandatory, last | Resolves every move |

Throttled modules can miss `Game.time % n` ticks: periodic work uses elapsed ticks (heap timestamps).

### Economy core (`docs/decisions/economy.md`)

Convention everywhere (`src/core/options.ts` `getBestOption`): **higher priority wins**, then higher weight; negative priority is never chosen; ties go to the first option collected.

- Roles (`src/roles/`, `roles/registry.ts`): harvester, transporter, builder, upgrader, brawler, guardian; remote roles (remoteHarvester, remoteHauler, reserver, remoteBuilder, remoteDefender, dismantler); claimer, pioneer; mineralHarvester, helper, looter; squads.
- Spawning (`src/modules/SpawnManager.ts`, `src/spawning/spawnRoles.ts`): each spawn role returns options; if the best can't be paid yet the room waits. Bodies from `src/core/bodyBuilder.ts` (Hivemind BodyBuilder). Modules request creeps with `spawnManager.requestSpawn(...)` on the same priority scale.
- Dispatcher (`src/dispatcher/`): source / destination providers; a creep's order in `creep.memory.order`, reservations per tick in `src/core/roomState.ts`.
- Planner (`src/planner/`): Hivemind steps and variations scored by `RoomPlanScorer.ts`; bump `PLAN_VERSION` (`RoomPlan.ts`) to replan every room. Offline: `node tests/planner/run.mjs`.
- Construction (`src/construction/`): Hivemind build order; idle rooms skipped until something changes.
- Remote mining (`src/remote/`): selection every 20 ticks ranked by net energy per spawn part, paths in segment 5 (shared trunks), one home per remote room, measured balance exclusions, contested rooms, remote defense with boosted responses. CPU budget: one 95% share of the limit, the bucket as hysteresis (9000 to add a room, below 8000 to drop one), one change per 1000 ticks (`remoteIncome.ts` `budgetRooms`). `cpuPressure()` (budget capped, or CPU above 85%) is the single CPU signal the visuals and the rescout read.
- Deliberate deviations from Hivemind are each listed with their measurement in `docs/decisions/economy.md`.

### Resources: terminal, market, labs (`docs/decisions/resources.md`)

Minerals, terminal transfers, market pricing (`market/pricing.ts`), reactions by The International's reverse chain (`labs/chain.ts`), boosts (`labs/boosts.ts`, requests expire 150 ticks after spawn), upgrader boosts at RCL 6-7.

### Defense (`docs/decisions/defense.md`)

`enemyStrength`, threat-scaled rampart targets, towers by threat score (`defense/threatModel.ts`), harmless blockers shot, guardians, safe mode, owned room defense spawns.

### Expansion (`docs/decisions/expansion.md`)

From an RCL 5+ room with GCL to spare and CPU that fits (`expansionCpuFits`); claimer + pioneers, support squads, reclaim of rooms that lost their spawn.

### Military (`docs/decisions/military.md`)

Our own design. Automatic targets need a strategic reason (`strategy.ts`: aggressor, expansion, territory, encroacher, stronghold), then a return on investment of at least 1: value (loot, remote income freed, infamy of an aggressor) over cost (spawn energy and boosts of the squad, x2 for replacements, `roi.ts`). Duos and quads (`duo.ts`, `quad.ts`), boosts dosed to the target (`boostNeed.ts`), routes that avoid other players and keeper rooms (`route.ts`), CPU guard (`cpuGuard.ts`), looting after a success (`loot.ts`). `Memory.military = { attack, auto, squad, boosts }` overrides. Freeze: no new military layer until a mission shows a positive balance on shard0.

### Platform (`docs/decisions/platform.md`)

CPU throttling (creeps and modules by bucket), traffic (`TrafficManager`, cartographer + our conflict resolver `core/traffic.ts`), visuals and their CPU gate, reports, Memory (MemHack, segment stores `utils/segments.ts`, history segments 6-7, jittered heap caches).

Removed on 2026-10-27 (off by default, measured neutral or overlapping CPU controls): Pixels, spawn energy order / exit directions, opt-in raids, oversized harvesters, per-CPU reservation judgement, the 75/90/98% budget rules, CPU and spawn time costs in the military ROI. See `docs/decisions/removed.md`.

## Development Notes

- New role: `src/roles/<role>.ts` with `registerRole(...)`, imported by `modules/CreepRunner.ts`; a spawn role in `src/spawning/spawnRoles.ts` (`ECONOMY_SPAWN_ROLES`, alphabetical order breaks ties) or `requestSpawn` from a module.
- New module: export `xModule = () => {...}`, register it in `gameLoop.ts`.
- Pure logic goes in its own module with an offline check in `tests/<name>/run.mjs`, added to CI.
- Counters: `countStat()` (`src/utils/stats.ts`) into `Memory.stats.counters`; room counters into the history.
- CPU target: < 20 CPU with 30 creeps.
- Before adding a feature, state the measured problem it fixes; a feature that measures neutral is removed, not kept.
