import { Module, runModuleManager } from "./ModuleManager";

import { roomBuilderModule } from "construction/RoomBuilder";
import { creepRunnerModule } from "modules/CreepRunner";
import { defenseModule } from "defense/defenseModule";
import { expansionModule } from "expansion/Expansion";
import { militaryModule } from "military/military";
import { intelManagerModule } from "modules/IntelManager";
import { marketManagerModule } from "modules/MarketManager";
import { memoryCleanupModule } from "modules/MemoryCleanup";
import { roomIntelModule } from "modules/RoomIntel";
import { scoutManagerModule } from "modules/ScoutManager";
import { spawnManagerModule } from "modules/SpawnManager";
import { trafficManagerModule } from "modules/TrafficManager";
import { roomPlannerModule } from "planner/RoomPlanner";
import { remoteMiningModule } from "remote/RemoteMining";
import { log } from "utils/logger";

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

    // Towers and safe mode
    { name: "Defense", fn: defenseModule, priority: "always" },
    { name: "IntelManager", fn: intelManagerModule },
    { name: "ScoutManager", fn: scoutManagerModule, runEvery: 10, priority: "low" },
    // Remote sources each owned room mines (selection every 20 ticks)
    { name: "RemoteMining", fn: remoteMiningModule, priority: "high" },
    // Claims and bootstraps new rooms, helps rooms without spawn
    { name: "Expansion", fn: expansionModule, runEvery: 5, priority: "high" },
    // Attacks (Memory.military.attack): duos moving and fighting as one
    { name: "Military", fn: militaryModule, priority: "always" },
    // Nothing to trade before a terminal (RCL 6): back with the terminal milestone
    { name: "MarketManager", fn: marketManagerModule, runEvery: 20, priority: "low", disabled: true },
    // Memory of dead creeps (every 100 ticks) and unused rooms (every 1000)
    { name: "MemoryCleanup", fn: memoryCleanupModule },

    // Resolves all movement requests issued above (must run after every creep-moving module)
    { name: "TrafficManager", fn: trafficManagerModule, mandatory: true }
  ];

  runModuleManager(modules, cpuLimit * 0.8, false);

  if (Game.time % 100 === 0) {
    const memorySize = JSON.stringify(Memory).length;
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
