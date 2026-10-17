# Hivemind : spécification du SPAWNING (économie RCL 1-4, room unique)

Source : bot Hivemind (MIT), clone lecture seule `C:\Users\ruffa\AppData\Local\Temp\bots\hivemind`.
Toutes les références `fichier:ligne` sont relatives à `src/`.
Objectif : règles exactes à réimplémenter, pas l'architecture (pas de prototypes).

Constantes Screeps utilisées (rappel) :
`CREEP_SPAWN_TIME=3`, `CREEP_LIFE_TIME=1500`, `ENERGY_REGEN_TIME=300`, `SOURCE_ENERGY_CAPACITY=3000` (room possédée/réservée),
`SPAWN_ENERGY_CAPACITY=300`, `EXTENSION_ENERGY_CAPACITY={0..6:50, 7:100, 8:200}`, `CARRY_CAPACITY=50`, `UPGRADE_CONTROLLER_POWER=1`,
`MAX_CREEP_SIZE=50`, `CONTROLLER_DOWNGRADE={1:20000, 2:10000, 3:20000, 4:40000, 5:80000, ...}`.
Capacité d'énergie (spawn + extensions pleines) : RCL1 300, RCL2 550, RCL3 800, RCL4 1300.

---

## 0. Vue d'ensemble

```
chaque tick, pour chaque room possédée :
  spawns = spawns de la room où spawn.isOperational()              // process/rooms/owned/spawns.ts:53
  spawnManager.manageSpawns(room, spawns)                           // process/rooms/owned/spawns.ts:55 ; PROCESS_PRIORITY_ALWAYS, pas d'intervalle (process/rooms/owned.ts:103-108)
```

- Chaque "spawn role" (classe) expose `getSpawnOptions(room) -> SpawnOption[]`, `getCreepBody(room, option)`, `getCreepMemory(room, option)`, `getCreepBoosts`, `onSpawn`.
- `SpawnOption = { role?, priority: number, weight: number, preferClosestSpawn?: RoomPosition, ...champs propres au rôle }` (spawn-manager.ts:23-28).
- Ordre d'enregistrement des rôles (important pour les égalités, voir §1.3) — container-factory.ts:71-89 :
  `brawler, builder, dismantler, harvester, harvester.deposit, harvester.minerals, harvester.power, hauler.power, helper, mule, reclaim, remote-mine, room-defense, scout, squad, transporter, upgrader`.
- Le nom de clé (`roleId`) est mis par défaut dans `option.role` (spawn-manager.ts:99). Exception : `room-defense` met `memory.role = option.creepRole` (`brawler`/`guardian`/`builder`) via `getCreepMemory` (spawn-role/room-defense.ts:206-213), donc le creep a le rôle réel, mais `option.role === 'room-defense'`.

Résumé des priorités RCL1-4 (plus haut = gagne) :

| Cas | priority | weight |
|---|---|---|
| Harvester initial "force" (aucun harvester dans la room et (pas de storage ou storage < 5000)) | 6 | (50 - dSpawnSource)/50 |
| Transporter, storage/terminal présent, 0 transporter (forcé) | 6 | 1 |
| Harvester initial, early game (pas de storage ni terminal) | 5 | (50 - d)/50 |
| Harvester additionnel, early game (RCL ≤ 3) | 5 | 1 - work/maxWork/2 - (50-d)/100 |
| Transporter sans storage, 0 transporter, a des extensions et pas de hauler (forcé) | 5 | 1 |
| Transporter sans storage, 0 transporter, cas général | 5 | 0.5 |
| Transporter sans storage, 0 transporter, pas de builder/upgrader et spawn à < 5 d'une source | 4 | 0 |
| Transporter sans storage, 1 ≤ count < max/2 | 4 | 0 |
| Transporter avec storage, 1 ≤ count < max/2 | 5 | 0 |
| Transporter, count ≥ max/2 | storage ? 4 : 3 | 0.5 |
| Harvester initial / additionnel avec storage | 4 | idem |
| Upgrader, controller proche du downgrade (< 10 %) | 5 | 1 |
| Upgrader normal | 3 | 1 |
| Builder, il existe des chantiers (ou ramparts faibles avec terminal) | 4 | 0.5 |
| Builder, sinon | 3 | 0.5 |
| Brawler (défense RCL < 4) | 5 | 1 |
| Guardian (défense RCL ≥ 4) | 5 | 1 |
| Builder d'urgence (défense RCL ≥ 4) | 4 | 1 |
| Scout early game (1 seule room, pas de storage/terminal) | 4 | 1 |
| Scout sinon | 1 (setting `scoutSpawnPriority`) | 0 |

---

## 1. SpawnManager (spawn-manager.ts)

### 1.1 Collecte des options

```ts
getAllSpawnOptions(room): SpawnOption[] {                                  // spawn-manager.ts:88
  // Cache "room idle" : si la dernière collecte était vide, ne rien recalculer pendant 10 ticks.
  if ((roomsWithIdleSpawns[room.name] || -100) > Game.time) return [];      // :89
  return cachePerTick(room, 'spawnQueue', () => {                           // :91 (cache.inObject, durée 1 tick)
    options = []
    for (roleId, role) in roles (ordre d'enregistrement) :
      for option of role.getSpawnOptions(room) :
        if (option.role === undefined) option.role = roleId                 // :99
        options.push(option)
    if (options.length === 0) roomsWithIdleSpawns[room.name] = Game.time + 10   // :106
    return options
  })
}
```

Note : en plus de ce cache global "room idle 10 ticks", chaque rôle a son propre cache d'options vides (§2), en heap (perdu au global reset).

### 1.2 manageSpawns

```ts
manageSpawns(room, spawns) {                                               // :120
  makeWayForSpawns(room, spawns)                                           // :121 (§1.6)
  available = spawns.filter(s => !s.spawning)                              // :123, :332-338
  if (available.length === 0) return                                       // :124

  options = getAllSpawnOptions(room).filter(option => {                    // :126-138
    if (!option.preferClosestSpawn) return true
    closest = argmin(spawns, s => range(s, option.preferClosestSpawn))     // parmi TOUS les spawns opérationnels
    // Si un spawn est "proche" (range < 3) de la position préférée mais occupé, l'option est écartée ce tick
    if (range(closest, pref) < 3 && !available.includes(closest)) return false
    return true
  })

  option = getBestOption(options)                                          // :139 (§1.3)
  if (!option) return

  spawn = randomSample(available)                                          // :142 (_.sample)
  if (option.preferClosestSpawn) {
    closest = argmin(spawns, range to pref)
    if (range(closest, pref) < 3) {
      if (!available.includes(closest)) return                             // :148 (jamais atteint grâce au filtre)
      spawn = closest
    }
  }

  if (!trySpawnCreep(room, spawn, option)) {                               // :154
    // "Attente d'énergie" : on NE tente PAS l'option suivante. Tous les spawns disponibles sont marqués waiting
    // (uniquement pour stats/visuels : affiche energyAvailable/coût et role@priority).
    for s of available: s.waiting = true                                   // :155-177
  }
  for s of spawns: s.numSpawnOptions = options.length                      // :180-182 (stats)
}
```

Conséquences clés :
- **Un seul creep au plus par tick et par room** (une seule option choisie, un seul spawn utilisé), même s'il y a plusieurs spawns libres.
- **Blocage strict** : si la meilleure option n'est pas finançable (`cost > room.energyAvailable`), rien d'autre n'est spawné ; la room attend.
- `preferClosestSpawn` n'est utilisé que par les harvesters (= position de la source). Avec un seul spawn à range ≥ 3 de la source, il n'a aucun effet.

### 1.3 Choix de l'option — utilities.ts:141-152

```ts
getBestOption(options) {
  best = null
  for o of options (ordre de collecte) :
    if (o.priority < 0) continue
    if (!best || o.priority > best.priority || (o.priority === best.priority && o.weight > best.weight)) best = o
  return best
}
```
Comparaison stricte : à priorité et poids égaux, **la première option collectée gagne** (ordre des rôles §0, puis ordre de push dans le rôle ; pour les harvesters, ordre de `room.sources` = ordre de `room.find(FIND_SOURCES)`, prototype/room.intel.ts:110-113).

### 1.4 trySpawnCreep — :198-277

```ts
trySpawnCreep(room, spawn, option): boolean {
  role = roles[option.role]
  body = role.getCreepBody(room, option)                                   // :200
  if (!body || body.length === 0) return false                             // :202
  cost = sum(BODYPART_COST[p])
  if (cost > room.energyAvailable) return false                            // :209  <-- attente d'énergie
  if (spawn.spawnCreep(body, 'dryRun', {dryRun: true}) !== OK) return false // :212
  memory = role.getCreepMemory(room, option); memory.role ??= option.role  // :215-218
  name = generateCreepName(memory.role)                                    // :222 (§1.5)
  directions = spawn.getSpawnDirections()                                  // :223 (§1.7) — undefined sans room planner
  energyStructures = room.getEnergyStructures()                            // :224 (§1.7) — undefined sans room planner
  result = spawn.spawnCreep(body, name, { memory, directions, energyStructures })
  if (result !== OK) {
    log erreur
    if (result === ERR_NOT_ENOUGH_RESOURCES && cost <= energyCapacityAvailable && cost <= energyAvailable
        && count(room.creepsByRole.transporter) === 0)
      spawnRecoveryCreep(room, spawn)                                       // :237-251
    return false
  }
  Memory.creepCounter[memory.role]++                                       // :257
  boosts (ignoré RCL1-4)                                                   // :260-272
  role.onSpawn(room, option, body, name)                                   // :275
  return true
}
```

Le corps est **recalculé à chaque tick** à partir de `room.energyAvailable` courant (les limites d'énergie dépendent de `energyAvailable`, §3).

### 1.5 Creep de récupération — :279-292

Cas : le moteur renvoie `ERR_NOT_ENOUGH_RESOURCES` alors que le coût ≤ capacité et ≤ énergie disponible (énergie présente mais dans des structures inutilisables, ex. extensions désactivées après downgrade) **et** 0 transporter dans la room.
```ts
body = [CARRY, CARRY, MOVE, CARRY, CARRY, MOVE]          // 300 énergie
spawn.spawnCreep(body, generateCreepName('transporter'), { memory: { role: 'transporter', singleRoom: room.name } })
// pas de energyStructures => le moteur prend l'énergie dans l'ordre par défaut
```

### 1.6 Noms — :303-321
`Memory.creepCounter[role]` initialisé à 0, remis à 0 s'il atteint `36*36 = 1296`. Nom = `abbrev + '_' + counter.toString(36)` avec abbrev : builder `B`, harvester `H`, transporter `T`, upgrader `U`, brawler `F`, guardian `FE`, scout `S`, ... (:31-51) ; sinon le nom du rôle. Si le nom existe déjà : `counter++` et réessai récursif. Le compteur n'est incrémenté qu'après un spawn réussi (:257).

### 1.7 Dégagement des spawns — makeWayForSpawns :340-381
```ts
for spawn of spawns:
  if (!spawn.spawning || spawn.spawning.remainingTime > 0) { delete heap.blocked; continue }
  // le creep a fini mais ne peut pas sortir
  heap.blocked = (heap.blocked || 0) + 1
  if (heap.blocked >= 5) spawn.spawning.setDirections(ALL_8_DIRECTIONS)
  dirs = spawn.spawning.directions || ALL_8
  allBlocked = aucune case adjacente (dans dirs) qui soit : sans creep, pas un mur, sans power creep, sans structure OBSTACLE_OBJECT_TYPES
  if (allBlocked) for creep of creepsInRange(spawn, 1) if (creep.my) creep.move(randomDirection)
```

### 1.8 Dépendances room planner du spawn manager
- `getSpawnDirections` (prototype/structure.ts:130-152) : sans planner → `undefined` (toutes directions). Avec planner : directions vers les cases adjacentes non-mur, **planifiées route**, non `bay_center`, sans structure obstacle ; cache heap 2500 ticks ; liste vide → `undefined`.
- `getEnergyStructures` (prototype/room.structures.ts:243-301) : sans planner → `undefined` (ordre moteur). Avec planner : extensions/spawns des bays triées par `priority = bay.energy/bay.energyCapacity` (bays d'un harvester adjacent à une source : `max(0, source.energy + bay.cap - container.energy)/bay.cap`) `+ distance(centre, bay)/50` (bay vide → 999), puis structures hors bay triées par distance au centre. Cache 1 tick.

---

## 2. SpawnRole de base (spawn-role/spawn-role.ts)

Cache d'options vides par rôle et par room (heap, instance du rôle) :
```ts
cacheEmptySpawnOptionsFor(room, timeout, callback) {            // spawn-role.ts:137-144
  if ((roomTimeouts[room.name] || -1000) > Game.time) return []  // :146-150
  options = callback()
  if (options.length === 0) roomTimeouts[room.name] = Game.time + timeout   // :152-156
  return options
}
```
Timeouts : harvester 10, transporter 10, builder **50**, upgrader **100**, room-defense 10, scout 50.
Effet : une fois qu'un rôle n'a rien demandé, il est sourd pendant `timeout` ticks (ex. un builder ne sera pas redemandé avant 50 ticks même si un chantier apparaît ; la défense réagit avec jusqu'à 10 ticks de retard, + 10 ticks possibles du cache global §1.1).

`calculateBodyCost(body) = sum(BODYPART_COST)` (:133-135).

---

## 3. BodyBuilder (creep/body-builder.ts) — algorithme exact

### 3.1 Paramètres
```ts
moveMode = PLAINS(1)          // défaut :45
maxSize = 50                  // :46
energyLimit = null            // :47 ; falsy => pas de limite
weights = {}                  // normalisés (somme = 1, MOVE exclu, poids ≤ 0 exclus) :89-103
partLimits = {}               // limite falsy (0/undefined/null) => ignorée
moveBufferRatio = 0
carryContentLevel = 1         // multiplicateur de fatigue des CARRY
movePartBoost = undefined     // ignoré ici => force d'un MOVE = 2
```
Fatigue générée par une part non-MOVE (:177-201), `m = (part === CARRY ? carryContentLevel : 1)` :
| mode | valeur | fatigue/part |
|---|---|---|
| ROAD | 0 | 1·m |
| PLAINS | 1 | 2·m |
| SWAMP | 2 | 10·m |
| SLOW | 3 | 0.4·m |
| MINIMAL | 4 | 0.001·m |
| NONE | 5 | 0 |
MOVE génère 0. Force d'un MOVE = 2 (:209-213).

### 3.2 Comptage des parts — calculatePartCounts :112-147
```ts
function fatigueWith(counts, extraPart) = fatigue(extraPart) + Σ counts[p] * fatigue(p)

counts = { move: 0 }; size = 0; cost = 0
for part in weights (ordre d'insertion des clés) { counts[part] = 1; size++; cost += COST[part] }   // 1 de chaque part pondérée
counts.move = ceil(fatigueWith(counts, MOVE) / 2); size += counts.move; cost += 50 * counts.move
if (size > maxSize) return {}                     // corps vide
if (energyLimit && cost > energyLimit) return {}  // corps vide => le spawn manager renvoie false (rien ne spawn)

while (size < maxSize) {
  next = nextBodyPart(counts)
  if (partLimits[next] && counts[next] >= partLimits[next]) break   // ATTENTION : stop total, pas de repli sur une autre part
  neededMoves = ceil(fatigueWith(counts, next) / 2) - counts.move
  partCost = COST[next] + neededMoves * 50
  if (energyLimit && cost + partCost > energyLimit) break           // stop total aussi (pas d'essai d'une part moins chère)
  if (size + neededMoves + 1 > maxSize) break
  counts[next]++; counts.move += neededMoves; size += 1 + neededMoves; cost += partCost
}
return counts

function nextBodyPart(counts) {                                       // :149-159
  current = normalize(counts)                                         // proportions actuelles hors MOVE
  fallback = null
  for part in keys(weights) (ordre d'insertion) {
    if ((current[part] || 0) < weights[part]) return part             // première part sous sa proportion cible
    if (!fallback) fallback = part
  }
  return fallback                                                     // toutes à la cible => première clé
}
```

### 3.3 Tri — generateSortedParts :215-249
```ts
body = []
push TOUGH × counts.tough
// round-robin sur les clés de counts (ordre : move d'abord (sauté), puis ordre d'insertion des weights),
// en sautant ATTACK, RANGED_ATTACK, HEAL, MOVE : une part de chaque type par passe jusqu'à épuisement
repeat until no push: for part of keys(counts) if not military/move and counts[part] > 0: push part; counts[part]--
push RANGED_ATTACK×n, puis ATTACK×n, puis HEAL×n
return interweaveMoveParts(body, counts.move)
```

### 3.4 Entrelacement des MOVE — interweaveMoveParts :251-286
```ts
strength = 2
totalFatigue = Σ fatigue(p) for p in body
movePower = moves * strength
out = []; functional = 0
for part of body {
  while (movePower - totalFatigue >= strength) { out.push(MOVE); movePower -= strength }   // MOVE excédentaires placés tôt
  if (1 - functional / body.length <= moveBufferRatio) {         // dans les derniers (ratio) % : tous les MOVE restants
    while (movePower > 0) { out.push(MOVE); movePower -= strength }
  }
  out.push(part); functional++
  if (part === CARRY) totalFatigue -= fatigue(CARRY)            // une CARRY vide ne fatigue pas => libère du "surplus"
}
while (movePower > 0) { out.push(MOVE); movePower -= strength }
return out
```

### 3.5 Corps obtenus (simulation fidèle de l'algorithme)
Notation W=WORK, C=CARRY, M=MOVE, A=ATTACK. Voir §4-§8 pour les paramètres de chaque rôle.

| Rôle / cas | E=300 | E=550 | E=800 | E=1300 |
|---|---|---|---|---|
| Harvester MINIMAL, limite W=5, E=cap | WCWM (300) | WCWWWM (500) | WCWCWWWM (650, 5W2C1M) | idem 650 |
| Harvester ROAD, limite W=5, E=cap | WCWM (300) | WCWWWMM (550) | WCWCWWWMMM (750, 5W2C3M) | idem 750 |
| Harvester forcé (E=300) | WCWM (300) | WCWM | WCWM | WCWM |
| Transporter, limite C=12, E=cap | CCMCCM (300) | CMCCMCCMCCM (550, 7C4M) | CCMCCMCCMCCMCCM (750, 10C5M) | 12C6M (900) |
| Transporter, E=0.9·cap | CMCCM (250) | 6C3M (450) | 9C5M (700) | 12C6M (900) |
| Transporter forcé (E=250) | CMCCM (250, 3C2M) | idem | idem | idem |
| Builder, E=cap | WCM (200) | WCMWCWMM (550, 3W2C3M) | 4W3C4M (750) | 7W6C... (1250, 18p) |
| Builder, E=0.9·cap | WCM (200) | WCWCMM (400) | 3W3C3M (600) | 6W5C6M (1150) |
| Upgrader sans container/link, E=cap | CWCM (250) | CWCWCWMM (550, 3C3W2M) | 5C4W2M (750) | 8C7W4M (1300) |
| Upgrader avec container, E=cap | CWWM (300) | CWWWWM (500) | CWWWWWWMM (750, 1C6W2M) | 2C10W2M (1200) |
| Upgrader mini (W≤2) | CWM / CWWM | CWWM (300) | CWWM | CWWM |
| Brawler, E=cap | AMA (210) | AMMMAAAA (550, 5A3M) | 7A4M (760) | 12A6M (1260) |

Remarques : le builder à RCL1 ne fait que `WCM` (200) car la part suivante (W + 1 M = 150) dépasse 300 et l'algo s'arrête sans tenter une CARRY. Le harvester à 5W ne prend jamais de 3e CARRY : la part suivante voulue est WORK, limitée, donc stop.

### 3.6 Limite d'énergie et "quand ça spawne"
Tous les rôles éco utilisent `energyLimit = min(cap, max(X, energyAvailable))` (cap = `energyCapacityAvailable`).
Le corps est calculé avec `max(X, avail)` puis le spawn n'a lieu que si `coût ≤ avail` (§1.4). Donc :
- X = cap (harvester non forcé) : on attend que la room soit **pleine** (ou presque si le corps optimal coûte moins que cap).
- X = 0.9·cap (builder, upgrader, transporter normal, défense) : spawn dès que `avail ≥ coût(corps construit avec 0.9·cap)` ; si `avail` est plus grand, le corps grossit jusqu'à `cap`.
- X = 300 (harvester forcé) / 250 (transporter forcé) : spawn possible dès 300 / ~250 d'énergie, avec un corps qui grossit si plus d'énergie est disponible.

---

## 4. Harvester (spawn-role/harvester.ts)

Option : `{ priority, weight, source: Id<Source>, preferClosestSpawn: source.pos, size: maxWorkParts, force: boolean }`.

### 4.1 getSpawnOptions — :22-34 (cache vide 10 ticks)
```ts
if (room.isFullOnEnergy() && !isSmallHarvesterNeeded(room)) return []    // :25
options = []
for source of room.sources { addInitialHarvester(source, options); addAdditionalHarvesters(source, options) }
```
`isFullOnEnergy` (prototype/room.resources.ts:287-289) = `currentEnergy > storageLimit/2` où
`currentEnergy = storage.energy + terminal.energy + Σ énergie portée par les transporters (+ haulers si ni storage ni terminal)` (:162-193) et
`storageLimit = capacité storage + capacité terminal (sauf s'ils sont en vidage), ou 10 000 si aucun` (:109-125).
Sans storage : plein si > 5 000 d'énergie dans les transporters (quasi jamais). Avec storage RCL4 : > 500 000.

### 4.2 Harvester initial (remplacement) — addInitialHarvester :45-63
```ts
dist = min over spawns of the room: range(spawn, source)
active = source.harvesters.filter(c => c.spawning || c.ticksToLive > c.body.length * 3 + dist)   // :49
if (active.length > 0) return
if (!isSourceSafe(source)) return
force = isSmallHarvesterNeeded(room)
options.push({
  priority: force ? 6 : (isEarlyGame(room) ? 5 : 4),        // :56
  weight: (50 - dist) / 50,                                 // :57 — source la plus proche d'abord
  source: source.id, preferClosestSpawn: source.pos,
  size: getMaxWorkParts(source), force,
})
```
- `source.harvesters` = creeps de la room avec `role === 'harvester'` et `memory.fixedSource === source.id`, spawning inclus (manager.source.ts:24-45).
- Remplacement anticipé : un harvester qui a `ticksToLive ≤ 3·taille + distance spawn-source` ne compte plus → son remplaçant est demandé.
- `isEarlyGame` = pas de storage ni de terminal (:222-226).

### 4.3 isSmallHarvesterNeeded — :127-140
```ts
if (count(room.creepsByRole.harvester) > 0) return false   // n'importe quel harvester de la room, toutes sources
if (!room.storage) return true
if (room.getStoredEnergy() < 5000) return true
return false
```
Donc "force" = la room n'a plus AUCUN harvester (et pas de storage, ou storage < 5000).

### 4.4 Harvesters additionnels (RCL ≤ 3) — addAdditionalHarvesters :73-99
```ts
if (room.controller.level > 3) return                                  // dès RCL4 : 1 harvester par source
if (source.harvesters.length >= source.getNumHarvestSpots()) return    // pas plus que de cases libres
if (!isSourceSafe(source)) return
work = Σ getActiveBodyparts(WORK) des harvesters de cette source (y compris mourants)
maxParts = getMaxWorkParts(source)
if (work < maxParts) options.push({
  priority: isEarlyGame(room) ? 5 : 4,
  weight: 1 - (work / maxParts / 2) - ((50 - dist) / 100),             // :92
  source, preferClosestSpawn: source.pos, size: maxParts, force: false,
})
```
- `getNumHarvestSpots` (manager.source.ts:77-104) : cases adjacentes (8) de terrain plaine/marais sans structure non-walkable ; cache heap 5000 ticks. Pas de dépendance au planner.
- Le poids baisse quand la source est déjà bien couverte, et la proximité est ici **pénalisante** (−(50−d)/100) ; ex. d=10, work=2 : 1 − 0.2 − 0.4 = 0.4 (< 0.5 du transporter).
- Note : une option "initiale" et une "additionnelle" peuvent coexister pour la même source si aucun harvester n'est actif (work = 0 ou harvesters mourants).

### 4.5 Sécurité — isSourceSafe :101-115
Faux si une des 9 cases (source ± 1) a une valeur > 0 dans la "danger matrix" (utils/cost-matrix.ts:300-307). La danger matrix est vide si la room n'a pas d'ennemi (`getEnemyStrength() === NONE`) ou est en safe mode ; sinon flood-fill depuis les ennemis : case atteignable = 1, voisines = 2, bloqué par les cases planifiées `rampart`/`safe`/`wall` (dépend du planner, cost-matrix.ts:196-270).

### 4.6 getMaxWorkParts — :151-175
```ts
parts = source.energyCapacity / 300 / 2        // 3000 => 5 ; 1500 => 2.5 ; 4000 (SK) => 6.67
(+ PWR_REGEN_SOURCE : ignoré)
return sizeFactor * parts
sizeFactor = 1 sauf si CPU moyen (stat cpu_total sur 1000 ticks)/limite > 0.75 : RCL6 1.5, RCL7 1.8, RCL8 2   // RCL1-4 : toujours 1
```

### 4.7 Corps — getCreepBody :188-200
```ts
hasSpawnAtSource = un spawn opérationnel à range ≤ 2 de la source
hasFewExtensions = energyCapacityAvailable < 600         // RCL1 (300) et RCL2 (550)
BodyBuilder
  .weights({ WORK: 4, CARRY: 1 })
  .partLimit(WORK, option.size)                         // 5 pour une source 3000
  .moveMode(hasSpawnAtSource || hasFewExtensions ? MINIMAL : ROAD)
  .carryContentLevel(0)                                 // CARRY ne compte pas dans la fatigue
  .energyLimit(min(cap, max(option.force ? 300 : cap, energyAvailable)))
```
MINIMAL => exactement 1 MOVE. Corps typiques : §3.5.

### 4.8 Mémoire — :213-220
`{ role: 'harvester', singleRoom: room.name, fixedSource: source.id, operation: 'room:' + room.name }`.

### 4.9 Dépendances au room planner / comportement hors spawn (pour contexte)
- Le spawning harvester ne dépend du planner que via la danger matrix et `getStoredEnergy` (storage < 5000).
- Comportement (role/harvester.ts) : le harvester est "stationnaire" seulement s'il existe ≥ 1 transporter (:86-88) ; **s'il n'y a pas de transporter, il livre lui-même avec la logique transporter** (:315-325). Sa position fixe vient du planner `harvester.<sourceId>` (:98-103) ; sans planner, pas de position fixe. Il aide à construire le container de source si aucun builder n'a de place (:243-257) et donne son énergie aux transporter/upgrader/builder adjacents tant que RCL < 6 (:296-309).

---

## 5. Transporter (spawn-role/transporter.ts)

Option : `{ priority, weight, force: boolean, size: number }`.

### 5.1 getSpawnOptions — :20-68 (cache vide 10 ticks)
```ts
size = getTransporterSize(room)
max  = getTransporterAmount(room, size)
count = count(room.creepsByRole.transporter)          // tous, y compris mourants : PAS de remplacement anticipé
if (count < max) {
  option = { priority: (storage || terminal) ? 6 : 5, weight: 0.5, force: false, size }
  hasHaulers    = haulers / hauler.relay avec memory.sourceRoom === room (remote) > 0
  hasExtensions = room a ≥ 1 extension
  hasBuilders   = count(builder) + count(upgrader) + count(builder.remote) > 0
  if (count >= max / 2)              { option.priority -= 2 }                         // :41-44
  else if (count >= 1)               { option.priority -= 1; option.weight = 0 }      // :45-48
  else if (storage || terminal || (!hasHaulers && hasExtensions)) { option.force = true; option.weight = 1 }   // :49-52
  else if (!storage && !terminal && !hasBuilders) {                                   // :53-61
    d = min over spawns, sources : range(spawn, source)
    if (d < 5) { option.priority -= 1; option.weight = 0 }
  }
  options.push(option)
}
```
Avec `max = 3` (cas standard RCL1-4) : count 0 → règles "0 transporter" ; count 1 → priorité −1, poids 0 ; count 2 → priorité −2, poids 0.5.

### 5.2 Nombre — getTransporterAmount :81-109
```ts
m = baseAmount(room) * 2 / 3
m /= size                                     // size = 12 en RCL1-6
m = max(m, rcl > 6 ? 2 : 3)                   // => 3 en RCL1-4 dans tous les cas réalistes
if (terminal en vidage && terminal utilisé > 1 %) m *= 1.5
if (storage en vidage && storage utilisé > 1 %)  m *= 1.5
if (rcl < 4) for source: c = container de source ; if (c && c.freeCapacity < c.capacity / 4) m++   // container > 75 % plein
m += extraUpgraderTransporters(room)
return m                                       // peut être fractionnaire ; comparé par count < m
```
baseAmount (:120-145) : RCL < 3 → 1 ; RCL 3 → 2 ; RCL ≥ 4 sans storage ni terminal → `effectiveEnergy > 1000 ? 2 : 1` ; avec storage → `2 + 2·nbSources` − (si controllerLink : 1 + nb sources avec link) +1 en RCL5 et RCL6, − nb `builder.remote`. (En RCL1-4 ce terme est écrasé par le max(…, 3).)

extraUpgraderTransporters (:147-167) :
```ts
work = Σ WORK actifs des upgraders
pathLen = (cache heap 5000 ticks) longueur du chemin storageLocation -> controller container ; 1 si pas de container, pas de storageLocation, ou chemin incomplet
return floor(work * 1 * pathLen * 1.8 / 50 / size)
```
`storageLocation` = centre du room planner s'il existe, sinon `storage.pos`, sinon null (prototype/room.resources.ts:333-338).
`getNearbyContainer` (manager.source.ts:122-149) : container à range ≤ 5 de la source ; avec planner il doit être sur une position planifiée `container.source` ; cache heap 150 ticks.

### 5.3 Taille — getTransporterSize :178-182
`ceil((max(300, EXT_CAP[rcl]) + 6 * EXT_CAP[rcl]) / 50)` → RCL1-6 : `ceil(600/50) = 12` CARRY ; RCL7 18 ; RCL8 30.

### 5.4 Corps — :211-218
```ts
BodyBuilder.weights({ CARRY: 1 }).partLimit(CARRY, option.size ?? 8).moveMode(ROAD)
  .energyLimit(min(cap, max(option.force ? 250 : cap * 0.9, energyAvailable)))
```
ROAD avec carryContentLevel 1 → 1 MOVE pour 2 CARRY. Forcé à 300/250 d'énergie : `CMCCM` (3C2M = 250).

### 5.5 Mémoire — :231-236
`{ singleRoom: room.name, operation: 'room:' + room.name }` (+ `role: 'transporter'` ajouté par le manager).

---

## 6. Builder (spawn-role/builder.ts)

Option : `{ priority, weight, size }`.

### 6.1 getSpawnOptions — :19-41 (cache vide **50** ticks)
```ts
maxWork = getNeededWorkParts(room)
work = Σ WORK actifs des creeps role 'builder' de la room (mourants inclus : PAS de remplacement anticipé)
if (work >= maxWork) return []
E = room.getEffectiveAvailableEnergy()
needsStrongerRamparts = terminal && lowestPlannedRampartHits < 3_000_000 && E > 10_000
needsBuildings = room.find(FIND_MY_CONSTRUCTION_SITES).length > 0
return [{ priority: (needsStrongerRamparts || needsBuildings) ? 4 : 3, weight: 0.5, size: room.isEvacuating() ? 3 : null }]
```
Une seule option à la fois → un builder par cycle de spawn (le suivant après recalcul).

### 6.2 getNeededWorkParts — :52-129 (ordre exact des tests)
```ts
sites = nb FIND_MY_CONSTRUCTION_SITES
hasStorage = storage || terminal
if (sites === 0 && memory.noBuilderNeeded && Game.time - memory.noBuilderNeeded < 1500 && hasStorage) return 0   // :57
E = getEffectiveAvailableEnergy()
if (hasStorage && E < 5000) return 0                       // :62 attendre que l'éco démarre
if (!room.roomPlanner?.hasRoomPlan()) return 0             // :67 SANS PLAN : AUCUN BUILDER
if (room.isEvacuating()) return 1                          // :72
if (hasStorage && E < 10_000) return 1                     // :77
if (E < 10_000 && count(harvester) <= 1) {                 // :83
  active = count(harvester) + count(harvester.remote avec sourceRoom === room)
  if (active < nbSources) return 1                         // :87 peu de revenu : un seul petit builder
}
m = 5
if (rcl > 2) m += 5                                        // :91 => 10 dès RCL3
if (roomPlanner && rcl >= 4) m += nbRampartsPlanifiés / 10 // :97
if (!hasStorage) m *= 1 + E / 3000                         // :102-106
else if (E > 400_000) m *= 2
else if (E > 200_000) m *= 1.5
if (isMovingMisplacedSpawn) m *= 2                         // :115
if (terminal && lowestRampart < 3M && E > 10_000) m *= 2.5 // :121
if (rcl > 3) m += sites / 2                                // :125
return m
```
`noBuilderNeeded` est posé par le rôle builder quand il n'a rien à faire (hors périmètre spawn).

### 6.3 Énergie "disponible" utilisée partout — getStoredEnergy (prototype/room.resources.ts:201-236) / getEffectiveAvailableEnergy (:263-270)
```ts
total = storage.energy + terminal.energy + énergie portée par les transporters (+ haulers si pas de storage/terminal)
loc = storageLocation (centre du planner, sinon storage.pos, sinon null)
if (!loc) return total                                      // SANS PLANNER NI STORAGE : seulement l'énergie des transporters
total += énergie au sol sur loc
for pos of planner.getLocations('harvester'): total += énergie au sol + énergie des containers sur pos
total += énergie du controller container (memory.controllerContainer)
effective = total (+ batteries via factory : hors périmètre)
```
Cache 1 tick.

### 6.4 Corps — :163-170
```ts
BodyBuilder.weights({ WORK: 4, CARRY: 3 }).moveMode(ROAD).partLimit(WORK, option.size /* null => aucune limite */)
  .energyLimit(min(cap, max(cap * 0.9, energyAvailable)))
```
### 6.5 Mémoire — :183-189
`{ role: 'builder', singleRoom: room.name, operation: 'room:' + room.name }`.
Boosts seulement si ennemis > NORMAL (hors périmètre).

---

## 7. Upgrader (spawn-role/upgrader.ts)

Option : `{ priority, weight, mini?: boolean }`.

### 7.1 getSpawnOptions — :21-46 (cache vide **100** ticks)
```ts
max = getUpgraderAmount(room)
count = upgraders de la room avec (!ticksToLive /*spawning*/ || ticksToLive > body.length * 3)   // remplacement anticipé de 3 ticks/part
priority = isCloseToDowngrade(room) ? 5 : 3
if (count < max) options.push({ priority, weight: 1 })
if (max === 0 && count === 0 && controller.progress > controller.progressTotal)
  options.push({ priority, weight: 1, mini: true })     // :35-42 relancer le ticksToDowngrade pour permettre le level-up
```

### 7.2 Nombre — getUpgraderAmount :57-73 / getBaseUpgraderAmount :88-127
```ts
base = baseAmount(room)
if (base === 0) {
  if (ticksToDowngrade < CONTROLLER_DOWNGRADE[rcl] * 0.1) return 1                      // isCloseToDowngrade :75-77
  if (ticksToDowngrade < CONTROLLER_DOWNGRADE[rcl] * 0.5 && effectiveEnergy > 5000) return 1
}
return base

baseAmount(room):
  if (!storage && !terminal) return 0          // :91 — RCL1-3 (et RCL4 avant storage) : PAS d'upgrader dédié, les builders upgradent
  if (evacuating) return 0; if (movingMisplacedSpawn) return 0; if (rcl >= 6 && stripmine) return 0
  E = effectiveEnergy - reserve(rcl)           // reserve : RCL8 100k, RCL7 50k, RCL6 25k, RCL5 10k, sinon 0 (:129-136)
  (funnel / RCL8 : hors périmètre)
  if (E < 10_000) return 0                     // RCL7 : 25 000
  if (E < 50_000) return 1                     // RCL7 : 75 000
  if (E < 100_000 && bucket > 5000) return 2
  if (E < 125_000 && bucket > 6000 && funnelingToRoom) return 3
  if (E < 150_000 && bucket > 7000) return funnelTo ? 4 : 3
  if (E < 200_000 && bucket > 8000) return funnelTo ? 5 : 4
  if (E < 250_000 && bucket > 9000) return funnelTo ? 6 : 5
  return funnelTo ? 7 : 6
```
Seuils de downgrade RCL1-4 : 10 % = 2000 / 1000 / 2000 / 4000 ticks ; 50 % = 10000 / 5000 / 10000 / 20000.

### 7.3 Corps — :149-159
```ts
easy = memory.controllerContainer || memory.controllerLink
BodyBuilder.weights({ CARRY: 1, WORK: easy ? 10 : 1 })      // CARRY en premier dans l'ordre des clés
  .partLimit(WORK, option.mini ? 2 : (rcl === 8 ? 15 : 50))
  .moveMode(easy ? SLOW : ROAD)
  .carryContentLevel(0)
  .energyLimit(min(cap, max(cap * 0.9, energyAvailable)))
```
`memory.controllerContainer` (prototype/room.intel.ts:261-285) : container sur une position planifiée `container.controller` si le planner en a, sinon n'importe quel container à range ≤ 3 du controller.

### 7.4 Mémoire — :172-177
`{ singleRoom: room.name, operation: 'room:' + room.name }` (+ role 'upgrader').

---

## 8. Room defense, version simple (spawn-role/room-defense.ts)

getSpawnOptions :27-36 (cache vide 10 ticks) : `addLowLevelRoomSpawnOptions`, `addRampartDefenderSpawnOptions`, `addEmergencyRepairSpawnOptions`.

### 8.1 RCL < 4 : brawlers — :46-58
```ts
if (rcl >= 4) return
if ((controller.safeMode || 0) > 500) return
if (!memory.enemies || memory.enemies.safe) return
if (count(room.creepsByRole.brawler) >= 2) return
options.push({ priority: 5, weight: 1, creepRole: 'brawler' })
```
`memory.enemies.safe === false` dès qu'un creep hostile non allié "dangereux" est présent (toute part autre que MOVE/TOUGH, et dans sa propre room même WORK/CARRY comptent) ou un invader core actif (process/rooms/intel.ts:51-119 ; creep.military.ts:32-46). Recalcul chaque tick si bucket > 8000, sinon cache 10 ticks.

### 8.2 RCL ≥ 4 : guardians — :68-85
```ts
if (rcl < 4) return
if (!(enemyStrength >= NORMAL) && !(safeMode && safeMode < 300)) return
responseType = getDefenseCreepSize(room)    // NORMAL+ : RANGED si ranged < floor(total/4), sinon ATTACK ; sinon NONE
if (responseType === NONE) return
if (count(guardian) >= 5) return
options.push({ priority: 5, weight: 1, responseType, creepRole: 'guardian' })
```
### 8.3 RCL ≥ 4 : builders d'urgence — :103-122
Si ennemis non safe, `effectiveEnergy ≥ 10_000`, responseType ≠ NONE (force ≥ NORMAL), builders < 5 : `{ priority: 4, weight: 1, responseType, creepRole: 'builder' }`.

Force ennemie (room-defense.ts:186-212, cache 5 ticks) : `NONE` si aucune attaque ; `WEAK` si invaders uniquement ou (heal < towerStrength et attaque < mur_min/1000) ; `NORMAL` si heal < tower + défense et attaque > mur_min/3000 ; ... avec `towerStrength = 600 * nbTours / 2`, `défense = 2 * 30 * min(25, floor(cap/130))`. → **Les invaders NPC ne déclenchent jamais guardians ni builders d'urgence** (WEAK), seulement les brawlers en RCL < 4.

### 8.4 Corps — :152-193
- brawler / guardian ATTACK : `weights({ATTACK:1}).moveBufferRatio(0.8).moveMode(ROAD /* setting constructRoadsUnderRamparts = true, settings.default.ts:148 */).energyLimit(min(cap, max(0.9·cap, avail)))`.
- guardian RANGED : idem avec `RANGED_ATTACK`.
- builder d'urgence : `weights({WORK:1, CARRY:1}).moveMode(ROAD).energyLimit(idem)`.
Mémoire : `{ singleRoom: room.name, role: option.creepRole }`.

---

## 9. Autres rôles actifs en RCL1-4 (mention brève)
- **Scout** (spawn-role/scout.ts:39-62, cache vide 50) : si `room.needsScout()`, scouts de cette origine < `ceil(maxScoutsPerRoom(1) * bucket / 10000)`, et pas de scout spawné depuis < 500 ticks (`CREEP_LIFE_TIME/3`). Priorité 4 / poids 1 si early game (1 seule room, pas de storage/terminal), sinon 1 / 0. Corps `[MOVE]`.
- reclaim (exige effectiveEnergy ≥ 10 000 et bucket ≥ 8000), remote-mine, dismantler (flags / planner), mule, helper, squads, power, deposits, minerals (RCL6) : hors périmètre.

---

## 10. Comportement selon l'équipement de la room

### Sans transporter
- Harvesters livrent eux-mêmes (logique transporter) et ne sont pas stationnaires.
- Transporter demandé à priorité 5 (6 avec storage). Forcé (corps dès 250 d'énergie, poids 1) si storage/terminal, ou si la room a des extensions et aucun hauler remote. Sans extension (RCL1) : non forcé, priorité 5/0.5, ou 4/0 si aucun builder/upgrader et spawn à < 5 cases d'une source.
- Creep de récupération 2×(CC M) si le moteur refuse un spawn faute d'énergie utilisable.

### Sans storage (RCL1-3, RCL4 avant construction)
- Harvesters "early game" en priorité 5 (6 si aucun harvester), plusieurs par source jusqu'à 5 WORK et dans la limite des cases libres.
- Upgraders : 0 sauf downgrade (< 10 % → prio 5 ; < 50 % et énergie > 5000 → prio 3) ou mini-upgrader (progress > progressTotal).
- Builders : `(5 | 10) * (1 + E/3000)` WORK, ou 1 si revenu faible ; l'énergie E compte celle au sol au centre planifié, sur les positions de récolte planifiées et dans le controller container.
- Transporters : 3 (+1 par container de source > 75 % plein en RCL < 4).

### Sans containers
- `getNearbyContainer` null : pas de bonus transporter ; les harvesters aident à construire le container de source.
- Upgrader sans `controllerContainer` : poids WORK 1 / CARRY 1, mode ROAD.

### Sans room plan
- `hasRoomPlan()` faux → **builders : 0** (builder.ts:67). En pratique Hivemind ne spawne alors que harvesters, transporters, (upgraders de secours), défense, scouts.
- `room.roomPlanner` absent tant que la segment memory n'est pas prête (process/init.ts:73-77) → pas de directions de spawn, pas d'ordre d'energyStructures, pas de `bays`, `getStoredEnergy` = énergie des transporters (+ storage), positions de récolte inconnues, danger matrix non bornée par les ramparts.
- Cas dépendant du planner : spawn directions (routes planifiées), energyStructures (bays), comptage énergie (centre, positions `harvester`), container de source (`container.source`), controller container (`container.controller`), ramparts planifiés (builders RCL ≥ 4, force ennemie), position fixe du harvester (`harvester.<id>`).

---

## 11. Déroulé type d'une room neuve (1 spawn, 2 sources à d1 < d2, RCL1, pas de plan)
1. Tick 0, 300 énergie : harvester source1 forcé (prio 6, poids (50−d1)/50) → `WCWM` (300).
2. Ensuite : harvester initial source2 (prio 5, poids (50−d2)/50 ≈ 0.6-0.9) bat le transporter (5/0.5 ou 4/0) et les additionnels (≈ 0.3-0.5) → attend 300 (limite = cap) → `WCWM`.
3. Puis transporter (5/0.5) vs additionnels (5, `1 − 2/10 − (50−d)/100`, < 0.5 si d < 20) → transporter `CCMCCM` à 300 (corps construit dès 270 → `CMCCM` 250 si l'énergie est entre 250 et 299).
4. Puis harvesters additionnels jusqu'à 5 WORK / cases libres par source, transporter n°2 (count 1 : prio 4, poids 0) et n°3 (count 2 ≥ 3/2 : prio 3, poids 0.5), en concurrence avec les builders (prio 4 si chantiers) quand un plan existe.
5. RCL2 (550) : les harvesters restent en MINIMAL (`WCWWWM`, 4W) ; RCL3 (800) : ROAD `5W2C3M` (750) sauf spawn à ≤ 2 de la source ; dès RCL4 plus d'additionnels.
