/**
 * Preloaded (node -r) in the mockup process and, through the inherited execArgv, in every engine
 * child process (storage, runner, processor). Speed-ups that do not change the simulation:
 *
 * - nodelay.cjs: no Nagle on the storage RPC sockets (without it a tick takes ~280 ms).
 * - processor: no room history (env roomHistory:<room>, replay data for the web client only; the
 *   storage answers each hmset with the whole hash, which grows without bound for rooms that are not
 *   active on a multiple of 20 ticks: up to ~0.4 MB of JSON per call after a few thousand ticks) and
 *   no mapView:<room> writes (world map of the web client, never read by the engine).
 * - runner: users.code fetched once (the 400+ KB bundle went through the RPC every tick; the code
 *   never changes during a mockup run).
 * - processor: room terrain fetched once per room (static).
 *
 * Run with nodelay.cjs alone instead (run.mjs --no-fast) to get the unpatched engine.
 */
require("./nodelay.cjs");

const path = require("path");

let rpc;
try {
  const paths = [process.env.NODE_PATH, path.join(__dirname, "node_modules"), "/mockup/node_modules"].filter(Boolean);
  rpc = require(require.resolve("@screeps/common/lib/rpc", { paths }));
} catch {
  // engine not installed next to this file: nothing to patch
}

const script = path.basename(process.argv[1] || "");

if (rpc && (script === "runner.js" || script === "processor.js")) {
  const { RpcClient } = rpc;
  const request = RpcClient.prototype.request;
  const cache = new Map();
  const cached = (self, key, method, args) => {
    let p = cache.get(key);
    if (!p) {
      p = request.call(self, method, ...args);
      cache.set(key, p);
      // Do not keep a failed or empty answer
      p.then(
        (r) => r || cache.delete(key),
        () => cache.delete(key)
      );
    }
    return p;
  };
  const isRoomHistory = (key) => typeof key === "string" && key.startsWith("roomHistory:");

  RpcClient.prototype.request = function (method, ...args) {
    if (script === "runner.js") {
      if (method === "dbRequest" && args[0] === "users.code" && args[1] === "findOne")
        return cached(this, `code:${JSON.stringify(args[2])}`, method, args);
    } else {
      if (method === "dbEnvHmset" && isRoomHistory(args[0])) return Promise.resolve({});
      if (method === "dbEnvGet" && isRoomHistory(args[0])) return Promise.resolve(null);
      if (method === "dbEnvSet" && typeof args[0] === "string" && args[0].startsWith("mapView:"))
        return Promise.resolve("OK");
      if (method === "dbRequest" && args[0] === "rooms.terrain" && args[1] === "find")
        return cached(this, `terrain:${JSON.stringify(args[2])}`, method, args);
    }
    return request.call(this, method, ...args);
  };
}
