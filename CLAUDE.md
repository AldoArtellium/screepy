# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Screepy is a TypeScript-based AI bot for the game [Screeps](https://screeps.com/). The code compiles to JavaScript and gets deployed to Screeps servers where it runs autonomously to control game entities (creeps, spawns, towers). The bot implements a full progression from early-game survival through late-game dominance including remote mining, combat, market trading, labs, power creeps, and factories.

## Build & Deploy Commands

```bash
npm install              # Install dependencies (requires Node.js ^20.11)
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
npm run test:server -- --memory '{"config":{"staticMiners":false}}'   # initial Memory (A/B feature switches)
npm run test:server -- --preset rcl4                # start from a fast-forwarded room (RCL 4, storage, extensions)
SWITCH=earlyRoads bash scripts/bench.sh             # matrix rooms x Memory.config switch on/off (npm run compile first), summary in test-results/bench-summary.txt
npm run inspect:server                     # live snapshot: creeps, tasks, queue, errors
npm run inspect:server -- --memory rooms   # dump a Memory path
npm run test:server -- --client            # also open the steamless client to watch the run
npm run client:server                      # steamless client alone (http://localhost:8080/(http://localhost:21025)/)
```

- Feature switches (`Memory.config`): `staticMiners` (default off: 12-29% worse than self-harvesting workers on the 3 benchmark rooms), `earlyRoads` (default on: roads from RCL 2).
- Benchmark on several rooms (easy W7N3, medium W9N5, hard W1N3 where sources are ~30 tiles away): tuning on a single room overfits.
- Steamless client: `screeps-steamless-client` (via npx) serves the official client from Steam's `package.nw` (Screeps must be installed through Steam; found in Steam libraries, or `--package <path>` / `SCREEPS_NW_PACKAGE`). Log in as `screepy` / `screepy`. With `--client` the harness stays up after the report until Ctrl+C; add `--tick-ms 200` to slow the run down enough to follow it.

- Checks: no module errors, RCL reached, creep count, avg CPU, task failure ratio. Reports saved to `test-results/`.
- The bot writes `Memory.stats` (`src/utils/stats.ts`, `countStat()` for custom counters) and `Memory.moduleErrors` (ModuleManager).
- RCL/creeps are read from the server's room objects, so baseline bundles without `Memory.stats` can still be compared.
- Speed: the harness sets `system.setTickDuration(1)` (as fast as the engine goes, ~50 ms/tick). `config.yml` uses `processors: 2` / `runnerThreads: 2`: with 16 processors and one active room, redis coordination made ticks ~4x slower.
- Server quirks: `screepsmod-auth` is pinned to 2.8.3 in `config.yml` (2.9+ crashes with screepsmod-mongo); the admin CLI (port 21026) is only reachable from inside the container, the harness uses `docker compose exec`.

## Configuration

- Copy `screeps.example.json` to `screeps.json` with your Steam API key for deployment
- Copy `config.example.yml` to `config.yml` for local dev server, then `docker compose up -d`

## Architecture

### Entry Point & Game Loop
- `src/main.ts` - Entry point, initializes MemHack and profiler, exports the `loop()` function
- `src/gameLoop.ts` - Registers and runs all 24 modules through the ModuleManager

### Module System (`src/ModuleManager.ts`)
The game loop uses a module manager that:
- Runs modules in sequence with CPU budget management (80% of limit)
- Supports `mandatory` modules that are never skipped for CPU (errors are logged, never rerun in the same tick)
- Supports `runEvery`, `runOnce`, `threshold` (bucket) and `disabled` options
- Skips non-mandatory modules when CPU budget is exceeded; a module skipped `maxSkips` times (default 10) is forced to run
- `sleepModule(name, ticks)` lets a module with nothing to do skip its next runs
- Records per-module average CPU in `Memory.moduleState`

Disabled for now (design sketches, no creeps are ever spawned for them): Combat, Lab, Highway, SK, Stronghold, PowerCreep, Factory, BasePlanner. Re-enable one at a time once wired to spawning and validated with `npm run test:server`.

### Module Execution Order

| # | Module | Frequency | Description |
|---|--------|-----------|-------------|
| 1 | RoomManager Init | mandatory | Initialize memory each tick |
| 2 | RoomManager | every 5 | Phase evaluation, defense mode |
| 3 | DemandCalculator | every 3 | Calculate part deficits (same cadence as spawning) |
| 4 | TaskGenerator | every 5 | Create tasks from room state |
| 5 | TaskDispatcher | mandatory | Assign tasks to idle creeps |
| 6 | TaskExecutor | mandatory | Execute creep tasks |
| 8 | SpawnManager | every 3 | Spawn by part deficit |
| 9 | TowerManager | every tick | Defense and repairs |
| 10 | DefenderManager | every tick | Rampart defense positioning |
| 11 | ConstructionManager | every 20 | Building planning |
| 12 | IntelManager | every tick | Record room intel |
| 13 | ScoutManager | every 10 | Exploration routing |
| 14 | RemoteMiningManager | every 5 | Remote operations |
| 15 | ExpansionManager | every 50 | Room claiming |
| 16 | CombatManager | every 10 | Offensive operations |
| 17 | MarketManager | every 20 | Terminal trading |
| 18 | LabManager | every 5 | Compound production |
| 19 | HighwayManager | every 5 | Power banks & deposits |
| 20 | SKManager | every 5 | Source keeper mining |
| 21 | StrongholdManager | every 10 | Stronghold attacks |
| 22 | PowerCreepManager | every 3 | Power creep operations |
| 23 | FactoryManager | every 5 | Commodity production |
| 24 | BasePlanner | every 100 | Layout visualization |
| - | TrafficManager | mandatory, last | Resolve all movement (cartographer `reconcileTraffic`) |
| - | Dashboard | optional | Visual debugging |

---

## Core Systems

### Task System (`src/modules/TaskGenerator.ts`, `TaskDispatcher.ts`, `TaskExecutor.ts`)

Pure task-driven architecture where all creep work comes from the task queue.

```
TaskGenerator (every 5 ticks)
       ↓
TaskQueue (room.memory.taskQueue)
       ↓
TaskDispatcher (assigns to idle creeps)
       ↓
TaskExecutor (executes all creep actions)
       ↓
TrafficManager (processes movement)
```

#### Task Types & Priorities (lower = higher priority)

| Task Type | Priority | Category | Description |
|-----------|----------|----------|-------------|
| ATTACK_HOSTILE | 5 | ATTACK | Attack hostile creeps |
| FILL_SPAWN | 10 | TRANSPORT | Fill spawn with energy |
| FILL_EXTENSION | 15 | TRANSPORT | Fill extensions |
| FILL_TOWER | 25 | TRANSPORT | Fill towers |
| PICKUP_RESOURCE | 35 | TRANSPORT | Pick up dropped resources |
| WITHDRAW_CONTAINER | 40 | TRANSPORT | Withdraw from container |
| WITHDRAW_STORAGE | 42 | TRANSPORT | Withdraw from storage |
| BUILD_STRUCTURE | 45 | BUILD | Build construction sites |
| HARVEST_SOURCE | 50 | HARVEST | Harvest from source |
| REPAIR_STRUCTURE | 55 | REPAIR | Repair structures |
| FILL_STORAGE | 60 | TRANSPORT | Deposit to storage |
| UPGRADE_CONTROLLER | 65 | UPGRADE | Upgrade controller |
| REPAIR_RAMPART | 68 | REPAIR | Repair ramparts |
| REPAIR_WALL | 70 | REPAIR | Repair walls |
| RESERVE_CONTROLLER | 75 | CLAIM | Reserve remote room |
| CLAIM_CONTROLLER | 80 | CLAIM | Claim new room |

#### Task States
- `PENDING` - Waiting for assignment
- `ASSIGNED` - Assigned to a creep
- `IN_PROGRESS` - Being executed
- `COMPLETED` - Successfully finished
- `FAILED` - Task failed or expired

### Traffic System (`src/modules/TrafficManager.ts`)

Centralized movement control replacing all direct `moveTo()` calls, backed by `screeps-cartographer`
(path caching, repath when stuck, priority-based swapping and shoving via `reconcileTraffic()`).

- `trafficManager.preTick()` runs at the start of the loop, `TrafficManager` module runs last (after every creep-moving module)
- Working creeps must call `requestMove` **every tick, even when in range**: it registers a "stay in range" intent so they are not shoved away (see `TaskExecutor.approach()`)
- `getStuckTicks(creep)`: ticks a creep wanted to move but didn't (used for task failure)
- Idle position finding for parked creeps

**Usage:**
```typescript
trafficManager.requestMove(creep, targetPos, { range: 1, priority: 5 }); // priority: lower = more important
```

### Demand Calculator (`src/modules/DemandCalculator.ts`)

Part-based spawning system that calculates deficits by body part type.

**Tracked Parts:**
- WORK parts for harvesting/building/upgrading
- CARRY parts for transport capacity
- ATTACK/RANGED_ATTACK for combat
- HEAL for support
- CLAIM for expansion

### Phase System (`src/modules/RoomManager.ts`)

Each room progresses through phases based on development level.

| Phase | Name | Condition | Focus |
|-------|------|-----------|-------|
| 0 | EMERGENCY | creeps <= 2 | Survival spawning |
| 1 | BOOTSTRAP | creeps >= 3 | Build containers |
| 2 | FOUNDATION | containers done, RCL 2+ | Extensions |
| 3 | EXPANSION | 80% extensions, RCL 3+ | Roads, upgrading |
| 4 | ESTABLISHED | storage, RCL 4+ | Storage economy |
| 5 | ADVANCED | RCL 6+, terminal | Market, remotes |
| 6 | DOMINANT | RCL 8 | Full automation |

---

## Advanced Systems

### Defense (`src/modules/DefenderManager.ts`, `TowerManager.ts`)

- **TowerManager**: Smart targeting (healers > ranged > melee > tough), energy reservation
- **DefenderManager**: Rampart positioning, threat-based defender spawning
- **Defense Mode**: Activates on hostiles, boosts tower/rampart priorities

### Intel & Scouting (`src/modules/IntelManager.ts`, `ScoutManager.ts`)

- **IntelManager**: Records room data (sources, minerals, hostiles, owner)
- **ScoutManager**: Routes scouts to unexplored rooms, maintains sector coverage
- **Memory**: `Memory.intel[roomName]` stores persistent room data

### Remote Mining (`src/modules/RemoteMiningManager.ts`)

- Evaluates nearby rooms for remote harvesting
- Spawns remote miners and haulers
- Manages container placement and reservation
- Invader detection and defender dispatch

### Expansion (`src/modules/ExpansionManager.ts`)

- Room scoring (sources, mineral, distance, neighbors)
- Automatic claiming when GCL allows
- Bootstrap support for new rooms
- Cross-room resource transfer

### Combat (`src/modules/CombatManager.ts`)

**Attack Types:**
- `DRAIN` - Tower drain attacks
- `DISMANTLE` - Wall/rampart destruction
- `HARASS` - Remote mining disruption
- `ASSAULT` - Full room attack

**Combat Roles:** Attacker, Healer, Dismantler, Tank

### Market (`src/modules/MarketManager.ts`)

- Automated selling of excess resources
- Automated buying when deficient
- Price tracking and history
- Transaction cost optimization
- Inter-room resource transfer

### Labs (`src/modules/LabManager.ts`)

- Complete compound recipe tree (30+ compounds)
- Boost effects mapping for all body parts
- Production queue management
- Boost request system for combat/economy creeps

**Boost Tiers:**
- T1: +100% effect (e.g., UH for attack)
- T2: +200% effect (e.g., UH2O)
- T3: +300% effect (e.g., XUH2O)

### Highway Harvesting (`src/modules/HighwayManager.ts`)

- Observer-based highway room scanning
- Power bank profitability calculation
- Attack team coordination (attackers + healers)
- Deposit mining with cooldown management
- Hauler timing for power pickup

### Source Keeper Rooms (`src/modules/SKManager.ts`)

- SK room evaluation and selection
- Keeper spawn prediction and tracking
- SK killer patrol routes
- Safe mining window calculation
- Invader raid detection and response

### Strongholds (`src/modules/StrongholdManager.ts`)

- Stronghold detection via scouting
- Level assessment (1-5) and composition planning
- Coordinated assault timing
- Target prioritization (core > towers > ramparts)
- Loot collection after victory

### Power Creeps (`src/modules/PowerCreepManager.ts`)

**Economy Powers (prioritized):**
- `PWR_OPERATE_SPAWN` - Faster spawning
- `PWR_OPERATE_EXTENSION` - Fill from storage
- `PWR_REGEN_SOURCE` - Bonus energy
- `PWR_OPERATE_FACTORY` - Factory boost
- `PWR_REGEN_MINERAL` - Bonus minerals

**Features:**
- Automatic spawning based on GPL
- Room assignment optimization
- Renewal management
- Power cooldown tracking

### Factories (`src/modules/FactoryManager.ts`)

- Factory level tracking per room
- Mineral compression (bars)
- Commodity production chains (L0 → L5)
- Multi-room coordination
- Market integration for sales

**Production Chain:**
```
Base Minerals → Bars (L0) → Basic Commodities (L0)
    → L1 Components → L2 → L3 → L4 → L5 Products
```

### Base Planning (`src/modules/BasePlanner.ts`)

- Terrain analysis with distance transforms
- Optimal anchor point finding
- Stamp patterns (spawn cluster, storage core, lab cluster, towers)
- Extension placement in spiral pattern
- Road network generation
- Rampart perimeter planning
- Plan caching in Memory

---

## File Structure

```
src/
├── main.ts                 # Entry point
├── gameLoop.ts             # Module registration (24 modules)
├── ModuleManager.ts        # CPU-budgeted module runner
├── config/
│   ├── bodyTypes.ts        # Creep body configurations
│   └── gameConfig.ts       # Global constants
├── modules/
│   ├── RoomManager.ts      # Phase system, memory init
│   ├── SpawnManager.ts     # Part-deficit spawning
│   ├── TaskGenerator.ts    # Task creation
│   ├── TaskDispatcher.ts   # Task assignment
│   ├── TaskExecutor.ts     # Task execution (17 task types)
│   ├── DemandCalculator.ts # Part demand tracking
│   ├── TrafficManager.ts   # Centralized movement
│   ├── ConstructionManager.ts
│   ├── TowerManager.ts
│   ├── DefenderManager.ts
│   ├── IntelManager.ts
│   ├── ScoutManager.ts
│   ├── RemoteMiningManager.ts
│   ├── ExpansionManager.ts
│   ├── CombatManager.ts
│   ├── MarketManager.ts
│   ├── LabManager.ts
│   ├── HighwayManager.ts
│   ├── SKManager.ts
│   ├── StrongholdManager.ts
│   ├── PowerCreepManager.ts
│   ├── FactoryManager.ts
│   ├── BasePlanner.ts
│   └── visuals/
│       └── Dashboard.ts
├── types/
│   └── TaskTypes.ts        # Task enums and interfaces
├── utils/
│   ├── MemHack.ts          # Memory optimization
│   ├── profiler.ts         # CPU profiling
│   ├── roomUtils.ts
│   ├── creepUtils.ts
│   ├── logger.ts
│   └── logCPU.ts
└── type.d.ts               # Global type augmentations
```

---

## Memory Structures

### Global Memory
```typescript
interface Memory {
    // Core
    rooms: { [name: string]: RoomMemory };
    creeps: { [name: string]: CreepMemory };

    // Intel
    intel: { [roomName: string]: RoomIntel };

    // Traffic
    pathCache?: { [key: string]: CachedPath };
    traffic?: { lastCleanup: number };

    // Operations
    remoteRooms?: { [roomName: string]: RemoteRoomData };
    combatOperations?: { [id: string]: CombatOperation };
    highwayOperations?: { power: {...}, deposits: {...} };
    strongholdOperations?: { [roomName: string]: StrongholdOp };
    skOperations?: { [roomName: string]: SKOperation };

    // Production
    labQueue?: { [roomName: string]: LabQueue };
    basePlans?: { [roomName: string]: BasePlan };
}
```

### Room Memory
```typescript
interface RoomMemory {
    phase: number;
    defenseMode: boolean;
    threatLevel: number;
    taskQueue: Task[];
    partDemand: Record<BodyPartConstant, number>;
    spawnQueue: SpawnRequest[];
    sources: SourceMemory[];
    lastConstructionChange?: number;
}
```

### Creep Memory
```typescript
interface CreepMemory {
    role: string;
    homeRoom: string;
    task?: Task;
    taskState?: "acquiring" | "executing";
    _path?: string;
    _pathTick?: number;
    _pathTarget?: string;
    squad?: string;
}
```

---

## Key Dependencies

- `screeps-cartographer` - Pathing/movement utilities
- `screeps-cache` - Caching utilities
- `screeps-viz` - Visualization tools

---

## Development Notes

### Adding a New Module
1. Create `src/modules/NewManager.ts` with singleton pattern
2. Export module function: `export const newManagerModule = () => { ... }`
3. Register in `gameLoop.ts` with appropriate `runEvery` setting
4. Add any new Memory interfaces to `type.d.ts`

### Task System Extension
1. Add new `TaskType` enum value in `TaskTypes.ts`
2. Add task creation logic in `TaskGenerator.ts`
3. Add execution handler in `TaskExecutor.ts`
4. Update `DemandCalculator.ts` if new body parts needed

### CPU Budget Guidelines
- Mandatory modules: ~40% budget (task system, traffic)
- Economy modules: ~30% budget (spawning, construction)
- Advanced modules: ~30% budget (combat, market, labs)
- Target: <20 CPU with 30 creeps
