import { logCpu, logCpuStart } from "utils/logCPU";
import { log } from "utils/logger";

interface Module {
  name: string;
  fn: () => void;
  mandatory?: boolean;
  runEvery?: number;
  runOnce?: boolean;
  threshold?: number;
  tier?: "core" | "standard" | "auxiliary";
  maxSkips?: number;
}

interface ModuleState {
  lastRun: number;
  consecutiveSkips: number;
}

function getModuleState(name: string): ModuleState {
  if (!Memory.moduleState) Memory.moduleState = {};
  if (!Memory.moduleState[name]) {
    Memory.moduleState[name] = { lastRun: 0, consecutiveSkips: 0 };
  }
  return Memory.moduleState[name];
}

export function runModuleManager(modules: Module[], cpuLimit: number, debug = false) {
  const start = Game.cpu.getUsed();
  if (debug) logCpuStart();

  // Reserve 15% for auxiliary modules
  const auxiliaryModules = modules.filter(m => m.tier === "auxiliary");
  const auxiliaryReserve = auxiliaryModules.length > 0 ? cpuLimit * 0.15 : 0;
  const standardBudget = cpuLimit - auxiliaryReserve;

  // Find ONE module to force-run (if any exceeded maxSkips)
  let moduleToForce: string | null = null;
  for (const module of modules) {
    if (module.maxSkips !== undefined) {
      const state = getModuleState(module.name);
      if (state.consecutiveSkips >= module.maxSkips) {
        moduleToForce = module.name;
        break;
      }
    }
  }

  for (const module of modules) {
    const cpuUsed = Game.cpu.getUsed() - start;
    const state = getModuleState(module.name);
    const isAuxiliary = module.tier === "auxiliary";
    const shouldForce = module.name === moduleToForce;

    // Calculate remaining CPU based on tier
    const remainingCpu = isAuxiliary
      ? cpuLimit - cpuUsed // Auxiliary uses full budget including reserve
      : standardBudget - cpuUsed; // Standard uses only standard budget

    // Skip check (forced modules bypass CPU check but not bucket threshold)
    if (!module.mandatory && !shouldForce && remainingCpu < 0) {
      state.consecutiveSkips++;
      log.warn("ModuleManager", `CPU limit reached, skipping: ${module.name} (skips: ${state.consecutiveSkips})`);
      continue;
    }

    if (module.threshold && Game.cpu.bucket < module.threshold) {
      state.consecutiveSkips++;
      log.warn("ModuleManager", `Low bucket, skipping: ${module.name}`);
      continue;
    }

    // Run if timing conditions met
    const lastRanAt = state.lastRun;
    if ((!module.runEvery || lastRanAt + module.runEvery <= Game.time) && (!module.runOnce || lastRanAt < Game.time)) {
      try {
        module.fn();
        if (debug) logCpu(module.name, cpuUsed);
        state.lastRun = Game.time;
        state.consecutiveSkips = 0; // Reset on success
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
