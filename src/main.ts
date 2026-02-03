import { gameLoop } from "gameLoop";
import { log } from "utils/logger";
import MemHack from "utils/MemHack";
import { MemoryReset } from "utils/memoryReset";
import profiler from "utils/profiler";
import { roomManager } from "modules/RoomManager";
import { } from "./type";

// Ensure MemoryReset is available in console (re-export for type reference)
export { MemoryReset };

// Export roomManager for console debugging
// Usage: roomManager.debugPhase('roomName')
export { roomManager };

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
