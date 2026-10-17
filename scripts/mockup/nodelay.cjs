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

const createServer = net.createServer;
net.createServer = function (...args) {
  const server = createServer.apply(this, args);
  server.on("connection", (socket) => socket.setNoDelay(true));
  return server;
};
