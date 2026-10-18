# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Screepy is a TypeScript-based AI bot for the game [Screeps](https://screeps.com/). The code compiles to JavaScript and gets deployed to Screeps servers where it runs autonomously to control game entities (creeps, spawns, towers). Since October 2026 its economy core follows Hivemind's model (roles, spawn options, resource dispatcher, room planner), ported from Hivemind (MIT, see `THIRD_PARTY_NOTICES.md`). Remote mining (milestones 2-3), CPU throttling (4), the full planner and base defense (5) and expansion (6) follow Hivemind too; scouting and the market remain from the previous design. Offense is ours to design (open-source bots keep it private).

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
npm run test:mockup -- --cpu-limit 13                  # lower the bot's CPU limit (13 code CPU ~ 20 official CPU with intents)
npm run test:mockup -- --raid 9000:smallMelee+smallRanged,15000:bigMelee+bigRanged   # invader raids (backend bodies), outcome in the report
npm run test:mockup -- --raid 13500:smallMelee@W7N4   # raid in another room of the fixture (a remote)
npm run test:mockup -- --no-fast                       # unpatched engine (upstream main loop, 1 processor, TCP): A/B check of the speed-ups
CODES="before=a.js after=dist/main.js" RUNS=1 JOBS=6 bash scripts/mockup/compare.sh   # like scripts/compare.sh, parallel
node scripts/mockup/extract-fixtures.mjs W5N5          # add a room fixture from the private server (read-only)
```

- Rooms are fixtures (`scripts/mockup/fixtures/<room>.json`): real terrain and natural objects of the room and its 8 neighbours; rooms beyond are walled. Spawn spot = same `findSpawnSpot` as the harness.
- Reports in `test-results/mockup-*.json` (`world.points` = same definition as the harness; `world.storage` energy, `world.remoteRoads`, `world.creepsByRoom` census, `memorySize` by Memory key; the log prints `Memory <chars>`), compare summary in `test-results/mockup-compare-summary.txt` (points, RCL, storage).
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

The ModuleManager runs modules in order with a CPU budget (80% of the limit): `mandatory` modules always run (errors logged in `Memory.moduleErrors`, never rerun in the same tick), others support `runEvery`, `disabled`, `maxSkips` (forced after N CPU skips) and bucket throttling by `priority` (see CPU throttling). Per-module average CPU in `Memory.moduleState`; the memory size (`RawMemory.get().length`) is checked every 100 ticks.

| Module | Frequency | Role |
|---|---|---|
| RoomIntel | mandatory | Hostiles in every visible room: `room.memory.enemies` (`expires` = expected death of the last hostile), `defenseMode` |
| RoomPlanner | every 10 | Computes each owned room's plan once (`Memory.rooms[r].plan`) |
| CreepRunner | mandatory | Runs every creep through the handler of its `memory.role` |
| SpawnManager | mandatory | Best spawn option per room, one creep per room and tick |
| RoomBuilder | every 20 | Construction sites from the plan, max 5 per room |
| Defense | every tick (priority always) | Towers (military target, heal, rampart repair under attack) and safe mode (`src/defense/`) |
| IntelManager | every tick | Static intel of every seen room, owned ones included (`Memory.intel`: sources, controller, mineral, owner/reserver, source keepers; refreshed every 100 ticks while visible). Hostiles and invader cores only in RoomIntel (`hasInvaderCore()`). Room name helpers: `src/utils/rooms.ts` |
| RemoteMining | every tick (selection every 20) | Remote sources each owned room mines |
| Expansion | every 5 (priority high) | Claims and bootstraps new rooms, reclaims rooms that lost their spawn (`src/expansion/`) |
| ScoutManager (10), MarketManager (20, disabled until the terminal milestone) | | Kept from the previous design (scout: from RCL 1, priority 4 before the storage; range 3 rooms, 5 from RCL 4; rescouts rooms never seen, older than 50000 ticks, or with a controller seen more than 10000 ticks ago) |
| MemoryCleanup | every tick (work every 100 / 1000) | Drops the memory of dead creeps, and of rooms not owned, not mined, not targeted and without a living hostile |
| MiningStats | every tick | Share of the source energy harvested: each source's energy left on its last regeneration tick is lost, a full untouched source loses its capacity (our rooms' sources and selected remotes, while visible; last 5 cycles in heap, counters `mining:{available,wasted}:{local,remote}`). Mockup 20000 ticks: W7N3 local 96% / remote 84%, W1N3 94 / 77, W9N5 80 / 76; ~0.01 CPU |
| RoomVisuals | every tick (priority low) | Plan overlay and economy panel on owned rooms (`src/visuals/`) |
| TrafficManager | mandatory, last | Resolves every move (cartographer `reconcileTraffic`) |

### Economy core

Convention everywhere (`src/core/options.ts` `getBestOption`): **higher priority wins**, then higher weight; negative priority is never chosen; ties go to the first option collected.

- **Roles** (`src/roles/`, registered in `roles/registry.ts`): `harvester` (bound to a source, stationary on its planned harvest position = source container once a transporter exists, delivers like a transporter before), `transporter` (90%/10% hysteresis, orders revalidated every tick), `builder` (works from 90% full, builds/repairs, upgrades when nothing to do, never harvests), `upgrader`, `brawler` (RCL < 4 defense), `guardian` (RCL 4+, holds the rampart closest to the hostiles). `remoteHarvester`, `remoteHauler`, `reserver` (`src/roles/remote*.ts`, `reserver.ts`; flee hostiles that can fight, `roles/flee.ts`). `claimer`, `pioneer` (expansion, `roles/claimer.ts`, `roles/pioneer.ts`). The scout registers its handler in its module.
- **Spawning** (`src/modules/SpawnManager.ts`, `src/spawning/spawnRoles.ts`): each spawn role returns options (priority, weight); if the best option can't be paid yet the room waits (no cheaper fallback). Bodies from `src/core/bodyBuilder.ts` (exact port of Hivemind's BodyBuilder, `MoveMode`). Modules ask for creeps with `spawnManager.requestSpawn({ id, roomName, body, priority, memory })` on the same scale (harvesters 4-6, builders 3-4, remote/claimer 3, scout 1).
- **Dispatcher** (`src/dispatcher/`): `sourceDispatcher` / `destinationDispatcher` with providers (container, drop, grave, storage, overfullExtension / spawn, bay, tower, controller container, workerCreep, storage, drop at the base center). A creep's order lives in `creep.memory.order`; "reservation" = priority penalty per creep holding the same order, indexed per tick in `src/core/roomState.ts` (`creepsWithOrder`, `setOrder`, `clearOrder`).
- **Room state** (`src/core/roomState.ts`): per-tick caches (creeps by role and home room, by duo / squad (`duoCreeps`, `squadCreeps`), structures by type), source/controller containers, storage location (plan center before the storage), path length storage location -> controller container (`controllerRefillPathLength`, shared by spawning and dispatcher, not cached while the container is missing), effective energy, bays.
- **Planner** (`src/planner/`): Hivemind steps (center, harvest positions, upgrader spot + controller container, exit corridors, core, harvest bays, extension bays, ramparts on the min cut around the protected structures (`minCut.ts`), safe area (`safe` tiles; nothing built outside), towers placed greedily by rampart coverage plus 0.5 x their cover of the core (spawns, storage) and built closest to the center first (not in Hivemind: far chokepoints pulled every tower 10-20 tiles away from the base on W29N7), roads to the ramparts, on-ramps), packed in `Memory.rooms[r].plan` (`k` variation, `s` score, `done`). Variations (`listVariations`): a center ("weighted", then the tile farthest from walls in each cell of a 3x3 grid; a room with a spawn keeps its center next to it) x every combination of sources with or without a spawn in their bay; scored by `RoomPlanScorer.ts` (structures, upkeep, tower cover, ramparts near exits, travel distances). The first variation is stored at once (the economy needs a plan from tick 1), the others are tried over the next runs (CPU budget 50% of the limit) and the best replaces it while nothing but the first spawn is built; a room without spawn waits for the final plan before building. Bump `PLAN_VERSION` (`RoomPlan.ts`) to replan every room. Offline check: `node tests/planner/run.mjs [ROOM...]` (all variations, scores, defense geometry: ramparts, safe tiles, tower ranges to the center in build order, tower cover of the core and of the ramparts; ASCII plan of the best in `test-results/plan-<room>.txt`, ~22 ms per variation in node). Fixtures in `tests/planner/data/` (`W29N7` = the live room, `W29N7-live` with its existing spawn).
- **Construction** (`src/construction/RoomBuilder.ts`): Hivemind order — RCL 1 spawns; RCL 2+ extensions bay by bay, source and controller containers, swamp roads to sources/controller; RCL 3 harvester-bay extensions, towers, ramparts (main ones, then on-ramps; not during a safe mode > 2000 ticks); RCL 4 storage, then every planned road once the storage is built.

- **Remote mining** (`src/remote/`, rules in `docs/hivemind/hivemind-remote.md`): every 20 ticks each owned room with a plan keeps its 5 best remote rooms (4 from RCL 4) within 3 rooms, scored 3000 / shortest path from a source to the planned storage (`Memory.remoteMining`, paths cached 5000 ticks, failures 500; one copy per source in `paths`, packed by `utils/pathCodec.ts`: start position + 1 direction digit per step, `node tests/pathCodec/run.mjs` checks it, decoded paths cached in heap; `remotePath(source)`). Spawn role `remote` (one option per tick, closest source first): hauler (once the container exists, CARRY = 2 x travel x energy/tick / 50), harvester (first one priority 1, then 3; places, builds and repairs the container), reserver (from 650 capacity, one per free tile around the controller). Haulers deliver at home through the destination dispatcher. A remote with a dangerous hostile (or on the way) gets no spawn until the hostile is expected dead.
- **Storage era (milestone 3)**: remote builders (`roles/remoteBuilder.ts`, Hivemind `builder.mines`; only with a storage and 5000 effective energy, priority 3, weight 0, WORK demand `ceil(0.7 + 0.03 x path tiles outside our rooms)` per mined source needing repairs) step along the remote path, repair/build the road tiles i-2..i+2 around them and the container, and refill at the home storage. In the home room, `RoomBuilder` places the roads of the remote paths at RCL 4 with a storage. Remote defense (`remote/remoteDefense.ts`, role `remoteDefender`, part of the `brawler` spawn role): priority 3 / weight 1, an ATTACKER against invader cores, a mini brawler or mini blinky against weak hostiles once the home has 5000 effective energy, one per remote every 300 ticks; stronger threats get none. `RoomIntel` keeps the hostiles' damage/heal/ranged and invader core collapse timers. Not ported: dismantlers, source keepers, trains.

Deliberate deviations from Hivemind, each measured on the 3 benchmark rooms (mockup, 8000 ticks):
- Transporter count also covers the loaded round trip from each source to the storage location (Hivemind: fixed 3) — W1N3 12.9k -> 24.6k.
- Builders/transporters get 1 MOVE per part while the haul paths are mostly swamp and the room has < 20 roads (Hivemind: road bodies) — W9N5 700 -> 4.2k with the early upgrader.
- One upgrader from RCL 2 before the storage, spawned at priority 4 (Hivemind: 0, builders upgrade once construction is done; W9N5's swamp construction never ended). Two upgraders were worse on W9N5.
- With at least one transporter, missing transporters weigh 0.6 instead of 0 so they beat builders (energy rotting by the sources inflated the builder quota and choked W9N5).
- Spawn starvation: waiting 50 ticks for energy that doesn't rise sizes bodies on the energy available.
- The plan's base center is the candidate closest to the existing spawn (Hivemind ignores it) — W9N5 3.4k -> 4.6k, W7N3 -2%.
- Remote CPU budget (`RemoteMining.ts` `updateBudget`): an empire-wide cap on remote rooms from the tick CPU averaged over ~400 ticks (official CPU includes intents): above 95% of the limit or bucket < 5000 the worst scored remote room goes, below 75% with bucket > 9000 one comes back, at most one change per 1000 ticks (`Memory.remoteMining.maxRooms`, counter `remote:budgetChange`). Mockup, `--cpu-limit 13` (~20 official), 20000 ticks: W9N5 85k -> 110k (RCL 2 at 12.7/13 CPU with 34 creeps: capped to 3 remotes, RCL 3 sooner, then uncapped), W1N3 183k -> 192k, W7N3 381k -> 355k (single runs). 85% / 70% thresholds oscillated and cut W7N3 by 27%.
- Remote: a room without any source path is skipped (Hivemind scored it 6); a failed path is retried after 500 ticks, never cached before the plan exists (Hivemind: 5000); haulers' delivery orders count in `creepsWithOrder`.
- Planner: the base center is never built on (towers placed by coverage landed on it in W9N5, blocking every path to the energy drop point; the variation scored -68.9 instead of 2.4); no exit direction is ever considered safe (Hivemind: exits only enemies can't reach); without any rampart, towers go on the flood spots closest to the center; the first variation is used at once and replaced by the best one only while nothing is built.
- W9N5 is noisy (single runs from ~2.8k to ~5.5k): compare means of 3 runs there.

Counters in `Memory.stats.counters`: `spawned:<role>`, `work:{harvest,build,repair,upgrade,builderUpgrade,builderFetch,remoteHarvest,remoteBuild,remoteRepair}`, `deliver:<order type>`, `idle:<role>`, `harvester:{walking,delivering}`, `spawn:starved`, `roleError:<role>`, `moveError:<code>:<role>`.

### Defense (`src/defense/`, Hivemind `room-defense.ts`, `manager.military.ts`, `process/rooms/owned/defense.ts`)

- `enemyStrength(room)`: NONE / WEAK (invaders only, or towers out-heal and walls hold) / NORMAL / STRONG / DEADLY, from the hostiles' attack and heal (boosts included), the towers, the energy capacity and the weakest planned rampart. `isWallIntact`: every planned main rampart built. `desiredWallStrength`: maxWallHealth[rcl] (x2 during the safe mode cooldown); builders repair ramparts up to it (on-ramps to a tenth).
- Towers: shoot the hostile with the highest military priority (our damage minus its healing, times its value), only if it can't just drain them at the room edge; else heal wounded fighters (any wounded creep without enemies); else, from NORMAL enemies with half a tower of energy, repair the weakest rampart a hostile can hit. Towers repair nothing else.
- Safe mode: enemies present (any strength with a single room), ramparts not complete, a spawn exists and a dangerous hostile is within 2 (4 if ranged) of a spawn, the storage, the controller...
- Spawn: remote defenders (spawn role `brawler`, see remote mining) and owned room defense (`roomDefense`): brawler below RCL 4, also during a safe mode (deviation: Hivemind waits for its last 500 ticks, so an early invader lived through the first room's 20000-tick safe mode); from RCL 4 and NORMAL enemies, up to 5 guardians (1 ranged per 4) at priority 5 and up to 5 emergency builders (priority 4) with 10000 energy. Remote spawning stops while enemies at home are NORMAL or stronger.
- Not ported: allies / rampart opening, nukes, boosts for defenders, quad breaker and decorative walls.

### Expansion (`src/expansion/`, Hivemind `process/strategy/expand.ts`, `builder.remote`, rules in `docs/hivemind/hivemind-expansion.md`)

- When: a room at RCL 5+ (where the squad spawns; Hivemind: 4, which searched targets with no origin), fewer owned rooms than the GCL, `Memory.stats.cpuAvg` below the CPU limit (80% of it with several rooms). Target: best expansion score (`expansionScore.ts`: sources, new mineral, remote sources around, shared remotes, exit/wall/swamp tiles, distance > 3 rooms; cached 20000 ticks) among scouted rooms nobody owns, lowered near past failures, reachable in <= 10 rooms from an RCL 5+ room with a spawn; no target: next search in 500 ticks.
- Squad `expand` (`Memory.expand.squads`, spawn role `squad`, priority 4 above 10000 effective energy, 2 from 5000, weight 1.1): a claimer (1 CLAIM, swamp moves; attacks hostile reservations), 2 pioneers, a defender while the target has hostiles. Support squads: 1 pioneer from every other RCL 4+ room with 50000 energy. The spawn room mines one remote less meanwhile.
- Pioneers (`builder.remote`): fill up at home (if >= 3000 energy), then live in the target: upgrade to RCL 2 first, fill spawn and towers, build towers > spawn > closest site, get energy from piles, storage, containers or by harvesting. The new room plans its variations and builds its spawn from the final plan; it mines no remote before its spawn.
- Ends with RCL 4 + storage (success), or after 7500 ticks unclaimed / 30000 ticks after the claim (failure, remembered 1M ticks). Reclaim (spawn role `reclaim`, priority 3): an owned room without spawn (not the target, >= 2 rooms) gets up to 5 pioneers from rooms with 10000 energy and bucket >= 8000.
- Deviations: units spawn claimer first (Hivemind: random), the defender only against hostiles (Hivemind: always one), the claim happens on arrival; no exit direction is safe in the score. Not ported: tunnels to the controller, evacuation, terminal help (RCL 6).
- Mockup: `--gcl 2` allows a second room; the report lists `world.ownedRooms`.

### Military (`src/military/`, our own design, milestone 7 step 1)

- `Memory.military.attack = "<room>"` (by hand for now) sends a duo from the closest RCL 4+ room (`minRcl` to lower it in tests): an attacker (ATTACK + MOVE) and a healer (HEAL + MOVE), spawn role `military` (priority 3, effective energy >= 2000). Ends when the room has no spawn and no tower left (success) or after 10 lost creeps.
- `combat.ts`: worst damage on a tile next tick (every enemy tower focusing, melee within 2, ranged within 4) vs our healing; verdict safe (healing outpaces damage), rescue (survives 3 ticks), doomed.
- `duo.ts`: forming -> advance -> retreat (below 60% hits) -> advance (from 95%). The attacker only steps with the healer next to it; nobody steps onto a tile that kills it within 3 ticks, evaluated on the tile it really lands on (exit tiles carry creeps to the next room); when only the healer would be doomed the attacker goes in alone and comes back to be healed, which drains towers. In the room: towers, then spawns, then other structures, breaking the weakest ramparts on the way (path cost by hits). The healer has the higher traffic priority so the attacker never shoves it onto an exit. Trace: `[Duo]` log lines (state changes, every 10 ticks near the target, last tick's actions).
- Mockup: `--enemy W8N3:3[:defenders[:ringHits]]` builds an enemy base (full towers, ramparts on spawn and towers, a ring of ramparts at range 5, no safe mode) run by `scripts/mockup/enemy-bot.js`; the report gives `enemy` (spawns, towers, tower energy, ramparts).
- Measured (W7N3 vs W8N3 RCL 3, 1 tower, 30k ring): duo out at tick 10519, tower drained by in-and-out, ring breached, tower and spawn destroyed at tick 12565, 2 creeps lost (old age).
- Known: our body builder makes no ATTACK part with a TOUGH weight (attacker is ATTACK only for now).

### CPU throttling (`src/utils/throttle.ts`, Hivemind)

- Creeps (`CreepRunner`): below a role's `throttleAt` bucket its logic is skipped on a growing share of ticks (spread per creep by a Van der Corput sequence), on every tick below `stopAt`; every creep is skipped once the tick used 85% of `Game.cpu.tickLimit` (except on exit tiles). Thresholds: harvester/upgrader 0/2000, transporter 0/5000, remote harvester 2000/5000, defenders and reservers never, others 2000/8000. Counter `throttled:<role>`.
- Modules (`ModuleManager`, `priority`): `always` (mandatory, towers), `high` 500/5000 (remote mining), `default` 3000/8000, `low` 5000/9500 (scout, market): the interval is multiplied by the recent CPU use, this tick's use above half the limit and the bucket below `throttleAt`; stopped below `stopAt`. `Memory.moduleState[m].throttled` counts held-back ticks.
- Measured (W7N3, CPU limit 8, mockup): without throttling the bucket sits at 0 and the script is killed every tick; with it the bucket holds ~3000 and nothing is killed.
- Official CPU (W7N3, RCL 4 + 5 remotes, ~30 creeps): ~13 code + ~30 intents x 0.2 = ~19. Intents by type per tick: move 12, harvest 7.6, upgrade 3.9, reserve 2.4.

### Visuals (`src/visuals/`)

- Every owned room: the planned structures not built yet (opacity 0.2, a shape and color per structure type) and the outline of the planner's `safe` area (`planVisual.ts`, redrawn every 100 ticks or when the plan changes); a minimalist two-column table top left (`panel.ts`, every 5 ticks; thin bars green, orange then red only when something needs attention, empty rows left out): controller % and ETA (progress rate over 1000 ticks, heap), energy, storage, empire income from the `work:harvest` / `work:remoteHarvest` counters, CPU and bucket, mining efficiency (`MiningStats`, also a % above each source of the room and per remote room); creeps by role (short names), spawning and the role waiting for energy (`spawnManager.nextRole`), construction sites; defense (enemy strength, towers energy), safe mode, remotes, plan while searching, expansion, attack.
- Each layer is cached as a `RoomVisual` export in the heap and imported on the other ticks. `Memory.visuals = false` turns it off. Priority `low`: skipped as the bucket drops below 9500, so the visuals flicker or vanish then.
- Cost (mockup, W7N3, 3000 ticks): ~0.06 CPU/tick, ~300 elements (34 KB) per room; the module logs both every 1000 ticks.

### Traffic (`src/modules/TrafficManager.ts`)

All movement goes through `trafficManager.requestMove(creep, pos, { range, priority })` (lower priority value = more important), backed by `screeps-cartographer`. `whenInRange(creep, range, target, action)` (`src/core/movement.ts`) registers the move — or the "stay in range" intent once there — every tick, then runs the action: working creeps must call it every tick so they are not shoved away.

## Development Notes

- New role: `src/roles/<role>.ts` with `registerRole(...)`, imported by `modules/CreepRunner.ts`; a spawn role in `src/spawning/spawnRoles.ts` (`ECONOMY_SPAWN_ROLES`, alphabetical order breaks ties) or `requestSpawn` from a module.
- New module: export `xModule = () => {...}`, register it in `gameLoop.ts`.
- Validate with the mockup first (`scripts/mockup/compare.sh`, 3 rooms), confirm on the private server (`scripts/compare.sh`).
- CPU target: < 20 CPU with 30 creeps.
