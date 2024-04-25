import { gameLoop } from "gameLoop";
import profiler from "utils/profiler";
import MemHack from "utils/MemHack";
import { } from "./type"

try {
  console.log("Global reset detected. Build time", new Date(JSON.parse("__buildDate__")));
} catch {
  // Ignore
}

//profiler.enable();
export const loop = () => {
  MemHack.pretick();
  profiler.wrap(gameLoop);
};
