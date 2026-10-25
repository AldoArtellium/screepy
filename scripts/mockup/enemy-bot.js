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
    const defenders = room.find(FIND_MY_CREEPS, { filter: (c) => c.name.startsWith("defender") });
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
  runSiege();
  runBlockers();
};

/** Siege bodies and counts, from doorknobnob's creeps in shard0 W28N7's history (2026-10-24) */
const SIEGE_ROLES = [
  { role: "drainer", count: 2, body: [MOVE, MOVE, MOVE, MOVE, HEAL, HEAL, HEAL, HEAL] },
  { role: "medic", count: 1, body: [MOVE, HEAL, MOVE, HEAL, MOVE, HEAL, MOVE, HEAL] },
  { role: "dismantler", count: 2, body: [WORK, WORK, WORK, WORK, WORK, WORK, WORK, WORK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE] },
  { role: "decoy", count: 2, body: [WORK, MOVE] }
];
/** The drainers work alone first, then the rest joins */
const DRAIN_TICKS = 300;

/** Our ramparts in the target room: the one closest to the entry (dismantlers), the farthest (decoys) */
function siegeTargets(s, room, entry) {
  const ramparts = room.find(FIND_HOSTILE_STRUCTURES, { filter: (r) => r.structureType === STRUCTURE_RAMPART });
  const others = room.find(FIND_HOSTILE_STRUCTURES, { filter: (r) => [STRUCTURE_SPAWN, STRUCTURE_TOWER, STRUCTURE_EXTENSION].includes(r.structureType) });
  const pool = ramparts.length > 0 ? ramparts : others;
  if (pool.length === 0) return;
  const byRange = _.sortBy(pool, (r) => r.pos.getRangeTo(entry));
  if (!s.target || !Game.getObjectById(s.target)) {
    s.target = byRange[0].id;
    s.targetPos = `${byRange[0].pos.x},${byRange[0].pos.y}`;
  }
  if (!s.decoyTarget || !Game.getObjectById(s.decoyTarget)) s.decoyTarget = byRange[byRange.length - 1].id;
}

/** Back home below `low` of its hits, out again from 95% (the enemy's towers heal it at home) */
function retreating(creep, low) {
  if (creep.hits < creep.hitsMax * low) creep.memory.retreat = true;
  if (creep.hits >= creep.hitsMax * 0.95) creep.memory.retreat = false;
  return creep.memory.retreat;
}

function goHome(creep) {
  const spawn = Object.values(Game.spawns)[0];
  if (spawn && creep.pos.getRangeTo(spawn) > 3) creep.moveTo(spawn, { reusePath: 5, range: 3 });
}

/** Memory.siege (sim.cjs --siege): drainers at the edge, dismantlers + medic on a rampart, decoys elsewhere */
function runSiege() {
  const s = Memory.siege;
  if (!s || Game.time < s.from) return;
  const creeps = Object.values(Game.creeps);
  const byRole = (role) => creeps.filter((c) => c.name.startsWith(role + "_"));
  const spawn = Object.values(Game.spawns).find((sp) => !sp.spawning);
  if (spawn && Memory.spawnedAt !== Game.time) {
    const draining = Game.time < s.from + DRAIN_TICKS;
    const next = SIEGE_ROLES.find((r) => (!draining || r.role === "drainer") && byRole(r.role).length < r.count);
    if (next && spawn.spawnCreep(next.body, `${next.role}_${Game.time}`) === OK) {
      s.spawned[next.role] = (s.spawned[next.role] || 0) + 1;
      Memory.spawnedAt = Game.time;
    }
  }
  const room = Game.rooms[s.room];
  const home = Object.values(Game.spawns)[0];
  if (room && home) {
    const exit = room.findExitTo(home.room.name);
    const entry = exit > 0 ? new RoomPosition(25, 25, s.room).findClosestByRange(exit) : null;
    if (entry) {
      s.entry = { x: entry.x, y: entry.y };
      siegeTargets(s, room, entry);
    }
  }
  // The assault squad (dismantlers + medic) gathers at home and leaves together, then fights until
  // all of it is dead or retreating
  const squad = [...byRole("dismantler"), ...byRole("medic")].filter((c) => !c.spawning);
  const full = byRole("dismantler").length >= 2 && byRole("medic").length >= 1 && squad.length >= 3;
  if (full) s.assault = true;
  if (squad.length === 0) s.assault = false;
  const target = s.target && Game.getObjectById(s.target);
  const decoyTarget = s.decoyTarget && Game.getObjectById(s.decoyTarget);
  const center = new RoomPosition(25, 25, s.room);
  for (const creep of byRole("drainer")) {
    if (creep.spawning) continue;
    if (creep.hits < creep.hitsMax) creep.heal(creep);
    if (retreating(creep, 0.5)) {
      goHome(creep);
      continue;
    }
    // Two tiles in from the entry edge: in range of the towers, one step from leaving
    const spot = s.entry ? new RoomPosition(Math.min(47, Math.max(2, s.entry.x)), Math.min(47, Math.max(2, s.entry.y)), s.room) : center;
    if (!creep.pos.isEqualTo(spot)) creep.moveTo(spot, { reusePath: 5 });
  }
  const dismantlers = byRole("dismantler").filter((c) => !c.spawning);
  for (const creep of dismantlers) {
    if (!s.assault) {
      goHome(creep);
      continue;
    }
    if (retreating(creep, 0.4)) {
      goHome(creep);
      continue;
    }
    if (!target) {
      creep.moveTo(center, { reusePath: 5, range: 10 });
      continue;
    }
    if (creep.pos.getRangeTo(target) > 1) creep.moveTo(target, { reusePath: 5, range: 1 });
    else {
      const result = creep.dismantle(target);
      if (result === OK) s.dismantled += creep.getActiveBodyparts(WORK) * DISMANTLE_POWER;
      else s.dismantleErrors = Object.assign(s.dismantleErrors || {}, { [result]: ((s.dismantleErrors || {})[result] || 0) + 1 });
    }
  }
  for (const creep of byRole("medic")) {
    if (creep.spawning) continue;
    if (!s.assault) {
      goHome(creep);
      continue;
    }
    const patients = dismantlers.filter((d) => !d.memory.retreat);
    const patient = _.min(patients.length ? patients : [creep], (d) => d.hits / d.hitsMax);
    if (creep.hits < creep.hitsMax * 0.5 || patients.length === 0) {
      if (creep.hits < creep.hitsMax) creep.heal(creep);
      goHome(creep);
      continue;
    }
    if (creep.pos.getRangeTo(patient) > 1) creep.moveTo(patient, { reusePath: 2, range: 1 });
    const hurt = creep.hits < creep.hitsMax && creep.hits / creep.hitsMax < patient.hits / patient.hitsMax;
    if (hurt) creep.heal(creep);
    else if (creep.pos.getRangeTo(patient) <= 1) creep.heal(patient);
    else creep.rangedHeal(patient);
  }
  for (const creep of byRole("decoy")) {
    if (creep.spawning) continue;
    if (!decoyTarget) {
      creep.moveTo(center, { reusePath: 5, range: 10 });
      continue;
    }
    if (creep.pos.getRangeTo(decoyTarget) > 1) creep.moveTo(decoyTarget, { reusePath: 5, range: 1 });
    else if (creep.dismantle(decoyTarget) === OK) s.decoyDismantled += DISMANTLE_POWER;
  }
}

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
  if (blockers.length < b.count && Memory.spawnedAt !== Game.time) {
    const spawn = Object.values(Game.spawns).find((s) => !s.spawning);
    if (spawn && spawn.spawnCreep([MOVE], "blocker" + Game.time) === OK) {
      b.spawned++;
      Memory.spawnedAt = Game.time;
    }
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
