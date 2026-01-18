# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Screepy is a TypeScript-based AI bot for the game [Screeps](https://screeps.com/). The code compiles to JavaScript and gets deployed to Screeps servers where it runs autonomously to control game entities (creeps, spawns, towers).

## Build & Deploy Commands

```bash
npm install              # Install dependencies (requires Node.js ^20.11)
npm run build            # TypeScript compilation only (tsc)
npm run compile          # Rollup bundle without deployment
npm run lint             # Run TSLint
npm run test             # Clean and build (verification)
npm run clean            # Remove tsc-out and dist folders

# Deploy to different servers (compiles + uploads)
npm run push-main        # Main Screeps server
npm run push-sim         # Simulation server
npm run push-pserver     # Private server
npm run push-seasonal    # Seasonal server
npm run push-screepsplus # ScreepsPlus server
```

## Configuration

- Copy `screeps.example.json` to `screeps.json` with your Steam API key for deployment
- Copy `config.example.yml` to `config.yml` for local dev server, then `docker compose up -d`

## Architecture

### Entry Point & Game Loop
- `src/main.ts` - Entry point, initializes MemHack and profiler, exports the `loop()` function
- `src/gameLoop.ts` - Registers and runs all modules through the ModuleManager

### Module System (`src/ModuleManager.ts`)
The game loop uses a module manager that:
- Runs modules in sequence with CPU budget management (80% of limit)
- Supports `mandatory` modules that always run and auto-retry on failure
- Supports `runEvery`, `runOnce`, and `threshold` (bucket) options
- Skips non-mandatory modules when CPU budget is exceeded

### Core Modules (`src/modules/`)
- `MemoryManager.ts` - Initializes and refreshes room/spawn memory, ensures phase and task queue data exists
- `PhaseManager.ts` - Evaluates room phases and defense mode, provides creep counts/priorities
- `SpawnManager.ts` - Maintains spawn queue with priority system, uses PhaseManager for counts
- `ConstructionManager.ts` - Phase-aware construction planning (extensions, roads, containers)
- `TaskManager.ts` - Task queue management, cleanup of expired/completed tasks (runs every 5 ticks)
- `TaskGenerator.ts` - Scans rooms and creates tasks for the queue (runs every 10 ticks)
- `TaskDispatcher.ts` - Matches tasks to creeps, executes task actions
- `RoleManager.ts` - Dispatches creeps using hybrid role-task system with fallback to role handlers
- `TowerManager.ts` - Tower defense logic, attack-only mode during defense

### Configuration (`src/config/`)
- `phaseConfigs.ts` - Phase definitions, spawn priorities, body scaling, defense config
- `roleTaskConfig.ts` - Role flexibility levels, task category mappings, body part requirements

### Type Definitions
- `src/types/TaskTypes.ts` - Task system enums (TaskCategory, TaskType, TaskStatus), Task interface, helper functions
- `src/type.d.ts` - Global type augmentations for `Memory`, `CreepMemory`, `RoomMemory` interfaces

### Creep Roles (`src/modules/roles/`)
Each role exports a class with a static `run(creep)` method. Roles have different task system flexibility:

**Strict Roles** (always follow role logic, never accept tasks):
- `Miner` - Dedicated source mining, creates container construction sites
- `Defender` - Combat
- `Claimer` - Room claiming

**Task-Driven Roles** (all work from task queue, idle when no tasks):
- `Hauler` - Energy transport via FILL_SPAWN, FILL_EXTENSION, FILL_TOWER tasks

**Flexible Roles** (accept tasks when available, fallback to role behavior):
- `Harvester` - Basic energy gathering (direct harvest in Phase 0, containers in Phase 1+)
- `Builder` - Construction (containers Phase 1, extensions Phase 2+, walls in defense mode)
- `Upgrader` - Controller upgrading (storage as source in Phase 4+)

## Task System

The hybrid role-task system provides dynamic work assignment while preserving role specialization.

### Architecture
```
TaskGenerator (every 10 ticks)
       |
       v
TaskQueue (room.memory.taskQueue)
       |
       +-------------------+
       |                   |
TaskDispatcher        RoleManager
       |                   |
(assigns tasks      (fallback for
 to creeps)          idle creeps)
```

### Task Categories
- `HARVEST` - Energy harvesting from sources
- `TRANSPORT` - Pickup, withdraw, and delivery tasks
- `BUILD` - Construction site building
- `REPAIR` - Structure repair (including walls/ramparts)
- `UPGRADE` - Controller upgrading
- `ATTACK` - Combat tasks
- `CLAIM` - Room claiming

### Task Types & Priorities (lower = higher priority)
| Task Type | Priority | Description |
|-----------|----------|-------------|
| ATTACK_HOSTILE | 5 | Attack hostile creeps |
| FILL_SPAWN | 10 | Fill spawn with energy |
| FILL_EXTENSION | 15 | Fill extension with energy |
| FILL_TOWER | 25 | Fill tower (boosted in defense mode) |
| PICKUP_RESOURCE | 35 | Pick up dropped resources |
| WITHDRAW_CONTAINER | 40 | Withdraw from container |
| WITHDRAW_STORAGE | 42 | Withdraw from storage |
| BUILD_STRUCTURE | 45 | Build construction site |
| HARVEST_SOURCE | 50 | Harvest from source |
| REPAIR_STRUCTURE | 55 | Repair damaged structure |
| FILL_STORAGE | 60 | Deposit to storage |
| UPGRADE_CONTROLLER | 65 | Upgrade room controller |
| REPAIR_RAMPART | 68 | Repair ramparts |
| REPAIR_WALL | 70 | Repair walls |

### Task States
- `PENDING` - Waiting for assignment
- `ASSIGNED` - Assigned to a creep
- `IN_PROGRESS` - Being executed
- `COMPLETED` - Successfully finished
- `FAILED` - Task failed or expired

### Creep Task States
When a creep has a task, it tracks state in `creep.memory.task`:
- `acquiring` - Getting resources needed for the task
- `executing` - Performing the task action
- `returning` - Returning after completion (rarely used)

## Phase System

Each room tracks its own phase independently in `room.memory.phase`. Spawning, building, and role behavior adapt to the current phase.

### Phase Definitions

| Phase | Name | Condition | Goals |
|-------|------|-----------|-------|
| 0 | EMERGENCY | totalCreeps <= 2 | Spawn basic harvesters to survive |
| 1 | BOOTSTRAP | creeps >= 3, no containers | Spawn miners, build source containers |
| 2 | FOUNDATION | all sources have containers, RCL >= 2 | Build extensions, optimize economy |
| 3 | EXPANSION | 80% extensions built, RCL >= 3 | Maximize upgrading, build roads |
| 4 | ESTABLISHED | has storage, RCL >= 4 | Storage logistics, tower defense |
| 5 | ADVANCED | RCL >= 6, has terminal | Market, remote mining |
| 6 | DOMINANT | RCL = 8 | Maximum efficiency, expansion |

### Phase Transitions
- Evaluated every 10 ticks with hysteresis to prevent thrashing
- UP transitions require condition true for 50 consecutive ticks
- DOWN transitions require condition true for 20 consecutive ticks
- EMERGENCY (Phase 0) transitions happen immediately

### Defense Mode
Defense mode is a special overlay that activates on top of any phase when hostiles are detected:
- Activates when `room.memory.threatLevel > 0`
- Deactivates 300 ticks after last hostile seen
- Defenders spawn with highest priority
- Tower filling tasks get priority boost (-20)
- Rampart repair tasks get priority boost (-30)
- Towers skip repairs to maximize attack damage

### Spawn Counts by Phase

| Role | Ph0 | Ph1 | Ph2 | Ph3 | Ph4+ |
|------|-----|-----|-----|-----|------|
| harvester | 2-4 | 1-2 | 0 | 0 | 0 |
| miner | 0 | sources | sources | sources | sources |
| hauler | 0 | miners×2 | miners×2 | miners×2 | miners×2 |
| builder | 0 | 1 | 3 | 2 | 1 |
| upgrader | 0 | 2 | 3 | 5 | 5-6 |
| defender | threat | threat | threat | threat | threat |

### Utilities (`src/utils/`)
- `MemHack.ts` - Memory deserialization optimization
- `profiler.ts` - CPU profiling wrapper
- `roomUtils.ts` - Room helper functions
- `creepUtils.ts` - Creep helper functions
- `logger.ts` - Structured logging utility
- `logCPU.ts` - CPU logging utilities

## Key Dependencies
- `screeps-cartographer` - Pathing/movement
- `screeps-cache` - Caching utilities
- `screeps-viz` - Visualization tools

## Great Filters (Development Milestones)

Reference: https://wiki.screepspl.us/Great_Filters/

Key stages most Screeps bots progress through:

1. **Creep Management** - Automated creep behavior via roles or dynamic task assignment
2. **Automatic Spawning** - Maintain population without manual intervention (headcount, spawn queues, cold-boot recovery)
3. **Automatic Room Defense** - Defend against invaders (towers, rampart defense, SafeMode)
4. **Energy Harvesting & Remote Mining** - Systematic energy collection across multiple rooms
5. **Room Claiming & Expansion** - Automate claiming new rooms (requires GCL 2+)
6. **Room Offense** - Scout enemies and mount automated attacks
7. **Advanced Systems** - Market trading, labs/boosts, highway harvesting, source-keepers, power creeps, factories, auto base planning
