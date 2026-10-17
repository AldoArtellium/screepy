# In-process Screeps engine (screeps-server-mockup) for fast bot tests, see run.mjs.
# Same engine as the private server: screeps 4.3.0 on Node 24. Linux image because @screeps/driver
# compiles native code (pathfinder, isolated-vm from git) and the host has no C++ toolchain.
FROM node:24-bookworm
WORKDIR /mockup
COPY package.json ./
COPY vendor ./vendor
RUN npm install --no-audit --no-fund && npm cache clean --force
ENV NODE_PATH=/mockup/node_modules
