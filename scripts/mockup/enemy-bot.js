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
    const defenders = room.find(FIND_MY_CREEPS);
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
};
