import { logCpu, logCpuStart } from "utils/logCPU";
import { log } from "utils/logger";
import { throttleMultiplier } from "utils/throttle";

export interface Module {
  name: string;
  fn: () => void;
  mandatory?: boolean;
  runEvery?: number;
  runOnce?: boolean;
  threshold?: number;
  tier?: "core" | "standard" | "auxiliary";
  /** Skips (CPU budget) tolerated before the module is forced to run. Defaults to DEFAULT_MAX_SKIPS. */
  maxSkips?: number;
  disabled?: boolean;
  /**
   * Bucket throttling (Hivemind process priorities): "always" never throttles; otherwise the
   * module's interval (runEvery, 1 by default) is multiplied as the bucket drains, and the module
   * stops below the priority's stopAt. Default "default"; mandatory modules are "always".
   */
  priority?: "always" | "high" | "default" | "low";
}

/** Hivemind priorityEffects: [stopAt, throttleAt] */
const PRIORITY_EFFECTS = {
  low: [5000, 9500],
  default: [3000, 8000],
  high: [500, 5000],
  always: [0, 0]
} as const;

/** Throttled interval passed? (Hivemind isProcessAllowedToRun) */
function isAllowedByBucket(module: Module, lastRun: number): boolean {
  const priority = module.mandatory ? "always" : module.priority ?? "default";
  if (priority === "always") return true;
  const [stopAt, throttleAt] = PRIORITY_EFFECTS[priority];
  if (Game.cpu.bucket <= stopAt) return false;
  const interval = module.runEvery ?? 1;
  if (Game.time - lastRun < interval) return false;
  return Game.time - lastRun >= interval * throttleMultiplier(stopAt, throttleAt);
}

/** Non-mandatory modules are forced to run after this many CPU-budget skips (priority aging) */
const DEFAULT_MAX_SKIPS = 10;

/** Max errors kept in Memory.moduleErrors */
const MAX_ERRORS = 20;

function getModuleState(name: string): ModuleState {
  if (!Memory.moduleState) Memory.moduleState = {};
  if (!Memory.moduleState[name]) {
    Memory.moduleState[name] = { lastRun: 0, consecutiveSkips: 0 };
  }
  return Memory.moduleState[name];
}

/**
 * Put a module to sleep: it won't run before `ticks` ticks have passed.
 * Call from inside a module that has nothing to do (no labs, no target...).
 */
export function sleepModule(name: string, ticks: number) {
  getModuleState(name).sleepUntil = Game.time + ticks;
}

function recordError(name: string, error: unknown) {
  if (!Memory.moduleErrors) Memory.moduleErrors = [];
  const message = (error as Error)?.stack ?? String(error);
  Memory.moduleErrors.push({ tick: Game.time, module: name, message: message.slice(0, 500) });
  if (Memory.moduleErrors.length > MAX_ERRORS) Memory.moduleErrors.shift();
}

export function runModuleManager(modules: Module[], cpuLimit: number, debug = false) {
  const start = Game.cpu.getUsed();
  if (debug) logCpuStart();

  // Reserve 15% for auxiliary modules
  const auxiliaryModules = modules.filter(m => m.tier === "auxiliary" && !m.disabled);
  const auxiliaryReserve = auxiliaryModules.length > 0 ? cpuLimit * 0.15 : 0;
  const standardBudget = cpuLimit - auxiliaryReserve;

  // Find ONE module to force-run (the most starved one past its maxSkips)
  let moduleToForce: string | null = null;
  let mostSkips = 0;
  for (const module of modules) {
    if (module.disabled || module.mandatory) continue;
    const state = getModuleState(module.name);
    const maxSkips = module.maxSkips ?? DEFAULT_MAX_SKIPS;
    if (state.consecutiveSkips >= maxSkips && state.consecutiveSkips > mostSkips) {
      moduleToForce = module.name;
      mostSkips = state.consecutiveSkips;
    }
  }

  for (const module of modules) {
    if (module.disabled) continue;
    const state = getModuleState(module.name);

    // Sleeping or not due yet
    if (state.sleepUntil && Game.time < state.sleepUntil) continue;
    if (module.runEvery && state.lastRun + module.runEvery > Game.time) continue;
    if (module.runOnce && state.lastRun >= Game.time) continue;
    if (!module.runOnce && !isAllowedByBucket(module, state.lastRun)) {
      state.throttled = (state.throttled ?? 0) + 1;
      continue;
    }

    const cpuUsed = Game.cpu.getUsed() - start;
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
      continue;
    }

    const before = Game.cpu.getUsed();
    try {
      module.fn();
      if (debug) logCpu(module.name, cpuUsed);
    } catch (error) {
      // No rerun: a partial run already issued intents, rerunning would duplicate them
      log.error("ModuleManager", `Error in module ${module.name}:`, (error as Error).stack);
      recordError(module.name, error);
    }
    const cpu = Game.cpu.getUsed() - before;
    state.avgCpu = state.avgCpu === undefined ? cpu : state.avgCpu * 0.9 + cpu * 0.1;
    state.lastRun = Game.time;
    state.consecutiveSkips = 0;
  }

  if (debug) logCpu("Total", Game.cpu.getUsed() - start);
}
