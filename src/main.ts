import { gameLoop } from "gameLoop";
import { log } from "utils/logger";
import MemHack from "utils/MemHack";
import profiler from "utils/profiler";
import { } from "./type";

try {
  log.info("Main", "Global reset detected. Build time", new Date(JSON.parse("__buildDate__")));
} catch {
  // Ignore
}

// profiler.enable();
export const loop = () => {
  MemHack.pretick();
  profiler.wrap(gameLoop);
};
