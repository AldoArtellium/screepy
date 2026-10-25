// Enemy player of the mockup (--enemy): a static base that defends itself.
// Towers shoot the closest hostile creep, else heal a wounded own creep, else repair the weakest
// rampart (above half energy). With Memory.defenders (set by sim.cjs --enemy ROOM:RCL:defenders),
// the spawn keeps that many melee defenders that charge hostiles in the room.
module.exports.loop = function () {
  for (const name in Game.rooms) {
    const room = Game.rooms[name];
    if (!room.controller || !room.controller.my) continue;
    const hostiles = room.find(FIND_HOSTILE_CREEPS);
    const towers = room.find(FIND_MY_STRUCTURES, { filter: (s) => s.structureType === STRUCTURE_TOWER });
    for (const tower of towers) {
      const target = tower.pos.findClosestByRange(hostiles);
      if (target) {
        tower.attack(target);
        continue;
      }
      const wounded = room.find(FIND_MY_CREEPS, { filter: (c) => c.hits < c.hitsMax })[0];
      if (wounded) {
        tower.heal(wounded);
        continue;
      }
      if (tower.store.energy < 800) continue;
      const ramparts = room.find(FIND_MY_STRUCTURES, { filter: (s) => s.structureType === STRUCTURE_RAMPART && s.hits < s.hitsMax });
      const weakest = ramparts.sort((a, b) => a.hits - b.hits)[0];
      if (weakest) tower.repair(weakest);
    }
    const wanted = Memory.defenders || 0;
    const defenders = room.find(FIND_MY_CREEPS, { filter: (c) => !c.name.startsWith("blocker") });
    for (const creep of defenders) {
      const target = creep.pos.findClosestByRange(hostiles);
      if (!target) continue;
      if (creep.attack(target) === ERR_NOT_IN_RANGE) creep.moveTo(target);
    }
    if (defenders.length < wanted && hostiles.length > 0) {
      const spawn = room.find(FIND_MY_SPAWNS)[0];
      if (spawn && !spawn.spawning) spawn.spawnCreep([ATTACK, ATTACK, MOVE, MOVE], "defender" + Game.time);
    }
  }
  runBlockers();
};

/** Free tiles next to the controller and sources of a visible room, controller first */
function blockingTiles(room) {
  const terrain = room.getTerrain();
  const tiles = [];
  const targets = [room.controller, ...room.find(FIND_SOURCES)].filter(Boolean);
  for (const target of targets) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const x = target.pos.x + dx;
        const y = target.pos.y + dy;
        if (x < 1 || y < 1 || x > 48 || y > 48 || terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
        const blocked = room.lookForAt(LOOK_STRUCTURES, x, y).some(
          (s) => s.structureType !== STRUCTURE_ROAD && s.structureType !== STRUCTURE_CONTAINER && !(s.structureType === STRUCTURE_RAMPART && (s.my || s.isPublic))
        );
        if (!blocked && !tiles.some((t) => t.x === x && t.y === y)) tiles.push({ x, y });
      }
    }
  }
  return tiles;
}

/** Memory.blockers (sim.cjs --blockers): single-MOVE creeps parked next to the controller and sources */
function runBlockers() {
  const b = Memory.blockers;
  if (!b || Game.time < b.from) return;
  const blockers = Object.values(Game.creeps).filter((c) => c.name.startsWith("blocker"));
  if (blockers.length < b.count) {
    const spawn = Object.values(Game.spawns).find((s) => !s.spawning);
    if (spawn && spawn.spawnCreep([MOVE], "blocker" + Game.time) === OK) b.spawned++;
  }
  const room = Game.rooms[b.room];
  const tiles = room ? blockingTiles(room) : [];
  const taken = new Set(blockers.map((c) => c.memory.tile).filter((t) => t !== undefined));
  for (const creep of blockers) {
    if (creep.spawning) continue;
    if (creep.memory.tile === undefined && tiles.length > 0) {
      const free = tiles.findIndex((_t, i) => !taken.has(i));
      if (free !== -1) {
        creep.memory.tile = free;
        taken.add(free);
      }
    }
    const tile = tiles[creep.memory.tile];
    const target = tile ? new RoomPosition(tile.x, tile.y, b.room) : new RoomPosition(25, 25, b.room);
    if (!creep.pos.isEqualTo(target)) creep.moveTo(target, { reusePath: 5, range: tile ? 0 : 5 });
  }
}
