import { runModuleManager } from "./ModuleManager";

import { displayBucketModule } from "modules/visuals/displayBucket";
import { displayCreepModule } from "modules/visuals/diplayCreeps";
import { roleManagerModule } from "modules/RoleManager";
import { spawnManagerModule } from "modules/SpawnManager";
import { towerManagerModule } from "modules/TowerManager";
import { memoryManagerModule } from "modules/MemoryManager";

// assignement 
export const gameLoop = () => {
  const memLimit = 1000000;
  const cpuLimit = Game.cpu.limit;
  const modules = [
    { name: "Memory Manager", fn: memoryManagerModule.init, mandatory: true},
    { name: "Memory Manager", fn: memoryManagerModule.refresh },
    { name: "Role Manager", fn: roleManagerModule, mandatory: true },
    { name: "Spawn Manager", fn: spawnManagerModule },
    { name: "Tower Manager", fn: towerManagerModule },

    // displayBucketModule,
    // displayCreepModule,
  ]

  runModuleManager(modules, cpuLimit * 0.8, false);

  if (Game.time % 100 === 0) {
    const memorySize = JSON.stringify(Memory).length;
    if (memorySize > memLimit) {
      console.log("Memory approaching dangerous levels:", memorySize);
      console.log(
        Object.keys(Memory)
          .map(k => `Memory.${k}: ${JSON.stringify(Memory[k as keyof Memory]).length}`)
          .join("\n")
      );
    }
  }
};
