import { logCpu, logCpuStart } from "utils/logCPU";
import { log } from "utils/logger";

interface Module {
  name: string;
  fn: () => void;
  mandatory?: boolean;
  runEvery?: number;
  runOnce?: boolean;
  threshold?: number;
}

const lastRun = new Map<string, number>();

export function runModuleManager(modules: Module[], cpuLimit: number, debug = false) {
  const start = Game.cpu.getUsed();
  if (debug) logCpuStart();

  let remainingCpu = cpuLimit;

  for (const module of modules) {
    const currentCpuUsed = Game.cpu.getUsed() - start;
    remainingCpu -= currentCpuUsed;

    if (!module.mandatory && remainingCpu < 0) {
      log.warn("ModuleManager", "CPU limit reached, skipping module:", module.name);
      continue; // Exits the loop entirely if CPU limit is exceeded for non-mandatory modules
    }
    if (module.threshold && Game.cpu.bucket < module.threshold) {
      log.warn("ModuleManager", "Low CPU bucket, skipping module:", module.name);
      continue; // Skips to the next module
    }
    const lastRanAt = lastRun.get(module.name) ?? 0;
    if ((!module.runEvery || lastRanAt + module.runEvery <= Game.time) && (!module.runOnce || lastRanAt < Game.time)) {
      try {
        module.fn();
        if (debug) logCpu(module.name, currentCpuUsed);
        lastRun.set(module.name, Game.time);
      } catch (error) {
        log.error("ModuleManager", `Error in module ${module.name}:`, (error as Error).stack);
        if (module.mandatory) {
          log.warn("ModuleManager", `Attempting to rerun mandatory module ${module.name} due to error.`);
          module.fn(); // Rerun mandatory modules immediately if they fail
        }
      }
    }
  }

  if (debug) logCpu("Total", Game.cpu.getUsed() - start);
}
