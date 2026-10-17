# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Screepy is a TypeScript-based AI bot for the game [Screeps](https://screeps.com/). The code compiles to JavaScript and gets deployed to Screeps servers where it runs autonomously to control game entities (creeps, spawns, towers). Since October 2026 its economy core follows Hivemind's model (roles, spawn options, resource dispatcher, room planner), ported from Hivemind (MIT, see `THIRD_PARTY_NOTICES.md`). Remote mining follows Hivemind too (milestones 2 and 3: remote builders, roads, defense); expansion, scouting and the market remain from the previous design.

## Build & Deploy Commands

```bash
npm install              # Install dependencies (requires Node.js ^24)
npm run build            # TypeScript compilation only (tsc)
npm run compile          # Rollup bundle without deployment
npm run lint             # Run ESLint
npm run lint:fix         # Run ESLint with auto-fix
npm run format           # Format code with Prettier
npm run format:check     # Check code formatting
npm run test             # Clean and build (verification)
npm run clean            # Remove tsc-out and dist folders

# Deploy to different servers (compiles + uploads)
npm run push-main        # Main Screeps server
npm run push-sim         # Simulation server
npm run push-pserver     # Private server
npm run push-seasonal    # Seasonal server
npm run push-screepsplus # ScreepsPlus server
```

## Local Test Server

Verify changes in a real engine before deploying (requires Docker Desktop and a valid Steam API key in `config.yml`):

```bash
docker compose up -d                       # start the local server (first start installs deps, ~3 min)
npm run test:server                        # build, deploy, respawn user "screepy", run 3000 ticks, PASS/FAIL report
npm run test:server -- --ticks 5000 --min-rcl 3
npm run test:server -- --code other/dist/main.js   # test another bundle (e.g. baseline from a git worktree)
npm run test:server -- --room W7N3                  # pick the room (default: first free 2-source room)
npm run test:server -- --list-rooms                 # list candidate rooms with spawn-to-sources range, touches nothing
npm run test:server -- --memory '{"foo":1}'          # initial Memory
npm run test:server -- --preset rcl4                # start from a fast-forwarded room (RCL 4, storage, extensions)
CODES="before=a.js after=dist/main.js" RUNS=2 bash scripts/compare.sh   # bundles x rooms x runs, mean points
npm run inspect:server                     # live snapshot: creeps, structures, errors
npm run inspect:server -- --memory rooms   # dump a Memory path
npm run test:server -- --client            # also open the steamless client on the tested room
npm run watch:server                       # from any other session/worktree: client + progress of the run in progress
```

- Runs are close to deterministic (two runs of the same bundle and room differ by ~1%), so one run per configuration is enough for A/B tests.
- Hivemind rework benchmark: see "Economy core" below. Hivemind 3.0.0 reference (8000 ticks): W7N3 107085, W9N5 189, W1N3 20300.
- Benchmark on several rooms (easy W7N3, medium W9N5, hard W1N3 where sources are ~30 tiles away): tuning on a single room overfits.
- Watching: the harness publishes the run state on the server (redis key `pserver:run`, see `scripts/pserver-lib.mjs`), so `watch:server` follows a run started from another session or worktree (opens the client on the tested room, prints progress and the final PASS/FAIL). `--no-client` for progress only. The compose project is named `screepy` so every worktree talks to the same server.
- One run at a time: the test user is shared, `test:server` refuses to start while another session's run is in progress (`--force` to replace it).
- Steamless client: `screeps-steamless-client` (via npx) serves the official client from Steam's `package.nw` (Screeps must be installed through Steam; found in Steam libraries, or `--package <path>` / `SCREEPS_NW_PACKAGE`), at `http://localhost:8080/(http://localhost:21025)/`, reused if already running. Log in as `screepy` / `screepy`. With `--client` the harness stays up after the report until Ctrl+C; add `--tick-ms 200` to slow the run down enough to follow it.

- Checks: no module errors, RCL reached, creep count, avg CPU, task failure ratio. Reports saved to `test-results/`.
- The bot writes `Memory.stats` (`src/utils/stats.ts`, `countStat()` for custom counters) and `Memory.moduleErrors` (ModuleManager).
- RCL/creeps are read from the server's room objects, so baseline bundles without `Memory.stats` can still be compared.
- Speed: the harness sets `system.setTickDuration(1)` (as fast as the engine goes, ~50 ms/tick). `config.yml` uses `processors: 2` / `runnerThreads: 2`: with 16 processors and one active room, redis coordination made ticks ~4x slower.
- Server quirks: `screepsmod-auth` is pinned to 2.8.3 in `config.yml` (2.9+ crashes with screepsmod-mongo); the admin CLI (port 21026) is only reachable from inside the container, the harness uses `docker compose exec`.

### Mockup (fast)

In-process engine (`screeps-server-mockup` master, vendored built in `scripts/mockup/vendor/`, same engine as the private server: screeps 4.3.0 on Node 24) in a dedicated Docker image `screepy-mockup` (built on first use, ~4 min; `@screeps/driver` compiles native code, no C++ toolchain needed on the host). Independent from the compose stack: runs can go in parallel. ~100 ticks/s on W7N3 (~10 ms/tick over 3000 ticks, ~17 ms/tick over 8000 ticks with 3 runs in parallel; about half of it is the bot own CPU); runs are nearly deterministic (the bot's own randomness, `_.sample`, gives a few % between runs).

```bash
npm run test:mockup                                    # build, 3000 ticks on W7N3, same PASS/FAIL checks as test:server
npm run test:mockup -- --code test-results/bundles/before-ac17616.js --room W1N3 --ticks 8000
npm run test:mockup -- --memory '{"foo":1}' --verbose   # initial Memory, print the bot console
npm run test:mockup -- --list-rooms                    # rooms with a fixture
npm run test:mockup -- --profile                       # + wall ms/tick per main loop stage and CPU per engine process
npm run test:mockup -- --cpu-limit 8                   # lower the bot's CPU limit to drain the bucket (throttling tests)
npm run test:mockup -- --no-fast                       # unpatched engine (upstream main loop, 1 processor, TCP): A/B check of the speed-ups
CODES="before=a.js after=dist/main.js" RUNS=1 JOBS=6 bash scripts/mockup/compare.sh   # like scripts/compare.sh, parallel
node scripts/mockup/extract-fixtures.mjs W5N5          # add a room fixture from the private server (read-only)
```

- Rooms are fixtures (`scripts/mockup/fixtures/<room>.json`): real terrain and natural objects of the room and its 8 neighbours; rooms beyond are walled. Spawn spot = same `findSpawnSpot` as the harness.
- Reports in `test-results/mockup-*.json` (`world.points` = same definition as the harness; `world.storage` energy, `world.remoteRoads`, `world.creepsByRoom` census), compare summary in `test-results/mockup-compare-summary.txt` (points, RCL, storage).
- From-scratch runs reach the storage around tick 11k on W7N3 and 20k+ on W1N3 (W9N5: RCL 3 at 20k): measure storage-era changes with `TICKS=30000`.
- CPU: the mockup and the private server don't charge the official 0.2 CPU per intent. The bot counts successful intents (`src/utils/intents.ts`, counters `intents`, `intents:<method>`), and the reports print `Intents x/tick | official CPU estimate` (code CPU + 0.2 x intents) and `CPU by role (per tick / per creep)` (counters `cpu:<role>`, `creepTicks:<role>`).
- Don't start `compare.sh` twice at once: both write the same logs and summary.
- Not the full world: no other players, no backend/cron jobs. Use it to iterate, confirm on the private server before concluding.
- Speed-ups (default, `--no-fast` disables them all; checked on 3 rooms x 8000 ticks: same points within noise):
  - `scripts/mockup/fast.cjs` (preload, inherited by the engine child processes): no room history (`roomHistory:<room>`, replay data for the web client: the LokiJS storage answers each `hmset` with the whole hash, which grows without bound for rooms not active on a multiple of 20 ticks, so ticks got slower over a run: 16 ms/tick over 3000 ticks, 30-46 ms/tick over 8000 with 3-4 runs in parallel, vs 17-31 now) and no `mapView` writes; the runner fetches `users.code` (the 400+ KB bundle) once instead of every tick; the processor caches room terrain.
  - `sim.cjs` main loop: accessible rooms / room statuses refreshed every 20 ticks like the engine main loop (upstream mockup: every tick), no `tickStarted`/`roomsDone` notifications (backend only), CPU read from the runner `user:<id>/cpu` pubsub instead of a `users.findOne` per tick, storage RPC over a Unix socket, `--processors 2` engine processors (rooms of a tick processed in parallel, as on the private server; 3 brings nothing with ~2 active rooms).
  - Tried without gain: `--max-semi-space-size`. The rest is the bot (isolated-vm) and ~10 storage round trips per stage.
- `scripts/mockup/nodelay.cjs` disables Nagle on the storage RPC sockets (without it a tick takes ~280 ms); the vendored `screepsServer.js` passes `STORAGE_HOST=127.0.0.1` to child processes (Node 17+ resolves `localhost` to `::1`).

## Configuration

- Copy `screeps.example.json` to `screeps.json` with your Steam API key for deployment
- Copy `config.example.yml` to `config.yml` for local dev server, then `docker compose up -d`


## Architecture

Design: `docs/superpowers/specs/2026-10-17-hivemind-economy-rework-design.md`. Exact Hivemind rules with `file:line` sources: `docs/hivemind/hivemind-{spawning,roles,construction}.md`.

### Game loop (`src/gameLoop.ts`, `src/ModuleManager.ts`)

The ModuleManager runs modules in order with a CPU budget (80% of the limit): `mandatory` modules always run (errors logged in `Memory.moduleErrors`, never rerun in the same tick), others support `runEvery`, `runOnce`, `threshold` (bucket), `disabled`, `maxSkips` (forced after N CPU skips), `sleepModule(name, ticks)`. Per-module average CPU in `Memory.moduleState`.

| Module | Frequency | Role |
|---|---|---|
| RoomIntel | mandatory | Hostiles in every visible room: `room.memory.enemies` (`expires` = expected death of the last hostile), `defenseMode` |
| RoomPlanner | every 10 | Computes each owned room's plan once (`Memory.rooms[r].plan`) |
| CreepRunner | mandatory | Runs every creep through the handler of its `memory.role` |
| SpawnManager | mandatory | Best spawn option per room, one creep per room and tick |
| RoomBuilder | every 20 | Construction sites from the plan, max 5 per room |
| TowerManager, IntelManager | every tick | Towers; room intel |
| RemoteMining | every tick (selection every 20) | Remote sources each owned room mines |
| ScoutManager (10), ExpansionManager (50, disabled until milestone 6: claimers without a path), MarketManager (20) | | Kept from the previous design (scout: from RCL 1, priority 4 before the storage) |
| TrafficManager | mandatory, last | Resolves every move (cartographer `reconcileTraffic`) |

### Economy core

Convention everywhere (`src/core/options.ts` `getBestOption`): **higher priority wins**, then higher weight; negative priority is never chosen; ties go to the first option collected.

- **Roles** (`src/roles/`, registered in `roles/registry.ts`): `harvester` (bound to a source, stationary on its planned harvest position = source container once a transporter exists, delivers like a transporter before), `transporter` (90%/10% hysteresis, orders revalidated every tick), `builder` (works from 90% full, builds/repairs, upgrades when nothing to do, never harvests), `upgrader`, `brawler` (RCL < 4 defense). `remoteHarvester`, `remoteHauler`, `reserver` (`src/roles/remote*.ts`, `reserver.ts`; flee hostiles that can fight, `roles/flee.ts`). Scout and claimer register their own handlers in their modules.
- **Spawning** (`src/modules/SpawnManager.ts`, `src/spawning/spawnRoles.ts`): each spawn role returns options (priority, weight); if the best option can't be paid yet the room waits (no cheaper fallback). Bodies from `src/core/bodyBuilder.ts` (exact port of Hivemind's BodyBuilder, `MoveMode`). Modules ask for creeps with `spawnManager.requestSpawn({ id, roomName, body, priority, memory })` on the same scale (harvesters 4-6, builders 3-4, remote/claimer 3, scout 1).
- **Dispatcher** (`src/dispatcher/`): `sourceDispatcher` / `destinationDispatcher` with providers (container, drop, grave, storage, overfullExtension / spawn, bay, tower, controller container, workerCreep, storage, drop at the base center). A creep's order lives in `creep.memory.order`; "reservation" = priority penalty per creep holding the same order, indexed per tick in `src/core/roomState.ts` (`creepsWithOrder`, `setOrder`, `clearOrder`).
- **Room state** (`src/core/roomState.ts`): per-tick caches (creeps by role and home room, structures by type), source/controller containers, storage location (plan center before the storage), effective energy, bays.
- **Planner** (`src/planner/`): one "weighted" Hivemind variation (center, harvest positions, upgrader spot + controller container, exit corridors, core, harvest bays, extension bays, towers), packed in `Memory.rooms[r].plan`; bump `PLAN_VERSION` (`RoomPlan.ts`) to replan every room. Offline check: `node tests/planner/run.mjs` (ASCII plans in `test-results/plan-<room>.txt`).
- **Construction** (`src/construction/RoomBuilder.ts`): Hivemind order — RCL 1 spawns; RCL 2+ extensions bay by bay, source and controller containers, swamp roads to sources/controller; RCL 3 harvester-bay extensions, towers; RCL 4 storage, then every planned road once the storage is built.

- **Remote mining** (`src/remote/`, rules in `docs/hivemind/hivemind-remote.md`): every 20 ticks each owned room with a plan keeps its 5 best remote rooms (4 from RCL 4) within 3 rooms, scored 3000 / shortest path from a source to the planned storage (`Memory.remoteMining`, paths cached 5000 ticks, failures 500). Spawn role `remote` (one option per tick, closest source first): hauler (once the container exists, CARRY = 2 x travel x energy/tick / 50), harvester (first one priority 1, then 3; places, builds and repairs the container), reserver (from 650 capacity, one per free tile around the controller). Haulers deliver at home through the destination dispatcher. A remote with a dangerous hostile (or on the way) gets no spawn until the hostile is expected dead.
- **Storage era (milestone 3)**: remote builders (`roles/remoteBuilder.ts`, Hivemind `builder.mines`; only with a storage and 5000 effective energy, priority 3, weight 0, WORK demand `ceil(0.7 + 0.03 x path tiles outside our rooms)` per mined source needing repairs) step along the remote path, repair/build the road tiles i-2..i+2 around them and the container, and refill at the home storage. In the home room, `RoomBuilder` places the roads of the remote paths at RCL 4 with a storage. Remote defense (`remote/remoteDefense.ts`, role `remoteDefender`, part of the `brawler` spawn role): priority 3 / weight 1, an ATTACKER against invader cores, a mini brawler or mini blinky against weak hostiles once the home has 5000 effective energy, one per remote every 300 ticks; stronger threats get none. `RoomIntel` keeps the hostiles' damage/heal/ranged and invader core collapse timers. Not ported: dismantlers, source keepers, trains.

Deliberate deviations from Hivemind, each measured on the 3 benchmark rooms (mockup, 8000 ticks):
- Transporter count also covers the loaded round trip from each source to the storage location (Hivemind: fixed 3) — W1N3 12.9k -> 24.6k.
- Builders/transporters get 1 MOVE per part while the haul paths are mostly swamp and the room has < 20 roads (Hivemind: road bodies) — W9N5 700 -> 4.2k with the early upgrader.
- One upgrader from RCL 2 before the storage, spawned at priority 4 (Hivemind: 0, builders upgrade once construction is done; W9N5's swamp construction never ended). Two upgraders were worse on W9N5.
- With at least one transporter, missing transporters weigh 0.6 instead of 0 so they beat builders (energy rotting by the sources inflated the builder quota and choked W9N5).
- Spawn starvation: waiting 50 ticks for energy that doesn't rise sizes bodies on the energy available.
- The plan's base center is the candidate closest to the existing spawn (Hivemind ignores it) — W9N5 3.4k -> 4.6k, W7N3 -2%.
- Remote: a room without any source path is skipped (Hivemind scored it 6); a failed path is retried after 500 ticks, never cached before the plan exists (Hivemind: 5000); haulers' delivery orders count in `creepsWithOrder`.
- W9N5 is noisy (single runs from ~2.8k to ~5.5k): compare means of 3 runs there.

Counters in `Memory.stats.counters`: `spawned:<role>`, `work:{harvest,build,repair,upgrade,builderUpgrade,builderFetch,remoteHarvest,remoteBuild,remoteRepair}`, `deliver:<order type>`, `idle:<role>`, `harvester:{walking,delivering}`, `spawn:starved`, `roleError:<role>`, `moveError:<code>:<role>`.

### CPU throttling (`src/utils/throttle.ts`, Hivemind)

- Creeps (`CreepRunner`): below a role's `throttleAt` bucket its logic is skipped on a growing share of ticks (spread per creep by a Van der Corput sequence), on every tick below `stopAt`; every creep is skipped once the tick used 85% of `Game.cpu.tickLimit` (except on exit tiles). Thresholds: harvester/upgrader 0/2000, transporter 0/5000, remote harvester 2000/5000, defenders and reservers never, others 2000/8000. Counter `throttled:<role>`.
- Modules (`ModuleManager`, `priority`): `always` (mandatory, towers), `high` 500/5000 (remote mining), `default` 3000/8000, `low` 5000/9500 (scout, market): the interval is multiplied by the recent CPU use, this tick's use above half the limit and the bucket below `throttleAt`; stopped below `stopAt`. `Memory.moduleState[m].throttled` counts held-back ticks.
- Measured (W7N3, CPU limit 8, mockup): without throttling the bucket sits at 0 and the script is killed every tick; with it the bucket holds ~3000 and nothing is killed.
- Official CPU (W7N3, RCL 4 + 5 remotes, ~30 creeps): ~13 code + ~30 intents x 0.2 = ~19. Intents by type per tick: move 12, harvest 7.6, upgrade 3.9, reserve 2.4.

### Traffic (`src/modules/TrafficManager.ts`)

All movement goes through `trafficManager.requestMove(creep, pos, { range, priority })` (lower priority value = more important), backed by `screeps-cartographer`. `whenInRange(creep, range, target, action)` (`src/core/movement.ts`) registers the move — or the "stay in range" intent once there — every tick, then runs the action: working creeps must call it every tick so they are not shoved away.

## Development Notes

- New role: `src/roles/<role>.ts` with `registerRole(...)`, imported by `modules/CreepRunner.ts`; a spawn role in `src/spawning/spawnRoles.ts` (`ECONOMY_SPAWN_ROLES`, alphabetical order breaks ties) or `requestSpawn` from a module.
- New module: export `xModule = () => {...}`, register it in `gameLoop.ts`.
- Validate with the mockup first (`scripts/mockup/compare.sh`, 3 rooms), confirm on the private server (`scripts/compare.sh`).
- CPU target: < 20 CPU with 30 creeps.
