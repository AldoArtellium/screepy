import { gameLoop } from "gameLoop";
import { log } from "utils/logger";
import MemHack from "utils/MemHack";
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

export const loop = () => {
  MemHack.pretick();
  trafficManager.preTick();
  gameLoop();
  recordTickStats();
};
