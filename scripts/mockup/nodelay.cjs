/**
 * Preloaded (node -r) in the mockup process and, through the inherited execArgv, in every engine
 * child process (storage, runner, processor): disables Nagle's algorithm on all TCP sockets.
 * The storage RPC is many small request/response frames over localhost; with Nagle each round trip
 * waits for a delayed ACK and a tick takes ~280 ms instead of a few ms.
 */
const net = require("net");

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  this.setNoDelay(true);
  return connect.apply(this, args);
};

/**
 * Not a speed-up: `--nuke-flight N` (sim.cjs) shortens a nuke's flight from NUKE_LAND_TIME (50000) to N
 * ticks, in the engine (processor: launchNuke) and in the bot's constants (runner) alike. The engine
 * processes are forked with their own environment (screeps-server-mockup startProcess), so the value comes
 * from a file sim.cjs writes in the server directory before they start (NUKE_LAND_TIME_FILE).
 */
const NUKE_LAND_TIME_FILE = "/tmp/mockup-server/nuke-land-time";
function patchNukeLandTime(value) {
  try {
    const path = require("path");
    const paths = [process.env.NODE_PATH, path.join(__dirname, "node_modules"), "/mockup/node_modules"].filter(Boolean);
    require(require.resolve("@screeps/common/lib/constants", { paths })).NUKE_LAND_TIME = value;
    return true;
  } catch {
    return false; // engine not installed next to this file
  }
}
try {
  const value = Number(require("fs").readFileSync(NUKE_LAND_TIME_FILE, "utf-8"));
  if (value > 0) patchNukeLandTime(value);
} catch {
  // no --nuke-flight
}
module.exports = { NUKE_LAND_TIME_FILE, patchNukeLandTime };

const createServer = net.createServer;
net.createServer = function (...args) {
  const server = createServer.apply(this, args);
  server.on("connection", (socket) => socket.setNoDelay(true));
  return server;
};
