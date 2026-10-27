# Decisions: tooling

Design notes and measurements moved out of CLAUDE.md on 2026-10-27 (verbatim). Features removed the same day are in `removed.md`.

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

## Mockup (fast)

In-process engine (`screeps-server-mockup` master, vendored built in `scripts/mockup/vendor/`, same engine as the private server: screeps 4.3.0 on Node 24) in a dedicated Docker image `screepy-mockup` (built on first use, ~4 min; `@screeps/driver` compiles native code, no C++ toolchain needed on the host). Independent from the compose stack: runs can go in parallel. ~100 ticks/s on W7N3 (~10 ms/tick over 3000 ticks, ~17 ms/tick over 8000 ticks with 3 runs in parallel; about half of it is the bot own CPU); runs are nearly deterministic (the bot's own randomness, `_.sample`, gives a few % between runs).

```bash
npm run test:mockup                                    # build, 3000 ticks on W7N3, same PASS/FAIL checks as test:server
npm run test:mockup -- --code test-results/bundles/before-ac17616.js --room W1N3 --ticks 8000
npm run test:mockup -- --memory '{"foo":1}' --verbose   # initial Memory, print the bot console
npm run test:mockup -- --dump-memory --memory @test-results/x-memory.json  # Memory + segments at the end in <report>-memory.json; start from a dump
npm run test:mockup -- --list-rooms                    # rooms with a fixture
npm run test:mockup -- --profile                       # + wall ms/tick per main loop stage and CPU per engine process
npm run test:mockup -- --cpu-limit 13                  # lower the bot's CPU limit (intents are charged 0.2 like on the official server)
npm run test:mockup -- --raid 9000:smallMelee+smallRanged,15000:bigMelee+bigRanged   # invader raids (backend bodies), outcome in the report
npm run test:mockup -- --raid 13500:smallMelee@W7N4   # raid in another room of the fixture (a remote)
npm run test:mockup -- --raid '13500:smallMelee*@W7N4'   # "*": boosted like the backend's invaders (GO, UH, KO, ZH, LO); quote it in zsh. Raid creeps carry an `ageTime` (without it the engine's tombstone loot was NaN, so empty)
npm run test:mockup -- --preset rcl4 --enemy W8N3:5   # quick fast-forward at tick 1 (rcl4/rcl5/rcl7: storage, checkerboard extensions, containers) against an enemy base
npm run test:mockup -- --preset rcl4 --stronghold W7N4:1   # invader stronghold (bunker template, deploys at tick 5)
npm run test:mockup -- --preset rcl6 --ticks 4000      # plan-based fast-forward (rcl6, rcl8, plan5..plan8): built from the bot's plan once stored (terminal, minerals, labs)
npm run test:mockup -- --no-fast                       # unpatched engine (upstream main loop, 1 processor, TCP): A/B check of the speed-ups
npm run test:mockup -- --ticks 22000 --save-state test-results/states/W7N3-22k.json   # save the world (objects, game time, Memory) at the end
npm run test:mockup -- --load-state test-results/states/W7N3-22k.json --ticks 15000   # start from it (same room; Memory.stats counters and moduleErrors reset)
npm run test:mockup -- --load-state test-results/states/W7N3-22k.json --set-rcl 5     # ... with the controller forced to RCL 5 (progress 0): RCL 5+ code from an RCL 4 economy
CODES="before=a.js after=dist/main.js" RUNS=1 JOBS=6 bash scripts/mockup/compare.sh   # like scripts/compare.sh, parallel
node scripts/mockup/extract-fixtures.mjs W5N5          # add a room fixture from the private server (read-only)
```

- Rooms are fixtures (`scripts/mockup/fixtures/<room>.json`): real terrain and natural objects of the room and its 8 neighbours; rooms beyond are walled. Spawn spot = same `findSpawnSpot` as the harness.
- Reports in `test-results/mockup-*.json` (`world.points` = same definition as the harness; `world.storage` energy, `world.remoteRoads`, `world.creepsByRoom` census, `memorySize` by Memory key, `segmentSize` by segment id; the log prints `Memory <chars>` and `Segments`), compare summary in `test-results/mockup-compare-summary.txt` (points, RCL, storage).
- From-scratch runs reach the storage around tick 11k on W7N3 and 20k+ on W1N3 (W9N5: RCL 3 at 20k): measure storage-era changes with `TICKS=30000`.
- CPU: the mockup and the private server charge 0.2 CPU per successful intent like the official server, inside `Game.cpu.getUsed()` and the published CPU (`@screeps/driver` `runtime.js` `intentCpu`, `usedTime = ceil(code + intents)`; profiled 2026-10-25: every successful harvest / withdraw / upgrade / reserve call costs 0.21-0.22, a failed move 0.005). Until 2026-10-25 the reports printed `official CPU estimate` = average + 0.2 x intents, counting them twice (W7N3 `--preset rcl6`: 12.29 printed for 9.37), and this file said they were not charged: the earlier `official CPU estimate` figures and "code CPU" figures read from the mockup average include the intents. The bot counts successful intents (`src/utils/intents.ts`, counters `intents`, `intents:<method>`, per role `intents:role:<role>` and `intents:move:<role>`), and the reports print `Intents x/tick (y CPU, included) | official CPU estimate` (the average), `CPU by role (per tick / per creep)` (counters `cpu:<role>`, `creepTicks:<role>`: the role's intents included, its moves not, the TrafficManager issues them) and `Intents per creep-tick (actions / moves)`. `live-inspect` adds `code/creep` = (cpu:<role> - 0.2 x actions) / creep-ticks.
- Don't start `compare.sh` twice at once: both write the same logs and summary.
- States: `--save-state` also saves every 2000 ticks (written atomically), so a run whose engine died can be resumed with `--load-state` + `--save-state` on the same file. On load every `user` reference but the NPCs ("2", "3") becomes the new user (controller reservations and signs included). With many containers at once the Docker VM runs out of memory and kills engine processes: the run then stops after 3 minutes without a tick (exit 2) instead of waiting forever.
- Not the full world: no other players, no backend/cron jobs. Use it to iterate, confirm on the private server before concluding.
- Speed-ups (default, `--no-fast` disables them all; checked on 3 rooms x 8000 ticks: same points within noise):
  - `scripts/mockup/fast.cjs` (preload, inherited by the engine child processes): no room history (`roomHistory:<room>`, replay data for the web client: the LokiJS storage answers each `hmset` with the whole hash, which grows without bound for rooms not active on a multiple of 20 ticks, so ticks got slower over a run: 16 ms/tick over 3000 ticks, 30-46 ms/tick over 8000 with 3-4 runs in parallel, vs 17-31 now) and no `mapView` writes; the runner fetches `users.code` (the 400+ KB bundle) once instead of every tick; the processor caches room terrain.
  - `sim.cjs` main loop: accessible rooms / room statuses refreshed every 20 ticks like the engine main loop (upstream mockup: every tick), no `tickStarted`/`roomsDone` notifications (backend only), CPU read from the runner `user:<id>/cpu` pubsub instead of a `users.findOne` per tick, storage RPC over a Unix socket, `--processors 2` engine processors (rooms of a tick processed in parallel, as on the private server; 3 brings nothing with ~2 active rooms).
  - Tried without gain: `--max-semi-space-size`. The rest is the bot (isolated-vm) and ~10 storage round trips per stage.
- `scripts/mockup/nodelay.cjs` disables Nagle on the storage RPC sockets (without it a tick takes ~280 ms); the vendored `screepsServer.js` passes `STORAGE_HOST=127.0.0.1` to child processes (Node 17+ resolves `localhost` to `::1`).

## Live inspection (`scripts/live-inspect.mjs`)

Read-only CLI over the history segments (see Memory): `node scripts/live-inspect.mjs [--server main|pserver] [--shard shard0]` fetches Memory and segments 6-7 through the official API (token from `screeps.json` `main.token`, header `X-Token`, never printed; pserver signs in with `pserver.email`/`password`; backs off on 429) and prints counter rates per 1000 ticks (mean and the last `--last 6` snapshots; `--match <regex>` or `--all` for other counters), per room energy per 1000 ticks (local / remote income, build / repair / upgrade / spawn spending, spawn energy and idle ticks by role), module and role CPU, the remote balance per source (harvested, delivered, cost, net, delivered/harvested, steady windows of the last 3; a source no longer selected shows its last home with `(dropped)`), the sources excluded by their measured balance (`Memory.remoteExcluded`: home, net, since, until, ticks left) and the last `--spawns 20` spawns with their reason. `--file <report>-memory.json` decodes a mockup `--dump-memory` instead. Snapshots start 1000 ticks after the deploy.

## Other players (`scripts/shard0-neighbours.mjs`)

Read-only CLI over the official API (same token as `live-inspect`): owners and reservations within `--radius 5` rooms of ours (`/game/map-stats`), each player's GCL, rooms and control points per leaderboard season (`/leaderboard/find`), `--rooms a,b` summarises room objects (structures, stores, dropped energy, creeps by owner with parts and names), `--gcl-ticks <n>` samples every player's GCL n ticks apart (control points per tick; a few dozen ticks are too noisy), `--save <file>`. First analysis: `docs/shard0-benchmark-2026-10-23.md`.

## CI (`.github/workflows/ci.yml`)

GitHub Actions on push and pull requests to master. Job `build`: `npm install` (reproducible without a lockfile: `package.json` pins `@types/lodash` 3.10.2 and `@types/screeps` 3.3.8, and forces picomatch 2 to 2.3.1 through `overrides`; newer releases break tsc or rpt2), `npm run build`, `lint`, `compile`, `tests/pathCodec` and `tests/planner`. Job `mockup` (regression gate, TooAngel's idea): builds the `screepy-mockup` image with the buildx GHA cache (label from `run.mjs --image-hash`, so `ensureImage()` reuses it), then runs the built bundle 3000 ticks on W7N3 and W1N3 with the usual checks plus `--min-points` (1400 / 600: ~35% below the mean, only catches a gross break: single 3000-tick runs of one bundle spread by +-18%, W7N3 1614-2318 for the same bundle; the first GitHub runs failed gates of 1950 and 1750) and `--max-cpu 40` (CPU is wall clock in the sandbox: 9-13 on a quiet host, 43 on an overloaded one). Reports are uploaded as artifacts. Raise the thresholds when the economy improves. Mockup options: `--min-points <n>` (FAIL below n world points), `--image-hash`; container names and reports now carry a random suffix (two runs started in the same millisecond used to collide). Note: ESLint ignores files under `.claude/` (worktrees): lint a worktree with `npx eslint --no-ignore src`.
