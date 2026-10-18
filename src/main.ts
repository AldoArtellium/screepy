import { gameLoop } from "gameLoop";
import { log } from "utils/logger";
import MemHack from "utils/MemHack";
import { installIntentCounter } from "utils/intents";
import { recordTickStats } from "utils/stats";
import { segmentsPostTick, segmentsPreTick } from "utils/segments";
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
  // Intel, room plans and remote paths live in RawMemory segments (heap copy)
  segmentsPreTick();
  trafficManager.preTick();
  gameLoop();
  segmentsPostTick();
  recordTickStats(MemHack.parseTime);
};
