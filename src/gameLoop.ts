import { runModuleManager } from "./ModuleManager";

import { basePlannerModule } from "modules/BasePlanner";
import { combatManagerModule } from "modules/CombatManager";
import { constructionManagerModule } from "modules/ConstructionManager";
import { defenderManagerModule } from "modules/DefenderManager";
import { demandCalculatorModule } from "modules/DemandCalculator";
import { expansionManagerModule } from "modules/ExpansionManager";
import { factoryManagerModule } from "modules/FactoryManager";
import { highwayManagerModule } from "modules/HighwayManager";
import { intelManagerModule } from "modules/IntelManager";
import { labManagerModule } from "modules/LabManager";
import { marketManagerModule } from "modules/MarketManager";
import { metricsCollectorModule } from "modules/MetricsCollector";
import { powerCreepManagerModule } from "modules/PowerCreepManager";
import { remoteMiningManagerModule } from "modules/RemoteMiningManager";
import { roomManagerModule } from "modules/RoomManager";
import { skManagerModule } from "modules/SKManager";
import { scoutManagerModule } from "modules/ScoutManager";
import { spawnManagerModule } from "modules/SpawnManager";
import { strongholdManagerModule } from "modules/StrongholdManager";
import { taskDispatcherModule } from "modules/TaskDispatcher";
import { taskExecutorModule } from "modules/TaskExecutor";
import { taskGeneratorModule } from "modules/TaskGenerator";
import { towerManagerModule } from "modules/TowerManager";
import { trafficManagerModule } from "modules/TrafficManager";
import { dashboardModule } from "modules/visuals/Dashboard";
import { log } from "utils/logger";

export const gameLoop = () => {
  const memLimit = 1000000;
  const cpuLimit = Game.cpu.limit;
  // Modules flagged `disabled` are design sketches not yet wired to spawning/roles.
  // Re-enable one at a time once validated on the private server.
  const modules = [
    // 0. Metrics collection (mandatory, lightweight, every tick)
    { name: "MetricsCollector", fn: metricsCollectorModule, mandatory: true },

    // 1. Initialize memory (mandatory, runs once per tick)
    { name: "RoomManager Init", fn: roomManagerModule.init, mandatory: true },

    // 2. Room management: memory refresh, phase evaluation, defense mode (every 5 ticks)
    { name: "RoomManager", fn: roomManagerModule.run, runEvery: 5, mandatory: true },

    // 3. Demand calculator: calculates part needs (same cadence as SpawnManager, so spawning uses fresh demand)
    { name: "DemandCalculator", fn: demandCalculatorModule, runEvery: 3 },

    // 4. Task generator: creates tasks from room state (every 5 ticks)
    { name: "TaskGenerator", fn: taskGeneratorModule, runEvery: 5 },

    // 5. Task dispatcher: assigns tasks to idle creeps (mandatory)
    { name: "TaskDispatcher", fn: taskDispatcherModule, mandatory: true },

    // 6. Task executor: runs all creeps with tasks (mandatory)
    { name: "TaskExecutor", fn: taskExecutorModule, mandatory: true },

    // 8. Spawn manager: spawns by part deficit (every 3 ticks)
    { name: "SpawnManager", fn: spawnManagerModule, runEvery: 3 },

    // 9. Tower manager: defense and repairs
    { name: "TowerManager", fn: towerManagerModule },

    // 10. Defender manager: rampart defense (only during defense mode)
    { name: "DefenderManager", fn: defenderManagerModule },

    // 11. Construction manager: building planning (every 20 ticks)
    { name: "ConstructionManager", fn: constructionManagerModule, runEvery: 20 },

    // 12. Intel manager: record room data (every tick for visible rooms)
    { name: "IntelManager", fn: intelManagerModule },

    // 13. Scout manager: exploration (every 10 ticks)
    { name: "ScoutManager", fn: scoutManagerModule, runEvery: 10 },

    // 14. Remote mining manager: remote operations (every 5 ticks)
    { name: "RemoteMiningManager", fn: remoteMiningManagerModule, runEvery: 5 },

    // 15. Expansion manager: room claiming (every 50 ticks, phase 4+)
    { name: "ExpansionManager", fn: expansionManagerModule, runEvery: 50 },

    // 16. Combat manager: offensive operations (every 10 ticks, RCL 5+)
    { name: "CombatManager", fn: combatManagerModule, runEvery: 10, disabled: true },

    // 16. Market manager: trading operations (every 20 ticks)
    { name: "MarketManager", fn: marketManagerModule, runEvery: 20 },

    // 17. Lab manager: compound production and boosts (every 5 ticks, RCL 6+)
    { name: "LabManager", fn: labManagerModule, runEvery: 5, disabled: true },

    // 18. Highway manager: power banks and deposits (every 5 ticks, RCL 7+)
    { name: "HighwayManager", fn: highwayManagerModule, runEvery: 5, disabled: true },

    // 19. SK manager: source keeper room mining (every 5 ticks, RCL 7+)
    { name: "SKManager", fn: skManagerModule, runEvery: 5, disabled: true },

    // 20. Stronghold manager: invader stronghold attacks (every 10 ticks, RCL 5+)
    { name: "StrongholdManager", fn: strongholdManagerModule, runEvery: 10, disabled: true },

    // 21. Power creep manager: power creep operations (every 3 ticks, RCL 8)
    { name: "PowerCreepManager", fn: powerCreepManagerModule, runEvery: 3, disabled: true },

    // 22. Factory manager: commodity production (every 5 ticks, RCL 7+)
    { name: "FactoryManager", fn: factoryManagerModule, runEvery: 5, disabled: true },

    // 23. Base planner: layout visualization (every 100 ticks)
    { name: "BasePlanner", fn: basePlannerModule, runEvery: 100, tier: "auxiliary" as const, maxSkips: 5, disabled: true },

    // Traffic manager: resolves all movement requests issued above (mandatory, must run after every creep-moving module)
    { name: "TrafficManager", fn: trafficManagerModule, mandatory: true },

    // 24. Dashboard for visualization
    { name: "Dashboard", fn: dashboardModule.fn, tier: "auxiliary" as const, maxSkips: 10 },
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
