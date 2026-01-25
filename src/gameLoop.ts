import { runModuleManager } from "./ModuleManager";

import { constructionManagerModule } from "modules/ConstructionManager";
import { defenderManagerModule } from "modules/DefenderManager";
import { demandCalculatorModule } from "modules/DemandCalculator";
import { intelManagerModule } from "modules/IntelManager";
import { remoteMiningManagerModule } from "modules/RemoteMiningManager";
import { roomManagerModule } from "modules/RoomManager";
import { scoutManagerModule } from "modules/ScoutManager";
import { spawnManagerModule } from "modules/SpawnManager";
import { taskDispatcherModule } from "modules/TaskDispatcher";
import { taskExecutorModule } from "modules/TaskExecutor";
import { taskGeneratorModule } from "modules/TaskGenerator";
import { towerManagerModule } from "modules/TowerManager";
import { dashboardModule } from "modules/visuals/Dashboard";
import { log } from "utils/logger";

export const gameLoop = () => {
  const memLimit = 1000000;
  const cpuLimit = Game.cpu.limit;
  const modules = [
    // 1. Initialize memory (mandatory, runs once per tick)
    { name: "RoomManager Init", fn: roomManagerModule.init, mandatory: true },

    // 2. Room management: memory refresh, phase evaluation, defense mode (every 5 ticks)
    { name: "RoomManager", fn: roomManagerModule.run, runEvery: 5, mandatory: true },

    // 3. Demand calculator: calculates part needs (every 10 ticks)
    { name: "DemandCalculator", fn: demandCalculatorModule, runEvery: 10 },

    // 4. Task generator: creates tasks from room state (every 5 ticks)
    { name: "TaskGenerator", fn: taskGeneratorModule, runEvery: 5 },

    // 5. Task dispatcher: assigns tasks to idle creeps (mandatory)
    { name: "TaskDispatcher", fn: taskDispatcherModule, mandatory: true },

    // 6. Task executor: runs all creeps with tasks (mandatory)
    { name: "TaskExecutor", fn: taskExecutorModule, mandatory: true },

    // 7. Spawn manager: spawns by part deficit (every 3 ticks)
    { name: "SpawnManager", fn: spawnManagerModule, runEvery: 3 },

    // 8. Tower manager: defense and repairs
    { name: "TowerManager", fn: towerManagerModule },

    // 9. Defender manager: rampart defense (only during defense mode)
    { name: "DefenderManager", fn: defenderManagerModule },

    // 10. Construction manager: building planning (every 20 ticks)
    { name: "ConstructionManager", fn: constructionManagerModule, runEvery: 20 },

    // 11. Intel manager: record room data (every tick for visible rooms)
    { name: "IntelManager", fn: intelManagerModule },

    // 12. Scout manager: exploration (every 10 ticks)
    { name: "ScoutManager", fn: scoutManagerModule, runEvery: 10 },

    // 13. Remote mining manager: remote operations (every 5 ticks)
    { name: "RemoteMiningManager", fn: remoteMiningManagerModule, runEvery: 5 },

    // 14. Dashboard for visualization
    { name: "Dashboard", fn: dashboardModule.fn, mandatory: false },
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
