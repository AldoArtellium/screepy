# Military: colony missions, spawn and tower first, controller takeover (2026-11-14)

## Measured problem (shard0, tick ~79037300)

- 10 missions logged, 37 creeps lost, 0 room gained. A mission "success" means no spawn, tower or
  invader core left (`military.ts` `isNeutralized`); the controller is never attacked, so the owner keeps
  the room and rebuilds: Blindfold's W25N7 (razed twice) is RCL 6 with 2 towers, W29N4 ("success" at
  78827045) is RCL 7 with 3 towers and 2 spawns.
- A mission belongs to one spawn room: helpers only within 2 rooms, frozen at start, capacity >= the
  spawn room's, and a base arms one mission at a time.
- Squad targets: towers, core, spawns by range only (`duo.ts` `pickTarget`): a tower behind a 10M
  rampart is chosen over one behind 100k a few tiles further, an empty tower before a spawn.

Engine facts (screeps engine `processor/intents/creeps/attackController.js`, `controllers/tick.js`):
each CLAIM part removes `CONTROLLER_CLAIM_DOWNGRADE` 300 ticks of the downgrade timer and blocks the
owner's upgrades `CONTROLLER_ATTACK_BLOCKED_UPGRADE` 1000 ticks (no new attack before either); on a level
drop the timer restarts at `CONTROLLER_DOWNGRADE[newLevel] / 2`, `safeModeAvailable` becomes 0, and
structures above the new level's limits turn inactive; at level 0 the room is neutral. No attack in a
safe mode. A CLAIM creep lives 600 ticks: one attacker per 1000-tick cycle.

## A. Target choice (`src/military/targetChoice.ts`, pure, `tests/militaryTargets/run.mjs`)

- Classes: 0 tower with energy >= TOWER_ENERGY_COST (10) and invader core, 1 spawn, 2 empty tower,
  3 extension, 4 storage / terminal, then loot ramparts (loot.ts), then the rest.
- Within the best class present: lowest cost = (hits of the hostile rampart covering it + its own hits)
  / squad structure dps + range; ties to the closest.
- Takeover missions (C): once no class 0-2 structure is left, if no walkable tile next to the controller
  is reachable without breaking a barrier, the target is the first hostile rampart / wall on the cheapest
  path to the controller (barriers cost by hits). `isNeutralized` waits for that path too.
- duo.ts `pickTarget(room, from, dps)` and quad.ts `engage` use it.

## B. Colony missions

- `DuoMemory` / `QuadMemory`: `spawnRoom` stays the forming (rally) base, the base closest to the target
  by squad route; `bases: string[]` replaces `helpers` (old missions migrated as [spawnRoom, ...helpers]);
  `energy`: the capacity the bodies are sized on.
- Bases: every owned room RCL >= minRcl with a spawn, capacity >= `energy`, squad route to the rally
  <= `COLONY_RANGE` 4 rooms, refreshed every 100 ticks. No one-mission-per-base rule: a base serves every
  mission, missions in the order of `currentTargets()` (manual first).
- `energy` at start: candidate bases by capacity ascending, the first whose plan (planSquad with its own
  stock as boost room) is feasible; else the rally's capacity (manual attack). The boost plan is that one.
- Boosted members go to bases holding the mission's compounds for that role's parts; a base without them
  spawns the member only if no base of the mission holds them (as today: best in stock fallback).
- Map, panel, report, live-inspect print `bases`.

## C. Controller takeover (`src/military/siege.ts`, pure `src/military/siegeModel.ts`, `tests/militarySiege/run.mjs`)

- Pure: `siegeTicks(level, ticksToDowngrade, claimParts)`, `siegeClaimParts(capacity)` = min(25,
  floor(capacity / 650)), `siegeCost(ticks, claimerCost, guardCost)`; `SIEGE_MAX_TICKS` 60000.
- Intel (`HostileRoom`): `downgrade` (tick), `upgradeBlocked` (tick), `safeModeAvailable`.
- A mission against a player room (owner, not Invader) is a takeover when `Memory.military.takeover !==
  false` and the siege fits SIEGE_MAX_TICKS with the bases' biggest claimer; the ROI cost adds the siege.
- On the squad's success a takeover mission opens `Memory.military.sieges[room] = { owner, since, bases,
  losses, attacks }`, up to `maxSieges` (default 2); a sieged room is no automatic target.
- Siege spawns (bases of the siege): one `siegeGuard` (melee + heal, kills hostile creeps, stomps hostile
  construction sites spawn / tower first, else parks near the controller), replaced before it dies; one
  `controllerAttacker` (CLAIM x N + MOVE x N from the biggest base) timed to stand next to the controller
  when the upgrade block ends; it attacks once, then suicides.
- Ends: controller without owner -> `taken` (log, counter `military:siege:taken`, rooms released for
  remote mining / expansion); safe mode on, a spawn or a tower with energy rebuilt, or 6 guards lost ->
  `abandoned` (failure memory, the room becomes an ordinary candidate again).
