import { Module, runModuleManager } from "./ModuleManager";

import { roomBuilderModule } from "construction/RoomBuilder";
import { roomCleanupModule } from "construction/RoomCleanup";
import { creepRunnerModule } from "modules/CreepRunner";
import { defenseModule } from "defense/defenseModule";
import { expansionModule } from "expansion/Expansion";
import { militaryModule } from "military/military";
import { intelManagerModule } from "modules/IntelManager";
import { labsModule } from "labs/labsModule";
import { linksModule } from "modules/Links";
import { marketManagerModule } from "modules/MarketManager";
import { terminalTransfersModule } from "modules/TerminalTransfers";
import { memoryCleanupModule } from "modules/MemoryCleanup";
import { miningStatsModule } from "modules/MiningStats";
import { roomIntelModule } from "modules/RoomIntel";
import { scoutManagerModule } from "modules/ScoutManager";
import { spawnManagerModule } from "modules/SpawnManager";
import { trafficManagerModule } from "modules/TrafficManager";
import { roomPlannerModule } from "planner/RoomPlanner";
import { remoteMiningModule } from "remote/RemoteMining";
import { log } from "utils/logger";
import { roomVisualsModule } from "visuals/roomVisuals";

export const gameLoop = () => {
  const memLimit = 1000000;
  const cpuLimit = Game.cpu.limit;
  const modules: Module[] = [
    // Hostile presence in owned rooms (read by everything below)
    { name: "RoomIntel", fn: roomIntelModule, mandatory: true },

    // Room plan: computed once per room, stored in Memory
    { name: "RoomPlanner", fn: roomPlannerModule, runEvery: 10 },

    // Every creep runs its role (economy roles, scouts, remote miners, claimers)
    { name: "CreepRunner", fn: creepRunnerModule, mandatory: true },

    // Best spawn option per room, one creep per room and tick
    { name: "SpawnManager", fn: spawnManagerModule, mandatory: true },

    // Construction sites from the plan
    { name: "RoomBuilder", fn: roomBuilderModule, runEvery: 20 },
    // Others' structures and sites, walls and misplaced structures on planned tiles (Hivemind cleanRoom)
    { name: "RoomCleanup", fn: roomCleanupModule, runEvery: 100 },

    // Labs: boost labs for the creeps to boost, reactions (military compounds first)
    { name: "Labs", fn: labsModule },

    // Towers and safe mode
    { name: "Defense", fn: defenseModule, priority: "always" },
    // Link transfers (RCL 5+): source links -> controller link, storage link as buffer
    { name: "Links", fn: linksModule, runEvery: 3, priority: "high" },
    { name: "IntelManager", fn: intelManagerModule },
    { name: "ScoutManager", fn: scoutManagerModule, runEvery: 10, priority: "low" },
    // Remote sources each owned room mines (selection every 20 ticks)
    { name: "RemoteMining", fn: remoteMiningModule, priority: "high" },
    // Claims and bootstraps new rooms, helps rooms without spawn
    { name: "Expansion", fn: expansionModule, runEvery: 5, priority: "high" },
    // Attacks (Memory.military.attack or automatic targets): duos and quads moving and fighting as one
    { name: "Military", fn: militaryModule, priority: "always" },
    // Market (Hivemind trade): sells surpluses, buys missing base minerals; nothing before a terminal
    { name: "MarketManager", fn: marketManagerModule, runEvery: 20, priority: "low" },
    // Terminal sends between owned rooms (Hivemind resources process); nothing below 2 terminals
    { name: "TerminalTransfers", fn: terminalTransfersModule, runEvery: 5 },
    // Memory of dead creeps (every 100 ticks) and unused rooms (every 1000)
    { name: "MemoryCleanup", fn: memoryCleanupModule },

    // Room and map visuals (every tick: visuals last one tick; Memory.visuals = false or per layer)
    // Share of the source energy harvested (read on each source's last regeneration tick)
    { name: "MiningStats", fn: miningStatsModule },
    // Every tick (a skipped tick blanks the visuals); the module throttles its own redraws
    { name: "RoomVisuals", fn: roomVisualsModule, priority: "always" },

    // Resolves all movement requests issued above (must run after every creep-moving module)
    { name: "TrafficManager", fn: trafficManagerModule, mandatory: true }
  ];

  runModuleManager(modules, cpuLimit * 0.8);

  if (Game.time % 100 === 0) {
    // Size of the Memory saved last tick (already a string: no stringify); per-key detail only above the limit
    const memorySize = RawMemory.get().length;
    if (memorySize > memLimit) {
      log.warn("GameLoop", "Memory approaching dangerous levels:", memorySize);
      log.warn(
        "GameLoop",
        Object.keys(Memory)
          .map(k => `Memory.${k}: ${JSON.stringify(Memory[k as keyof Memory]).length}`)
          .join("\n")
      );
    }
  }
};
