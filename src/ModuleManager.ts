import { log } from "utils/logger";
import { decisionBucket, throttleMultiplier } from "utils/throttle";
import { countStat } from "utils/stats";

export interface Module {
  name: string;
  fn: () => void;
  mandatory?: boolean;
  runEvery?: number;
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
  if (decisionBucket() <= stopAt) return false;
  const interval = module.runEvery ?? 1;
  if (Game.time - lastRun < interval) return false;
  return Game.time - lastRun >= interval * throttleMultiplier(stopAt, throttleAt);
}

/** Non-mandatory modules are forced to run after this many CPU-budget skips (priority aging) */
const DEFAULT_MAX_SKIPS = 10;

/** Max errors kept in Memory.moduleErrors */
const MAX_ERRORS = 20;

/** Nominal interval of each module (runEvery, 1 by default), refreshed by runModuleManager */
const runIntervals = new Map<string, number>();

/**
 * Recent CPU per tick of a module: its average per run (avgCpu) spread over its nominal interval,
 * so a module running every N ticks is not N times more expensive than one running every tick.
 * Bucket throttling stretches the interval further: this is an upper bound then. Undefined for a name
 * not registered in this global (a removed module's frozen avgCpu).
 */
export function moduleCpuPerTick(name: string): number | undefined {
  const interval = runIntervals.get(name);
  const avgCpu = Memory.moduleState?.[name]?.avgCpu;
  if (interval === undefined || avgCpu === undefined) return undefined;
  return avgCpu / interval;
}

/** Memory.moduleState of modules no longer in the loop was pruned in this global */
let statePruned = false;

/** Drops the state of modules removed from the loop (their avgCpu would stay frozen forever) */
function pruneModuleState(modules: Module[]): void {
  if (statePruned || !Memory.moduleState) return;
  statePruned = true;
  const names = new Set(modules.map(m => m.name));
  for (const name in Memory.moduleState) if (!names.has(name)) delete Memory.moduleState[name];
}

function getModuleState(name: string): ModuleState {
  if (!Memory.moduleState) Memory.moduleState = {};
  if (!Memory.moduleState[name]) {
    Memory.moduleState[name] = { lastRun: 0, consecutiveSkips: 0 };
  }
  return Memory.moduleState[name];
}

function recordError(name: string, error: unknown) {
  if (!Memory.moduleErrors) Memory.moduleErrors = [];
  const message = (error as Error)?.stack ?? String(error);
  Memory.moduleErrors.push({ tick: Game.time, module: name, message: message.slice(0, 500) });
  if (Memory.moduleErrors.length > MAX_ERRORS) Memory.moduleErrors.shift();
}

export function runModuleManager(modules: Module[], cpuLimit: number) {
  const start = Game.cpu.getUsed();
  pruneModuleState(modules);

  // Find ONE module to force-run (the most starved one past DEFAULT_MAX_SKIPS)
  let moduleToForce: string | null = null;
  let mostSkips = 0;
  for (const module of modules) {
    if (module.mandatory) continue;
    const state = getModuleState(module.name);
    if (state.consecutiveSkips >= DEFAULT_MAX_SKIPS && state.consecutiveSkips > mostSkips) {
      moduleToForce = module.name;
      mostSkips = state.consecutiveSkips;
    }
  }

  for (const module of modules) {
    const state = getModuleState(module.name);
    runIntervals.set(module.name, module.runEvery ?? 1);

    // Not due yet (mandatory and "always" modules skip the bucket check, not runEvery)
    if (module.runEvery && state.lastRun + module.runEvery > Game.time) continue;
    if (!isAllowedByBucket(module, state.lastRun)) continue;

    const remainingCpu = cpuLimit - (Game.cpu.getUsed() - start);
    const shouldForce = module.name === moduleToForce;

    // Skip check (forced modules bypass the CPU check, not the bucket throttling)
    if (!module.mandatory && !shouldForce && remainingCpu < 0) {
      state.consecutiveSkips++;
      log.warn("ModuleManager", `CPU limit reached, skipping: ${module.name} (skips: ${state.consecutiveSkips})`);
      continue;
    }

    const before = Game.cpu.getUsed();
    try {
      module.fn();
    } catch (error) {
      // No rerun: a partial run already issued intents, rerunning would duplicate them
      log.error("ModuleManager", `Error in module ${module.name}:`, (error as Error).stack);
      recordError(module.name, error);
    }
    const cpu = Game.cpu.getUsed() - before;
    // Total CPU per module (avgCpu only reflects the last ~10 runs)
    countStat(`cpu:module:${module.name}`, cpu);
    // 4 decimals: full doubles cost ~12 chars of Memory per module
    state.avgCpu = Math.round((state.avgCpu === undefined ? cpu : state.avgCpu * 0.9 + cpu * 0.1) * 10000) / 10000;
    state.lastRun = Game.time;
    state.consecutiveSkips = 0;
  }
}
