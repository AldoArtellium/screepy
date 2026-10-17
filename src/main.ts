import { gameLoop } from "gameLoop";
import { log } from "utils/logger";
import MemHack from "utils/MemHack";
import profiler from "utils/profiler";
import { installIntentCounter } from "utils/intents";
import { recordTickStats } from "utils/stats";
import { trafficManager } from "modules/TrafficManager";
import { } from "./type";

try {
  log.info("Main", "Global reset detected. Build time", new Date(JSON.parse("__buildDate__")));
} catch {
  // Ignore
}

installIntentCounter();

// profiler.enable();
export const loop = () => {
  MemHack.pretick();
  trafficManager.preTick();
  profiler.wrap(gameLoop);
  recordTickStats();
};
