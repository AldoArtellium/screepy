import { runModuleManager } from "./ModuleManager";

import { constructionManagerModule } from "modules/ConstructionManager";
import { memoryManagerModule } from "modules/MemoryManager";
import { phaseManagerModule } from "modules/PhaseManager";
import { roleManagerModule } from "modules/RoleManager";
import { spawnManagerModule } from "modules/SpawnManager";
import { taskGeneratorModule } from "modules/TaskGenerator";
import { taskManagerModule } from "modules/TaskManager";
import { towerManagerModule } from "modules/TowerManager";
import { dashboardModule } from "modules/visuals/Dashboard";
import { log } from "utils/logger";

// assignement
export const gameLoop = () => {
  const memLimit = 1000000;
  const cpuLimit = Game.cpu.limit;
  const modules = [
    // Always run init first (mandatory)
    { name: "Memory Manager Init", fn: memoryManagerModule.init, mandatory: true },
    // Refresh memory every 5 ticks to reduce CPU
    { name: "Memory Manager Refresh", fn: memoryManagerModule.refresh, runEvery: 5 },
    // Phase manager evaluates room phases every 10 ticks (mandatory for phase transitions)
    { name: "Phase Manager", fn: phaseManagerModule, runEvery: 10, mandatory: true },
    // Task manager cleans up queue every 5 ticks
    { name: "Task Manager", fn: taskManagerModule, runEvery: 5 },
    // Task generator creates tasks every 10 ticks (phase-aware)
    { name: "Task Generator", fn: taskGeneratorModule, runEvery: 10 },
    // Role manager must run every tick (mandatory for creep control, now task-aware)
    { name: "Role Manager", fn: roleManagerModule, mandatory: true },
    // Spawn manager can run every 3 ticks (spawning takes time anyway)
    { name: "Spawn Manager", fn: spawnManagerModule, runEvery: 3 },
    // Tower manager runs every tick for defense
    { name: "Tower Manager", fn: towerManagerModule },
    // Construction manager runs every 20 ticks for building planning
    { name: "Construction Manager", fn: constructionManagerModule, runEvery: 20 },

    // Unified dashboard for CPU, tasks, and creep assignments
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
