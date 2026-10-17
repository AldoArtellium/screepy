# Hivemind — spécification de portage : MINAGE DISTANT (RCL 1-4, une room possédée)

Source : `C:\Users\ruffa\AppData\Local\Temp\bots\hivemind\src` (MIT). Toutes les références `fichier:ligne` sont relatives à `src/`.
Périmètre : sélection des remotes, scoutage requis, chemins, opération `mine:<room>`, spawn-role `remote-mine`, rôles `harvester.remote` (HR), `hauler.relay` (TRR), `claimer` (C, mission `reserve`), `builder.mines` (BM), `scout` (S), défense des remotes (brawler), interactions avec l'économie locale. SK, power, deposits, intershard, squads : ignorés (mention brève).

Conventions (identiques aux autres docs `docs/hivemind/`) : `getBestOption` garde la **priorité la plus haute**, puis le poids le plus haut ; à égalité la première option collectée (ordre d'enregistrement des spawn-roles : `brawler, builder, dismantler, harvester, …, remote-mine, room-defense, scout, squad, transporter, upgrader`). `whenInRange(r, t, cb)` = `requestMove(range r)` à chaque tick + callback à portée (cf. `hivemind-roles.md` §0.2). BodyBuilder : algorithme exact de `hivemind-spawning.md` §3 (= notre `src/core/bodyBuilder.ts`).

Constantes Screeps utilisées : `SOURCE_ENERGY_CAPACITY=3000` (réservée/possédée), `SOURCE_ENERGY_NEUTRAL_CAPACITY=1500`, `ENERGY_REGEN_TIME=300`, `HARVEST_POWER=2`, `BUILD_POWER=5`, `REPAIR_POWER=100`, `CARRY_CAPACITY=50`, `CONTAINER_CAPACITY=2000`, `CONTAINER_HITS=250000`, `ROAD_HITS=5000`, `CONSTRUCTION_COST={container:5000, road:300}`, `CONTROLLER_RESERVE_MAX=5000`, `CREEP_CLAIM_LIFE_TIME=600`, `CREEP_SPAWN_TIME=3`, `BODYPART_COST={claim:600, move:50, …}`, `MAX_CONSTRUCTION_SITES=100`.

---

## 0. Vue d'ensemble

```
Scout (spawn prio 4 early game) ─► intel des rooms voisines (sources, contrôleur, réservation, routes, sorties)
ScoutProcess (/25 ticks) ─► roomList[room] = {origin, range, scoutPriority, harvestPriority = 3000 / pathLength}
RemoteMiningProcess (/20 ticks si 1 room) ─► Memory.strategy.remoteHarvesting.rooms (≤ 5 rooms par spawn) ─► opérations 'mine:<room>'
RemoteMiningOperation ─► par source : chemin source→storage planifié (caché 5000 ticks), travelTime, WORK/CARRY requis, container, danger
spawn-role remote-mine (dans le SpawnManager normal) ─► 1 seule option à la fois : hauler (3) > builder (3, storage requis) > harvester (1 puis 3) > claimer (3)
harvester.remote : va à la source par le chemin caché, pose + construit le container, récolte dedans, le répare
hauler.relay : pool par room d'origine ; choisit la source la plus rentable, vide le container, rentre :
               sans storage → dispatcher de destinations local (spawn/extensions/tour/workers/drop au centre) ; avec storage → storage
claimer (reserve) : réserve (ou attaque la réservation ennemie)
builder.mines (seulement avec storage et ≥ 5000 d'énergie) : routes + container sur le chemin
brawler (spawn-role brawler) : défense d'un remote attaqué (≥ 5000 d'énergie) ou à invader core
```

Résultat observé (mockup, W7N3, 8000 ticks) : 7 HR, 12 TRR, 9 C dans 3 rooms voisines, actif dès RCL2.

---

## 1. Activation et cadence

| Process | Fichier:ligne | Intervalle | Condition |
|---|---|---|---|
| `strategy.scout` (`ScoutProcess`) | `main.ts:143-147` | `scoutProcessInterval = 25` (`settings.default.ts:100`), priorité LOW, requiert les segments | toujours |
| `strategy.remote_mining` (`RemoteMiningProcess`) | `main.ts:162-164` | `_.size(Game.myRooms) === 1 ? 20 : 100` | `shardHasRooms` (≥ 1 room possédée) — **aucune condition de RCL ni de storage** |
| `rooms_intel` (`RoomIntelProcess`) | `process/rooms.ts:30-35` | chaque tick, pour **chaque room visible** (possédée ou non) | segments prêts |
| spawn-role `remote-mine` | `spawn-role/remote-mining.ts:64-102` | à chaque tick de spawn (cache « options vides » 10 ticks, :65) | via le SpawnManager |

`hasIntervalPassed(interval, start)` : `Game.time - start >= interval` (`hivemind.ts:327-337`, throttle CPU ignoré ici).

Réglages (`settings.default.ts`) : `maxRemoteMineRoomDistance: 3` (:47), `maxRemoteMinePathLength: 150` (:50), `remoteMineRoomFilter: null` (:53), `scoutProcessInterval: 25` (:100), `maxRoomPrioritizationCpuPerTick: 50` (:102), `maxScoutsPerRoom: 1` (:103), `scoutSpawnPriority: 1` (:104), `roomScoutInterval: 5000` (:105), `roomIntelCacheDuration: 500` (:107). `Memory.hivemind.maxScoutDistance` défaut 7 (ajusté selon la mémoire utilisée, `main.ts:290-301`).

---

## 2. Scoutage et intel requis

### 2.1 Liste des rooms connues — `process/strategy/scout.ts:443-492` (`generateScoutTargets`)
Flood fill depuis les rooms possédées (`getScoutOrigins` :500-510, `range 0, origin = room`) :
```ts
open = { [myRoom]: {range: 0, origin: myRoom, safePath: true} }
while open non vide:
  next = room de open avec le plus petit range                       // :555-566
  addAdjacentRooms(next):                                            // :578-608
    if (range >= maxScoutDistance (7)) stop
    for exit of intel(next).getExits():                              // exits = memory.exits (rempli à la visite, room-intel.ts:501-508) → une room jamais vue n'étend pas le flood
      open[exit] = {range: range+1, origin, safePath: safePath && (!isClaimed(exit) || réservée par 'Invader')}
  scoutTargets[next] = info (si absent, ou range plus court, ou origine non possédée)
roomStatus : setOrigin/setDistanceToOrigin pour les rooms encore dans le rayon, deleteRoom sinon, addRoom pour les nouvelles (:474-491)
```
⇒ La liste s'étend **anneau par anneau à mesure que les rooms sont visitées** (les sorties d'une room ne sont connues qu'après une visite). `range` = distance en nombre de rooms via les sorties.

Mémoire : `Memory.strategy.roomList[room] = {origin, range, scoutPriority?, harvestPriority?, expansionScore?, safePath?}` (`room/room-status.ts:9-17`).

### 2.2 Priorités par room — `process/strategy/scout.ts:76-178`
Chaque run (/25 ticks) traite les rooms non encore traitées du cycle (`Memory.strategy.roomListProgress`), budget 50 CPU (:91-112) ; à la fin du cycle la liste est vidée.
```ts
calculateRoomPriorities(room):                                       // :121-178
  resetScores(room)                                                  // efface scout/harvest/expansion
  range = getDistanceToOrigin(room)
  if (range > 0 && range <= 7):
    if (intel.getAge() > roomScoutInterval (5000)) scoutPriority = 1  // getAge = Game.time - lastScan (jamais vue : 100000+)
    if (intel.lastScan > 0) harvestPriority = calculateHarvestScore(room)
  // highways / observers : hors périmètre (pas d'observer RCL ≤ 4)

calculateHarvestScore(room):                                         // :189-211
  if (range === 0 || range > maxRemoteMineRoomDistance (3)) return 0
  if (getRoomStatus(room).status === 'closed') return 0
  sources = intel.getSourcePositions(); if (sources.length === 0) return 0
  pathLength = 500
  for s of sources: path = pathManager.getPathFor(pos(s)); if (path) pathLength = min(pathLength, path.length)
  return SOURCE_ENERGY_CAPACITY / pathLength                          // 3000 / plus court chemin
```
Quirk : si aucune source n'a de chemin, `pathLength` reste 500 ⇒ score **6** (> 0.1) : la room peut quand même être sélectionnée (puis inutilisable car `accessible: false`). À corriger au portage (score 0).

### 2.3 Spawn du scout — `spawn-role/scout.ts:39-62`
```ts
cacheEmptySpawnOptionsFor(room, 50, …)
scoutSpawnThrottle = CREEP_LIFE_TIME / 3 = 500                       // :22
if (room.memory.recentScout && Game.time - recentScout < 500) return []   // :47
maxScouts = ceil(maxScoutsPerRoom (1) * bucket / 10000)              // :50 → 1 avec bucket plein
if (scouts dont memory.origin === room.name >= maxScouts || !room.needsScout()) return []
isEarlyGame = Game.myRooms.length === 1 && !room.storage && !room.terminal   // :53
option = { priority: isEarlyGame ? 4 : 1, weight: isEarlyGame ? 1 : 0 }       // :55-58
corps = [MOVE]                                                       // :105-107
mémoire = { role: 'scout', origin: room.name, disableNotifications: true }    // :120-125
onSpawn : room.memory.recentScout = Game.time                        // :146-150
needsScout() = roomStatus.getPotentialScoutTargets().some(r => origin(r) === room.name)   // prototype/room.intel.ts:348-352
getPotentialScoutTargets = rooms avec scoutPriority > 0, cache heap 1000 ticks           // room/room-status.ts:82-86
```
En RCL1-3 (pas de storage) : prio 4 poids 1 → passe devant un builder (4, 0.5) et un transporter « ≥ 1 existant » (4, 0) ; derrière harvesters (5-6) et premier transporter (5).

### 2.4 Rôle scout — `role/scout.ts`
```ts
run:                                                                  // :58-70
  notifyWhenAttacked(false) une fois
  if (!scoutTarget) chooseScoutTarget()
  performScout()
performScout:                                                         // :78-117
  pas de cible → attendre à portée 3 de (25,25) de la room courante
  si oscillation (même alternance de 2 rooms sur 10 entrées d'historique, ou même tuile ≥ 5 fois sur 30) ou bloqué (> 10 ticks même tuile) → chooseScoutTarget(invalidate = true)
  interRoomTravel((25,25,scoutTarget)) ; arrivé → chooseScoutTarget()
chooseScoutTarget:                                                    // :128-162
  pause en cours (pauseUntil) → rester sur place
  invalidate → ajouter l'ancienne cible à memory.invalidScoutTargets
  candidats = rooms scoutPriority > 0, d'origine = creep.memory.origin (si le scout est dans sa room d'origine) sinon à ≤ 5 rooms (navmesh) de la position ;
              hors room courante, hors invalidScoutTargets, distance navmesh ≤ 5                       // :197-213
  tri : -scoutPriority, puis (lastScoutAttempt + range * 50)                                         // :164-173
  premier candidat avec un chemin navmesh complet (cache 5000 ticks) ; sinon invalidé ; budget 10 CPU  // :175-194
  cible choisie → intel.registerScoutAttempt() (lastScout = Game.time)
  aucune → pauseUntil = Game.time + 50
```
⇒ Les rooms jamais vues sont visitées dans l'ordre croissant de `range` (lastScout = -100000 pour toutes).

### 2.5 Intel collecté à la visite — `room-intel.ts:133-181` (via `RoomIntelProcess`, chaque tick pour toute room visible)
Rafraîchi au plus toutes les `roomIntelCacheDuration = 500` ticks (×5 si bucket < 5000) (:141-146). Stocké en segment `intel:<room>` (notre port : `Memory.intel`).

| Donnée | Fichier:ligne | Utilisée par |
|---|---|---|
| `lastScan`, `lastScout` | :148, :1092-1104 | harvest score (`lastScan > 0`), tri scout |
| `owner`, `rcl` (invader core de niveau > 0 sans contrôleur → owner `Invader`) | :189-208 | `isOwned()` (:683-688) → room **interdite au chemin** |
| `reservation {username, ticksToEnd}` ; `getReservationStatus()` décompte l'âge (:665-675) | :210-213 | spawn harvester/claimer, `hasReservation` hors vision |
| `hasController` → `isClaimable()` (:637-641) ; `isSourceKeeperRoom()` = pas de contrôleur et des sources (:658-660) | :193 | claimer, SK |
| `sources [{x, y, id, free}]`, `free = getNumHarvestSpots()` (cases non-mur autour) | :224-232 | chemins, nb max de harvesters par source |
| `exits` (`Game.map.describeExits`, mêmes statuts) | :501-508 | flood fill §2.1 |
| `structures[controller]`, `structures[keeperLair]` (seulement à la 1re visite) | :160-164 | `getControllerPosition()` (:837-848), SK |
| `costPositions = [obstacles, roads, endangered]` | :550-557 | routes existantes (coût 1 dans les chemins remote), détection d'obstacles (dismantler) |
| `invaderInfo {level, active, activates, collapses}` | :520-540 | info |
| `getControllerReservePositionCount()` = cases autour du contrôleur ni mur ni obstacle (cache heap 1500) | :850-869 | nombre de claimers, taille mini |

---

## 3. Sélection des rooms — `process/strategy/mining.ts`, `empire/remote-mine-prioritizer.ts`

### 3.1 Process — `process/strategy/mining.ts:48-122`
```ts
constructor: Memory.strategy.remoteHarvesting ??= {currentCount: 20, lastCheck: Game.time, rooms: []}   // :35-41
run():
  {rooms, maxRooms} = prioritizer.getRoomsToMine(currentCount)       // :50
  Memory.strategy.remoteHarvesting.rooms = rooms
  adjustRemoteMiningCount(maxRooms)                                  // :65-100, toutes les 1000 ticks
    if (Game.myRooms.length === 1 && Game.cpu.limit >= 20) { currentCount = 20; return }   // :72-77 : early game = autant que possible
    (sinon : ±1 selon bucket/CPU, plafonné à maxRooms + 3 — hors périmètre)
  manageOperations():                                                // :105-122
    pour chaque room sélectionnée sans opération : new RemoteMiningOperation('mine:' + room).setRoom(room)
    pour chaque opération 'mining' dont la room n'est plus sélectionnée : op.terminate()  (supprimée de Memory.operations au tick suivant, process/init.ts:38-42)
```

### 3.2 Prioritizer — `empire/remote-mine-prioritizer.ts`
```ts
getRemoteMiningSourceRooms():                                        // :72-118
  pour chaque room possédée :
    spawnCount = spawns opérationnels (0 → 1 si RCL 4-6, sinon room ignorée)
    spawnCapacity = spawnCount * 5
    roomNeeds = (RCL >= 4 ? 1 : 0) + (RCL >= 6 ? 1 : 0) + squads spawnés ici
    max = floor(spawnCapacity - roomNeeds)        // 1 spawn : 5 remotes en RCL1-3, 4 en RCL4-5
getRemoteHarvestRooms():                                             // :120-140
  pour chaque room connue (roomList) non possédée :
    harvestPriority = roomStatus.getHarvestPriority(room); if (<= 0.1) skip
    origin = roomStatus.getOrigin(room); if (!sourceRooms[origin]) skip
getRoomsToMine(maxAmount = currentCount = 20):                       // :21-70
  tri par -harvestPriority * (origin a un terminal ? 1 : 1.5)        // :28-34 (facteur constant pour une room)
  for info of tri:
    if (sourceRooms[origin].current >= max) continue
    if (SK room avec lairs et RCL origine < 7) continue               // :42-50
    sourceRooms[origin].current++
    if (count < maxAmount && (filter absent || filter(room))) result.push(room)
    count++
```
⇒ Une room, un spawn : les **5 meilleures rooms (4 en RCL4)** à ≤ 3 rooms de distance, triées par 3000 / longueur du plus court chemin source→storage planifié. Pas de seuil de RCL, de storage ni de rentabilité.

---

## 4. Chemins — `empire/remote-path-manager.ts`

```ts
getPathFor(sourcePos): RoomPosition[] | null                         // :18-66
  mémoire segment 'remotePath:' + encodePosition(sourcePos) = {generated, path (packé)}
  if (generated && Game.time - generated < 5000) return path ?? null  // :27-31 : résultat (même null) caché 5000 ticks
  candidats = rooms possédées à distance linéaire ≤ 3, triées par distance   // :33-34
  minPathLength = 150 + 50 = 200                                      // :37
  for room of candidats:
    if (minPathLength < 150 && distLinéaire > ceil(minPathLength / 50)) continue   // :40-41
    if (!room.roomPlanner) continue
    storagePos = roomPlanner.getLocations('storage')[0]; if (!storagePos) continue  // :44-45 : position PLANIFIÉE du storage, même non construit
    result = PathFinder.search(sourcePos, {pos: storagePos, range: 1}, {
      plainCost: 2, swampCost: (room.storage || room.terminal) ? 3 : 10,
      maxOps: 10000, heuristicWeight: 1,
      roomCallback: r => getRemotePathCostMatrix(r, r === sourcePos.roomName) })   // :47-53
    if (incomplete || length >= minPathLength) continue               // :55
    minPath = result.path; minPathLength = length
  memory.generated = Game.time; memory.path = minPath ? pack(minPath) : null   // :62-63

getRemotePathCostMatrix(roomName, isTargetRoom)                      // :68-114, cache heap 1000 ticks
  if (intel.isOwned()) return false                                   // :73 : jamais à travers une room possédée par un autre (ni core invader actif)
  matrix = room possédée ? roomPlanner.getNavigationMatrix().clone() : new CostMatrix()   // :76-77
           // navigation matrix (room/planner/room-plan.ts:148-180) : routes planifiées = 1, harvester/bay_center/murs/obstacles planifiés = 255
  pour chaque route connue (intel costPositions[1]) : si matrix = 0 → 1   // :82-85
  SK (lairs, room non cible) : 255 à portée 4 des sources/minéraux    // :87-110
```
- `path[0]` = case adjacente à la source = **position du container** (`operation/remote-mining.ts:409-414`) ; `path[last]` = case à portée 1 du storage planifié, dans la room d'origine ⇒ `sourceRoom = path[last].roomName` (:148).
- Longueur max effective : **< 200 cases** (et non 150 comme le commentaire du réglage).
- Les obstacles des rooms distantes ne sont pas dans la matrice : un chemin peut traverser un mur construit → détecté par `needsDismantler` (§5.6).
- Nettoyage : entrées `remotePath:` non régénérées depuis 10000 ticks supprimées (`main.ts:396-398`).
- **Piège de dépendance** : si le planner n'a pas encore de position `storage` quand le scout process calcule le score (§2.2), `null` est caché **5000 ticks**. Hivemind planifie dans les premiers ticks, avant la 1re visite de scout ; notre port doit exiger le plan avant de calculer (ou ne pas cacher un échec).

---

## 5. Opération `mine:<room>` — `operation/remote-mining.ts`

Mémoire : `Memory.operations['mine:' + room] = {type: 'mining', roomName, lastActive, status: {[sourceLocation]: {containerId?}}, stats, statTicks, …}` (:17-24, `operation/operation.ts:47-60`). `sourceLocation = encodePosition(source.pos)`. Un creep appartient à l'opération via `memory.operation` (`prototype/creep.ts:67-80` : `creep.operation = Game.operations[memory.operation]`).

### 5.1 Chemins et besoins par source — `getPaths()` :119-184 (cache par tick ; info par source en heap 100 ticks, :140)
```ts
pour chaque source (intel.getSourcePositions()) :
  path = pathManager.getPathFor(sourcePos)
  if (!path) → {accessible: false}
  sourceRoom = path[last].roomName
  travelTime = path.length
  generatedEnergy = SK ? 4000 : (canReserveFrom(sourceRoom) ? 3000 : 1500)          // :150-152
  requiredWorkParts  = generatedEnergy / 300 / 2                                     // :153 → 2.5 (neutre) ou 5 (réservable)
  requiredCarryParts = ceil(2 * travelTime * generatedEnergy / 300 / 50)             // :154 → neutre : ceil(travel/5), réservable : ceil(2*travel/5)
canReserveFrom(roomName):                                                            // :332-339
  room possédée requise
  if (intel(remote).getControllerReservePositionCount() > 1) return energyCapacityAvailable >= 650     // 1 CLAIM + 1 MOVE
  return energyCapacityAvailable >= 1300                                                                // 2 × (CLAIM + MOVE)
```
⇒ L'énergie 3000 est supposée **dès que la room d'origine peut spawner un claimer utile** (RCL3 à 800 si ≥ 2 cases autour du contrôleur, sinon RCL4 à 1300), que la réservation existe ou non.

`getMiningLocationsByRoom()` (:59-75, cache heap **1000 ticks**) : `{[sourceRoom]: [sourceLocation accessibles]}`. `getSourceRoom(loc)`, `getClaimerSourceRoom()` = première clé (:97-114).

### 5.2 Container
```ts
getContainerPosition(loc) = paths[loc].path[0]                       // :409-414
hasContainer(loc):                                                   // :371-404 (cache par tick)
  chemin inaccessible → false
  room non visible → Boolean(status[loc].containerId)
  containerId connu : objet absent ou pas un container → delete, false ; sinon true
  sinon : container sur containerPosition ? → mémoriser l'id, true
getContainer(loc) = Game.getObjectById(containerId) si hasContainer   // :357-363 (null hors vision)
getEnergyForPickup(loc):                                             // :416-431
  total = container.energy ; si room visible : total = montant du DERNIER tas d'énergie à portée 1 de la SOURCE (remplace, n'ajoute pas — quirk)
  mémorisé dans energyCache pour la perte de vision
```

### 5.3 Danger
```ts
isUnderAttack():                                                     // :189-211
  Memory.rooms[remote].enemies && !safe && expires > Game.time → true
  sinon (cache heap 10) : même test pour chaque room traversée par un chemin (hors remote)
hasInvaderCore() = Memory.rooms[remote].enemies?.hasInvaderCore      // :213-215
getTotalEnemyData() : somme damage/heal/parts des rooms du chemin non sûres ; hasInvaderCore si l'une en a   // :217-243
```
`Memory.rooms[r].enemies` est écrit par `RoomIntelProcess.findHostiles` (`process/rooms/intel.ts:51-119`) **pour toute room visible**, cache heap 1 tick (10 si bucket ≤ 8000) :
```ts
pour chaque hostile non allié : if (creep.isDangerous()) {           // creep.military.ts:32-50 : une partie autre que MOVE/TOUGH (et hors room possédée : autre que WORK/CARRY), ou risque d'écraser nos chantiers
    (SK à ≤ 5 d'un lair ignoré)
    safe = false; lastSeen = now; heal += …; damage += …; expires = max(expires, now + ttl) }
  parts[type]++ pour toutes les parties
invader core : hasInvaderCore = true ; safe &&= (level === 0 || ticksToDeploy > 1000) ; expires = fin de l'effet collapse
supprimé si safe && !hasInvaderCore && aucune partie
```
⇒ Hors vision, la room reste « attaquée » jusqu'à `expires` (mort prévue du dernier hostile).

### 5.4 Réservation
```ts
hasReservation():                                                    // :344-352
  visible : reservation.username === moi && ticksToEnd >= 500 (CONTROLLER_RESERVE_MAX * 0.1)
  sinon : intel.getReservationStatus() (décomptée de l'âge) avec les mêmes conditions
```
Utilisé seulement par `canUseRemoteDespiteInvaderCore` (§6.4) et `getHaulerCount` (non appelé).

### 5.5 Maintenance (builders)
```ts
estimateRequiredWorkPartsForMaintenance(loc) = ceil(0.7 + 0.03 × cases du chemin hors rooms possédées)   // :245-258 (heap 500)
getNeededWorkForPosition(pos, type):                                 // :293-309
  room non visible → 0
  structure présente → hitsMax - hits
  (recherche du chantier avec LOOK_STRUCTURES : bug, ne trouve jamais de chantier)
  absente → CONSTRUCTION_COST[type] * 100                            // container 500000, route 30000
needsRepairs(loc) (heap 50) : besoin container > 125000 (donc container absent = true), ou une route du chemin hors room possédée avec besoin > 1666 (ROAD_HITS/3)   // :260-275
getNeededWork(loc) (heap 50) = besoin container + Σ besoins routes hors rooms possédées   // :277-291
needsBuilder(loc) : pas de container, ou container < 1/3 hits, ou route absente / < 1/5 hits (heap 100)   // :555-578 (non utilisé par le spawn)
```

### 5.6 Obstacles — `needsDismantler`, `getDismantlePositions` :490-553
Parcourt le chemin (storage → source), hors rooms possédées, avec `getCostMatrix(room, {ignoreMilitary, allowDanger})` : toute case ≥ 100 (hors invader core) est à démanteler (cache heap 100). Pas pour les rooms SK. Un remote qui `needsDismantler` est **indisponible** pour le spawn (§6.2) et un `dismantler` (prio 3, poids 0, `spawn-role/dismantler.ts:87-111`, corps `{WORK:1}` ROAD) est demandé. Rare sur un serveur privé neuf : portage optionnel.

### 5.7 Statistiques
`addResourceCost(cost)` au spawn (`spawn-role/remote-mining.ts:612-621`), réparations/constructions du builder ; `addResourceGain(amount)` à la livraison du hauler (storage ou drop seulement, pas via le dispatcher). `isProfitable() = getStat(energy) > 0` (:580-582) : sert au délai entre deux défenses (§9.3). Stats divisées par 2 tous les 10000 ticks (`operation/operation.ts:116-124`).

---

## 6. Spawn — `spawn-role/remote-mining.ts`

### 6.1 Ordre d'évaluation — `getSpawnOptions(room)` :64-102
```ts
cacheEmptySpawnOptionsFor(room, 10, () => {
  if (room.defense.getEnemyStrength() >= ENEMY_STRENGTH_NORMAL (2)) return []   // :68 : ennemis sérieux à la maison → rien
  if (roomManager.isMovingMisplacedSpawn()) return []                 // :71
  options = []; haulerDemand = 0; builderDemand = 0
  for position of room.getRemoteHarvestSourcePositions():            // sources de toutes les opérations dont la sourceRoom est cette room, triées par longueur de chemin croissante (prototype/room.resources.ts:368-393, cache heap 500)
    registerPotentiallyActiveSource(room, position)                   // :104-109 : heap 1 tick, lu par la défense (§9.3)
    if (!isAvailableRemote(position)) continue                        // :111-126
    addSkKillerSpawnOptions(…)            ; if (options.length) return options     // SK : ignoré (RCL < 7)
    haulerDemand += getHaulerDemand(position)
    addHaulerSpawnOptions(room, options, haulerDemand) ; if (options.length) return options
    builderDemand += getBuilderDemand(position)
    addBuilderSpawnOptions(room, options, builderDemand) ; if (options.length) return options
    addHarvesterSpawnOptions(room, options, position) ; if (options.length) return options
    addClaimerSpawnOptions(room, options, position)   ; if (options.length) return options
  return options
})
isAvailableRemote(pos) = opération existe && !needsDismantler(loc) && !isUnderAttack() && paths[loc]?.travelTime
```
⇒ **Au plus une option remote par tick**, et une source n'est considérée que si toutes les sources plus proches sont satisfaites (haulers, builders, harvesters, claimer). Les demandes hauler/builder sont **cumulées** sur les sources parcourues.

### 6.2 Hauler — :133-177, :179-238
```ts
getHaulerDemand(pos) = hasContainer(loc) ? paths[loc].requiredCarryParts : 0          // :133-140 : pas de hauler avant le container
addHaulerSpawnOptions(room, options, demand):
  (cache par tick)
  maximumNeededCarryParts = Σ requiredCarryParts des positions actives (getActiveRemoteHarvestPositions :223-238 : opération, pas attaquée, pas de dismantler, travelTime ; SK sans killer exclues) — SANS condition de container
  maxHaulerSize = getMaximumHaulerSize(room, maximumNeededCarryParts)                 // :212-221
     body = getMaximumHaulerBody(room, maximumNeededCarryParts)                       // {CARRY:1}, limite CARRY, ROAD si RCL > 3 && (storage || terminal) sinon PLAINS, énergie = capacité
     maxCarry = min(nb CARRY de ce corps, ceil(0.9 * 2000 / 50) = 36)
     maxHaulers = ceil(maximumNeededCarryParts / maxCarry)
     return ceil(maximumNeededCarryParts / maxHaulers)                                 // taille équilibrée
  haulerSpawnTime = longueur(body) * 3
  currentCarryParts = Σ CARRY actives des 'hauler.relay' avec memory.sourceRoom === room.name et (spawning || ttl > haulerSpawnTime)
  if (currentCarryParts >= demand) return
  options.push({unitType: 'hauler', size: maxHaulerSize, priority: 3, weight: 0})
corps (getHaulerCreepBody :518-527) : weights {CARRY:1}, limite CARRY = size, ROAD si RCL > 3 && storage/terminal sinon PLAINS,
      energyLimit = min(cap, max(0.9 * cap, energyAvailable))
mémoire : {role: 'hauler.relay', sourceRoom: room.name, delivering: true}            // :581-586
```

### 6.3 Builder (`builder.mines`) — :142-150, :240-287
```ts
getBuilderDemand(pos) = hasActiveHarvesters(loc) && needsRepairs(loc) ? estimateRequiredWorkPartsForMaintenance(loc) : 0
addBuilderSpawnOptions:
  if (!room.storage && !room.terminal) return                         // :242 ⇒ JAMAIS avant le storage
  if (room.getEffectiveAvailableEnergy() < 5000) return               // :243
  currentWorkParts = Σ WORK des 'builder.mines' de cette sourceRoom (sans filtre de ttl)
  if (currentWorkParts >= demand) return
  size = getMaximumBuilderSize(room, Σ maintenance des positions actives)   // même équilibrage que les haulers, corps {CARRY:5, WORK:2}
  options.push({unitType: 'builder', size, priority: 3, weight: 0})
corps : weights {CARRY:5, WORK:2}, limite WORK = size, ROAD si RCL > 3 && storage sinon PLAINS, énergie min(cap, max(0.9cap, avail))
mémoire : {role: 'builder.mines', returning: true, sourceRoom: room.name}
```

### 6.4 Harvester — :384-453, :508-516
```ts
loc = encodePosition(pos); op = opération
isActiveRoom = un 'harvester.remote' existe avec memory.source === loc            // :387 (par SOURCE, malgré le nom)
if (op.hasInvaderCore() && !op.hasReservation()) return                           // :389-391
reservation = intel.getReservationStatus()
if (reservation && reservation.username !== moi && reservation.ticksToEnd > 500) return   // :394-396 : réservée par un autre
(SK sans killer → return)
travelTime = paths[loc].travelTime
isEstablished = hasContainer(loc) && (container?.hits ?? 250000) > 125000         // :412
option = { unitType: 'harvester', priority: isActiveRoom ? 3 : 1, weight: 1 - travelTime / 100,
           targetPos: pos, isEstablished, size: getHarvesterSize(loc) * sizeFactor }   // :414-424 ; sizeFactor = 1 en RCL < 6
getHarvesterSize(loc) = requiredWorkParts × (hasContainer ? 1 : 1.5)               // :447-454 → 2.5 / 3.75 (neutre), 5 / 7.5 (réservable)
creepSpawnTime = longueur(corps de l'option) * 3
harvesters = 'harvester.remote' avec source === loc et (spawning || ttl > min(travelTime + creepSpawnTime, 500))   // :427-438 (remplacement anticipé)
freeSpots = intel.sources[loc].free || 1                                          // :442-445
if (harvesters.length >= freeSpots) return
requestedSaturation = (hasContainer || RCL > 5) ? 0.9 : (BUILD_POWER + HARVEST_POWER) / BUILD_POWER = 1.4   // :448
if (Σ WORK actives des harvesters >= getHarvesterSize(loc) × requestedSaturation) return   // :449-450
options.push(option)
corps : weights {WORK:20, CARRY: (isEstablished && RCL >= 6) ? 0 : 1}, limite WORK = size > 0 ? size + 1 : 0,
        ROAD si isEstablished sinon PLAINS, carryContentLevel 0, énergie min(cap, max(0.9cap, avail))   // :508-516
mémoire : {role: 'harvester.remote', source: loc, operation: 'mine:' + room}       // :575-580 (PAS de sourceRoom)
```
⇒ Premier harvester d'une source à **priorité 1** (après toute l'économie locale), les suivants (et remplacements) à 3. Sans container, plusieurs petits harvesters par source jusqu'à `3.75 × 1.4 = 5.25` WORK (neutre) ou `7.5 × 1.4 = 10.5` (réservable), bornés par les cases libres. Avec container : jusqu'à `0.9 × 2.5 = 2.25` ou `0.9 × 5 = 4.5` WORK.

### 6.5 Claimer — :289-342, :498-506
```ts
if (!intel.isClaimable()) return
if (cap < 1300) { if (!maySpawnSmallClaimer(room, pos)) return }                 // :294-296
   maySpawnSmallClaimer : cap >= 650 && (reservePositionCount > 1 || réservation d'un autre avec ticksToEnd > 0)   // :330-342
pathLength = _.sample(op.getPaths())?.path?.length || 50                          // :301 : chemin d'une source AU HASARD (quirk)
body = getClaimerCreepBody(room); claimerSpawnTime = body.length * 3
claimers = 'claimer' mission 'reserve' dont la cible est dans cette room
activeOnArrival = claimers spawning ou ttl > pathLength + claimerSpawnTime
if (activeOnArrival.length >= intel.getControllerReservePositionCount()) return   // :310 : 1 claimer par case libre autour du contrôleur
claimParts = nb CLAIM du corps
maxAdditionalReservation = (claimParts - 1) × (600 - pathLength)                  // :313-314 (gain net : -1/tick de décroissance)
remaining = lastClaim ? max(0, lastClaim.value + lastClaim.time - Game.time) : 0  // :316 (Memory.rooms[remote].lastClaim, écrit par le claimer)
extra = Σ claimers ((spawning ? 600 : ttl) × CLAIM actives)
atArrival = remaining + extra - claimerSpawnTime - pathLength
if (atArrival + maxAdditionalReservation > 5000) return                           // :319
options.push({unitType: 'claimer', priority: 3, weight: 1 - pathLength / 100, targetPos: intel.getControllerPosition()})
corps : weights {CLAIM:1}, limite CLAIM = floor(5000/600) = 8, PLAINS, énergie = cap      // :498-506 (pas de 0.9)
mémoire : {role: 'claimer', target: encodePosition(controllerPos), mission: 'reserve', operation: 'mine:' + room}
```
⇒ Avec des corps à 1 CLAIM (RCL3, 800), le contrôle `> 5000` ne bloque jamais : Hivemind envoie **autant de claimers que de cases libres autour du contrôleur** (1 CLAIM = +1/tick, compensé par la décroissance ; k claimers = +(k-1)/tick). C'est la source des 9 C pour 3 rooms.

### 6.6 Corps obtenus (simulation de notre `buildBody`, capacité pleine)

| Corps | 300 | 550 | 800 | 1300 |
|---|---|---|---|---|
| HR neutre, sans container (limite W 4.75) | 1W 1C 1M | 3W 1C 3M | 5W 1C 5M | 5W 1C 5M |
| HR neutre, établi (limite 3.5, ROAD) | 2W 1C 1M | 4W 1C 2M | 4W 1C 2M | 4W 1C 2M |
| HR réservable, sans container (limite 8.5) | 1W 1C 1M | 3W 1C 3M | 5W 1C 5M | 8W 1C 8M |
| HR réservable, établi (limite 6, ROAD) | 2W 1C 1M | 4W 1C 2M | 6W 1C 3M | 6W 1C 3M |
| TRR PLAINS (taille ≥ 13) | 3C 3M | 5C 5M | 8C 8M | 13C 13M |
| TRR ROAD (RCL4 + storage, taille ≥ 17) | — | — | — | 17C 9M |
| Claimer | ∅ (pas de spawn) | ∅ | 1K 1M (650) | 2K 2M |
| BM ROAD (storage) limite W 2 / ≥ 4 | — | — | — | 6C 2W 4M / 10C 4W 7M |
| Scout | 1M | 1M | 1M | 1M |

Énergie de spawn `min(cap, max(0.9·cap, energyAvailable))` (sauf claimer : cap) : la room attend que ce corps soit finançable (règle du SpawnManager : pas de repli).

### 6.7 Place dans l'arbitrage global
Priorités locales (cf. `hivemind-spawning.md` tableau §0) : harvester 4-6, transporter 3-6, builder 3-4 (poids 0.5), upgrader 3 (poids 1, seulement avec storage ou downgrade), brawler 5, scout early 4 (poids 1).
- Remote hauler / builder / harvester actif / claimer à 3 : battus par un builder à 3 (poids 0.5 > 0) ou un transporter « ≥ max/2 » à 3 (poids 0.5) sauf claimer (poids `1 - pl/100` > 0.5 si pl < 50). Égalité de poids → ordre d'enregistrement (`builder` < `remote-mine` < `transporter`).
- Premier harvester d'une source à 1 : seulement quand plus aucune option locale n'existe.
- Avant le storage, l'économie locale sature vite (builders plafonnés par le quota de WORK, pas d'upgrader) : le spawn devient libre et part sur les remotes dès RCL1-2.

---

## 7. Rôles

### 7.1 `harvester.remote` — `role/harvester.remote.ts`
```ts
run:                                                                  // :47-55
  if (!creep.operation) return                                        // opération terminée : le creep reste inactif jusqu'à sa mort
  if (travelToSource()) return
  performRemoteHarvest()

travelToSource():                                                     // :66-106
  if (combatManager.needsToFlee(creep)) { performFleeTowards(creep, sourcePos, 1); return true }
  if (hors room du remote && pas de chemin caché):
    if (!paths[source]?.accessible) { rester sur place; return false }
    setCachedPath(paths[source].path, reverse = true, distance = 1)  // chemin storage → source, sans la dernière case (s'arrête à portée 1 du container)
  if (chemin caché):
    if (arrivé || range(source) < 3 || (dans le remote && source dangereuse (SK) && range < 10)) clearCachedPath()
    else { followCachedPath(); return true }
  if (source dans une autre room) { moveToRange(source, 1); return true }
  return false

performRemoteHarvest():                                               // :114-218
  if (pas dans le remote) return
  // 1. obstacle sur la case du container (pas encore de container) → dismantle (portée 1), return     :117-132
  // 2. construire : workParts = (a une CARRY) ? WORK : 0
  site = chantier à moi le plus proche, type container ou route
  if (site && range <= 3):
    if (energy >= min(5 * workParts, capacité) && workParts > 0) { if (build(site) === OK) return }
    else pickup(un tas d'énergie à portée 1)                          // :137-155
  // 3. réparer le container de CETTE source : energy >= workParts && hasContainer && container à portée 3
  //    && hits <= hitsMax - workParts*100 → repair, return            // repairNearbyContainer :258-280
  // 4. (SK : s'éloigner) :162-174
  // 5. position : container libre (aucun creep dessus) → portée 0 du container ; sinon portée 1 de la source
  //    si container à portée 1, presque plein (free < WORK*2) et occupé par un autre → transfer(container)   :178-197
  whenInRange(range, cible, () => {
    if (source.energy <= 0) return
    if (mayHarvest()) harvest(source)
    if (!hasContainer(loc)): containerPos = getContainerPosition(loc);
        si aucun chantier de container dessus → containerPos.createConstructionSite(CONTAINER)   // :207-216 : c'est le harvester qui POSE le container
  })

mayHarvest():                                                         // :227-256
  source pleine → true (démarre le timer de régénération)
  free >= WORK*2 → true
  pas de container → true (le surplus tombe au sol)
  pas sur le container → false
  container.free >= WORK*2 → true
  ticksToRegeneration <= ceil(source.energy / (WORK*2)) → true (sinon l'énergie serait perdue)
  false
```
Avant le container : récolte, l'excédent tombe au sol ; dès qu'il a `5 × WORK` d'énergie il construit (5000 points de chantier pour un container). Ensuite il remplit le container et le répare lui-même (pas de builder nécessaire avant le storage).

### 7.2 `hauler.relay` — `role/hauler.relay.ts`
Le « relais » est un nom historique : `performRelay()` est un bouchon qui renvoie toujours `false` (:331-335). Il n'y a **pas** de passage de relais entre haulers ; c'est un **pool** de haulers par room d'origine, chacun choisissant une source à chaque voyage.
```ts
run:                                                                  // :54-75
  if (!segments prêts) return
  isEmpty = used === 0 ; isFull = used >= 0.9 × capacité
  delivering && isEmpty → startPickup() ; !delivering && isFull → startDelivering()
  delivering ? performDeliver() : performPickup()

startPickup():                                                        // :77-87
  delete delivering, deliveryTarget, pickupTarget
  determineTargetSource()                                             // :89-104 : max de scoreHarvestPosition sur room.getRemoteHarvestSourcePositions()
  setCachedPath(paths[source].path, reverse = true, 1)

scoreHarvestPosition(pos):                                            // :106-143
  op absente → -1000
  currentEnergy = op.getEnergyForPickup(loc)
  maxHarvesterTtl = ttl max des HR de cette source (undefined s'il n'y en a pas → NaN, quirk)
  projectedIncome = hasContainer ? min(maxHarvesterTtl, travelTime) × (canReserveFrom ? 3000 : 1500) / 300 : 0
  queued = Σ free capacity des TRR déjà en route vers cette source (!delivering) + Σ free des BM vers cette source (!returning)
  energy = currentEnergy + projectedIncome - queued - (isUnderAttack ? 1000 : 0) - 2 × travelTime
  creep.memory.source = loc ; memory.operation = 'mine:' + room

performPickup():                                                      // :343-455
  pas de source → startDelivering()
  needsToFlee → performFleeTowards(sourcePos, 1)
  (SK dangereux à ≤ 10 : attendre le killer ou rentrer)
  pickupNearbyResources() → return (hors rooms possédées : tas ≥ 20 / tombe / ruine à portée 3 ; un container presque plein (>90 %, > 100 énergie) adjacent est enchaîné)   :473-550
  chemin caché : arrivé ou à ≤ 3 de la source → clear ; sinon followCachedPath, return
  autre room → moveToRange(source, 1)
  !creep.operation → startDelivering()
  container = op.getContainer(loc):
    hasActiveHarvester = HR de cette source à ≤ 3 du container
    if (!hasActiveHarvester && container.energy < 20) → startDelivering()
    whenInRange(1, container):
      if (container.energy >= min(capacité/2, free) || !hasActiveHarvester || ttl < 1.5 × path.length)
         withdraw(energy) === OK → startDelivering()                  // part dès un retrait (pas forcément plein)
  pas de container : à > 2 de la source → s'approcher (portée 2) puis rentrer ; sinon rentrer

startDelivering():                                                    // :145-160
  delivering = true ; delete source, deliveryTarget, pickupTarget
  chemin (paths[source] avant suppression) → setCachedPath(path, reverse = false, 1) ; sinon moveToRoom(sourceRoom)

performDeliver():                                                     // :177-224
  needsToFlee → performFleeTowards(room.getStorageLocation(), 5)
  énergie && builder/builder.remote/builder.mines/upgrader adjacent avec free > capacité/3 → transfer, return
  pickupNearbyResources() → return
  dans la sourceRoom (ou cible déjà connue) : target = getDeliveryTarget() (storage||terminal, sinon null) ; storeResources(target), return
  sinon suivre le chemin caché (clear à l'arrivée) ou moveToRange(storageLocation, 1)

storeResources(target):                                               // :244-275
  transferEnergyToNearbyTargets()                                     // :277-305 : sans storage, dans la sourceRoom : spawn/extension/tour adjacents non pleins (au hasard), sinon builder/upgrader adjacent
  if (!storage && !terminal && energy > 0):
    order (heapMemory) invalide → order = room.destinationDispatcher.getTask({creep, resourceType: energy})
    order → destinationDispatcher.executeTask(order); return          // ⇒ se comporte comme un TRANSPORTER LOCAL : spawn 5 / bay 5 / extension 4 / container contrôleur 4 / tour 3 / workerCreep 2 / drop au centre 0
  if (!target || used > target.free) → dropResources() : whenInRange(0, storageLocation) drop     // :307-329 (centre du plan ; sur place si pas de storageLocation)
  sinon whenInRange(1, target) transfer + addResourceGain
```
Points clés :
- Pas de storage : l'énergie distante est livrée **directement aux structures de spawn**, puis aux builders/upgraders, sinon empilée au **centre du plan** (`getStorageLocation() = roomPlanner.getRoomCenter()`, `prototype/room.resources.ts:333-338`), où les creeps locaux la reprennent (source `drop`, cf. `hivemind-roles.md` §5.b) et où elle compte dans `getStoredEnergy` (`prototype/room.resources.ts:201-212`).
- L'ordre est en `heapMemory.order`, donc **non compté** par `getCreepsWithOrder` (réservations des transporters locaux) : quirk, les haulers ne « réservent » pas leurs destinations.
- Avec storage : storage (ou drop au centre si plein).

### 7.3 `claimer` (mission `reserve`) — `role/claimer.ts`
```ts
run:                                                                  // :52-68
  needsToFlee → performFleeTowards(target, 1)
  interRoomTravel(targetPos) → return ; pas dans la room → return
performReserve():                                                     // :105-132
  whenInRange(1, controller, () => {
    reservation = (réservé par moi) ? ticksToEnd : 0
    room.memory.lastClaim = {time: Game.time, value: reservation}     // lu par le spawn (§6.5)
    réservé par un autre : si non allié → attackController ; return
    reserveController(controller)
    si sign.username → signController('')
  })
```
Throttle : jamais (`stopAt = throttleAt = 0`, :41-43).

### 7.4 `builder.mines` — `role/builder.mines.ts` (RCL4 + storage + ≥ 5000 d'énergie uniquement)
```ts
run:                                                                  // :41-73
  pas de source : hors sourceRoom → interRoomTravel(25,25) ; sinon whenInRange(3, storage || terminal || storageLocation, determineTargetSource)
  returning ? (performBuildRoad() || performReturnHome()) : performGoToSource()
determineTargetSource : max de getNeededWork(loc) parmi les sources (score 0 si un BM la couvre déjà ou aucun HR, -1000 si attaquée)   // :96-133
setReturning(r): returning = r ; si !r → determineTargetSource ; chemin caché (reverse = !r, 1)   // :83-94
performReturnHome:                                                    // :150-199
  près du container (< 10), moins de 50 % plein et container > 10 % → withdraw
  pickupNearbyEnergy (tas ≥ 100 à portée 3)
  dans la sourceRoom : plein → setReturning(false) ; sinon getBestStorageSource(energy) → withdraw → setReturning(false) ; sinon attendre à 5 du centre
  sinon suivre le chemin caché / moveToRange((25,25,sourceRoom), 20)
performGoToSource : suit le chemin en construisant ; à ≤ 2 de la source → setReturning(true) ; répare/construit en route      // :207-261
performBuildRoad:                                                     // :331-352
  chemin caché → buildRoadOnCachedPath : cases i-2..i+2 du chemin, dans la room courante (pas dans une room possédée par un autre) :
      route abîmée (hits < hitsMax - WORK*100) → repair (reste si < hitsMax - 2*WORK*100) ;
      route absente hors room possédée, < 70 chantiers au total, < 5 chantiers dans la room → createConstructionSite(ROAD), reste   // :363-419
  sinon repairNearby (route/container à portée 3, < hitsMax - WORK*100)
  ensureRemoteHarvestContainerIsBuilt : répare le container (portée 3) ou pose son chantier                                      // :450-491
  buildNearby : chantier container/route à portée 3 → build (reste si reste > WORK*10)                                           // :493-517
```
Les routes des rooms distantes ne sont posées **que** par les builders.mines (le harvester ne fait que construire les chantiers existants à portée 3). Dans la room d'origine, le room manager pose les routes du chemin remote (`room/room-manager.ts:326-344`, `buildOperationRoads` :678-685) **seulement en RCL ≥ 4 avec storage** (:424-428), max 5 chantiers par room, < 90 chantiers au total (:717-718). Le builder local répare ces routes (`role/builder.ts:381-384`).

### 7.5 Fuite — `creep/combat-manager.ts`
```ts
getEnemyMilitaryCreeps(room) = hostiles non alliés avec ATTACK ou RANGED_ATTACK actifs      // :105-123
needsToFlee(creep) = un tel ennemi à ≤ 5 (SK : 3) && il en existe un contre lequel couldWinFightAgainst = false   // :67-72 (un creep civil ne gagne jamais)
performFleeTowards(creep, target, range):                             // :47-65
  scoredPositions = 8 voisins praticables, score :
    -range(pos, target) × (0.9 + range/10) - min(|dx|, |dy|)          (seulement si target dans la même room)
    marais -100 ; bord +200 (fuite) ; voisinage 2 : mur -20, marais -10, bord +20
    + score de distance aux ennemis (addEnemyRangeScore)
  move vers le meilleur
```
Pas de retraite globale vers la base : chaque creep fuit localement ; le spawn de l'opération est suspendu tant que `isUnderAttack()` (§6.1), les haulers évitent la source (score -1000).

---

## 8. Interactions avec l'économie locale

| Interaction | Fichier:ligne | Effet |
|---|---|---|
| Hauler sans storage → `destinationDispatcher` de la room | `role/hauler.relay.ts:247-259` | remplit spawn/extensions/tours/container contrôleur/workers, drop au centre |
| Drop au centre (storageLocation) | `role/hauler.relay.ts:307-329`, `prototype/room.resources.ts:333-338` | tas repris par les transporters (prio 0 sans storage) et workers (prio 4) |
| Énergie stockée | `prototype/room.resources.ts:201-212` | le tas central compte dans `getStoredEnergy` → quotas builders (`E/3000`), défense remote (≥ 5000) |
| Transporter spawn | `spawn-role/transporter.ts:36-52` | `hasHaulers` (TRR de cette sourceRoom) : avec 0 transporter et des extensions, le premier transporter n'est plus « forcé » (poids 0.5 au lieu de 1) |
| Builder spawn | `spawn-role/builder.ts:83-88` | compte les HR `memory.sourceRoom === room` : jamais vrai (les HR n'ont pas de sourceRoom) → sans effet |
| Destinations `workerCreep` | `dispatcher/resource-destination/worker-creep.ts` | rôles servis : builder.remote 2, builder 1.5, upgrader 0.5 (pas builder.mines) |
| Remote path → storage planifié | `empire/remote-path-manager.ts:44` | dépend du planner (position `storage`) ; navigation matrix du plan |
| Routes d'opération dans la room d'origine | `room/room-manager.ts:424-428` | RCL ≥ 4 + storage seulement |
| Spawn | `spawn-role/remote-mining.ts:68` | ennemis ≥ NORMAL à la maison → aucun spawn remote |
| Defense mode local | `spawn-role/brawler.ts:86` | défense remote seulement si énergie effective ≥ 5000 |

---

## 9. Défense, invader cores, rooms d'autres joueurs

### 9.1 Rooms d'autres joueurs
- Possédée par un autre (ou core invader de niveau > 0 sans contrôleur) : `isOwned()` → matrice `false` → aucun chemin à travers ni vers elle (`empire/remote-path-manager.ts:73`).
- Réservée par un autre : pas de pénalité dans le score de harvest. Harvesters bloqués tant que `ticksToEnd > 500` (`spawn-role/remote-mining.ts:394-396`) ; claimers autorisés (même 1 CLAIM, `maySpawnSmallClaimer` :338-339) et font `attackController` si non allié (`role/claimer.ts:119-123`). Les réservations `Invader` sont donc combattues par les claimers.
- Sur le flood fill du scout, une room réservée par un non-Invader rend `safePath` faux (info seulement).

### 9.2 Invader cores
- `hasInvaderCore` (§5.3) : harvesters bloqués sauf si `hasReservation()` (≥ 500 ticks de réservation à nous) (`spawn-role/remote-mining.ts:389-391`).
- Un core de niveau 0 (réservation invader) laisse `safe = true` → pas « attaquée », mais déclenche la défense §9.3 avec `RESPONSE_ATTACKER`.

### 9.3 Brawler de défense remote — `spawn-role/brawler.ts:73-127`
```ts
pour chaque position de getRemoteHarvestSourcePositions() :
  if (!op || (!op.isUnderAttack() && !op.hasInvaderCore())) continue
  if (op.isUnderAttack() && room.getEffectiveAvailableEnergy() < 5000) return      // :86 : return (stoppe toutes les positions)
  if (op.isUnderAttack() && op.needsDismantler()) continue
  if (!isActivelyUsedSource(room, pos)) continue          // room enregistrée ce tick par le spawn remote (§6.1) ou un HR existant dans la room
  targetPos = (25,25,room) encodé
  délai = op.isProfitable() ? 300 : 1500 ; if (Game.time - room.memory.recentBrawler[targetPos] < délai) continue
  if (un brawler avec memory.operation === 'mine:' + room) continue
  response = getDefenseCreepSize(room, op.getTotalEnemyData())            // :164-247
     enemyPower = damage + 5 × heal ; small = 5×30 + 3×12×3 = 258 ; smallBlinky = 6×10 + 2×12×5 = 180
     core && enemyPower < 258 → ATTACKER (corps {ATTACK:1}, moveBuffer 0.4)
     enemyPower < 129 && pas de RANGED → MINI_BRAWLER ({ATTACK:2, HEAL:1}, ATTACK ≤ 5)
     enemyPower < 180 → MINI_BLINKY ({RANGED:7, HEAL:3}, RANGED ≤ 6)
     … (blinky, trains : hors RCL1-4 en pratique) ; sinon NONE (pas de défense)
  options.push({priority: 3, weight: 1, targetPos, pathTarget: loc, responseType, operation: op.name})
onSpawn : room.memory.recentBrawler[targetPos] = Game.time                 // :482-483
```
Corps (énergie min(cap, max(0.9cap, avail))) : ATTACKER 2A2M (300) / 4A4M (550) / 6A6M (800) / 10A10M (1300) ; MINI_BRAWLER ∅ / 1A1H2M / 3A1H4M / 5A2H7M ; MINI_BLINKY ∅ / 1R1H2M / 2R1H3M / 3R2H5M.
Rôle brawler (`role/brawler.ts:114-129`, :373-406) : à l'init, réutilise le chemin remote de `pathTarget` ; va vers `target` (25,25 du remote), engage les cibles (hors rooms possédées : creeps hostiles et invader cores seulement, :259-260).
⇒ Avant le storage (énergie effective < 5000 en général), **pas de défense** des remotes attaqués : Hivemind suspend simplement le spawn (et les creeps fuient) jusqu'à `expires`. Seuls les invader cores reçoivent un ATTACKER.

### 9.4 Room-defense locale
`spawn-role/room-defense.ts` ne concerne que la room possédée (hors périmètre, cf. `hivemind-construction.md`).

---

## 10. Dépendances et repli (pour notre port)

| Besoin Hivemind | Chez nous | Repli / action |
|---|---|---|
| Intel par room (sources avec `free`, contrôleur, réservation décomptée, owner, routes, sorties, `lastScan`) | `IntelManager` (`Memory.intel`, `miningValue`) | étendre `RoomIntel` : `sources[{x,y,free}]`, `controller {x,y}`, `reservation`, `exits`, `roads`, `reservePositions` ; rafraîchir toutes les 500 ticks pour toute room visible |
| `Memory.rooms[r].enemies` pour les rooms NON possédées | `RoomIntel.ts` n'écrit que pour les rooms possédées | écrire aussi pour les remotes visibles (avec `expires`, `hasInvaderCore`) |
| Liste des rooms avec `origin`/`range` (flood par sorties) | `ScoutManager` (portée 3, RCL ≥ 2, prio 1) | flood fill §2.1 ; scout dès RCL1, prio 4 poids 1 tant que pas de storage, throttle 500 ticks |
| Position de storage planifiée | `RoomPlan.getLocations("storage")` (planifié en C+(0,1)) | OK ; sans plan → **ne pas calculer** (et ne pas cacher l'échec 5000 ticks) |
| Navigation matrix du plan | `planner/matrices.ts` | routes planifiées 1, obstacles planifiés 255 ; repli : CostMatrix vide |
| `getStorageLocation()` | `roomState.storageLocation` (centre, sinon storage, sinon spawn) | OK (notre repli spawn est un écart déjà acté) |
| Dispatcher de destinations utilisable par un creep d'un autre rôle | `dispatcher/destinations.ts` | appeler le même `getTask/execute` pour les haulers ; décider si leur ordre compte dans `creepsWithOrder` (Hivemind : non) |
| Chemins cachés (`setCachedPath` reverse/distance, `followCachedPath`) | `trafficManager` (cartographer) | stocker le chemin source→storage (sérialisé) ; `requestMove` vers la position cible avec le chemin connu, ou `moveByPath` de cartographer ; repli : `requestMove(cible)` simple |
| Fuite `needsToFlee`/`performFleeTowards` | — | repli simple : ennemi militaire à ≤ 5 → `requestMove` en fuite (cartographer `flee`) |
| `room.defense.getEnemyStrength()` | `roomState.hasEnemies` / `room.memory.enemies` | ennemis non sûrs à la maison → pas de spawn remote |
| `getEffectiveAvailableEnergy()` | `roomState.effectiveEnergy` | OK (inclut le tas central et les containers de harvest) |
| Opérations (`Memory.operations`) | `Memory.remotes` (RemoteMiningManager) | remplacer `RemoteMiningManager` (RCL ≥ 4 + storage, 2 remotes, distance 1) par la logique §3-§6 |
| Spawn par options | `spawning/spawnRoles.ts` + `requestSpawn` (remote prio 3) | ajouter un spawn-role `remote-mine` (et `scout`) natif, enregistré entre `harvester` et `scout` (ordre alphabétique) |
| Builder.mines (storage) | — | à porter en dernier ; avant le storage seul le harvester entretient le container |
| Brawler de défense remote | `roles/brawler.ts` (défense locale) | optionnel avant storage (Hivemind ne défend pas sous 5000 d'énergie) ; ATTACKER pour invader core |
| Dismantler | — | hors jalon : marquer le remote indisponible si le chemin est bloqué |
| Segments mémoire | — | `Memory` (taille modeste : quelques chemins packés) |

Ordre de portage suggéré : (1) intel + flood + score ; (2) chemins + opération ; (3) spawn-role harvester/hauler/claimer + rôles HR/TRR/C ; (4) scout précoce ; (5) défense (enemies hors room, fuite) ; (6) builder.mines + routes d'opération à RCL4.

---

## 11. Déroulé type d'une room RCL1 → 4 (une source distante à ~50 cases, 3 cases libres, contrôleur à 3 cases libres)

1. **Ticks 0-~100, RCL1 (cap 300).** Plan calculé (storage planifié connu). Spawn local : harvesters (6/5), transporter (5). Le scout (prio 4, poids 1, `[MOVE]`) sort dès que harvesters et 1er transporter sont là, avant les builders. Les voisines (range 1) sont connues par les sorties de la room possédée.
2. **Visites.** Le scout visite les rooms de range 1 puis 2, 3… (ordre de range). À chaque visite : intel (sources, free, contrôleur, réservation, routes, sorties) → le flood s'étend. Au run suivant du scout process (≤ 25 ticks) : `harvestPriority = 3000 / plus court chemin` pour les rooms de range ≤ 3 (chemin calculé et caché 5000 ticks).
3. **Sélection (≤ 20 ticks plus tard).** Les 5 meilleures rooms (1 spawn) → opérations `mine:X`. Rien ne dépend de la RCL.
4. **Premier HR (prio 1).** Dès que plus aucune option locale n'existe (builders au quota, transporters au max) : HR 1W1C1M (cap 300) vers la source la plus proche. Les suivants pour la même source passent à prio 3 jusqu'à `min(3 creeps (cases), 5.25 WORK)` → 3 × 1W en RCL1. Arrivé, le HR pose le chantier de container sur `path[0]`, récolte (surplus au sol), construit dès 5 d'énergie (5000 points : ~800 ticks avec 3 WORK).
5. **RCL2 (cap 550).** Nouveaux HR 3W1C3M (sans container). La source suivante n'est considérée qu'une fois la précédente satisfaite (haulers + harvesters + claimer impossible avant 650).
6. **Container fini** (`hasContainer`) : `haulerDemand += ceil(50/5) = 10` CARRY ; TRR (prio 3) de taille équilibrée sur la demande totale des sources actives (ex. 30 CARRY / 5 par corps → 6 haulers 5C5M). Les HR établis passent en corps ROAD (2W1C1M / 4W1C2M) et visent 2.25 WORK. Les TRR livrent spawn/extensions/tours/container contrôleur/workers, sinon déposent au centre ; le tas central nourrit builders et transporters et augmente `effectiveEnergy` (plus de builders).
7. **RCL3 (cap 800).** Si ≥ 2 cases autour du contrôleur : `canReserveFrom` vrai → énergie supposée 3000 (HR jusqu'à 4.5 WORK, 20 CARRY par source à 50 cases) et claimers 1K1M (prio 3, poids `1 - pl/100`), un par case libre du contrôleur (3 claimers = +2/tick de réservation). Contrôleur à 1 case : pas de claimer avant 1300 (sauf réservation ennemie à attaquer). Réservations `Invader` : attaquées par les claimers ; HR bloqués tant qu'elles dépassent 500 ticks.
8. **Attaque d'un remote.** `isUnderAttack` (ennemi dangereux vu, jusqu'à sa mort prévue) : plus aucun spawn pour cette opération, haulers redirigés (score -1000), creeps présents fuient localement. Pas de brawler tant que l'énergie effective < 5000. Invader core : ATTACKER prio 3.
9. **RCL4 (cap 1300).** Max 4 remotes (roomNeeds = 1). Claimers 2K2M. Une fois le **storage** construit : haulers en ROAD (17C9M max), livraison au storage, `builder.mines` (prio 3, si énergie effective ≥ 5000 et des HR actifs) qui posent/réparent les routes du chemin et le container ; le room manager pose les routes d'opération dans la room d'origine ; défense remote possible (≥ 5000).

---

## 12. Quirks à ne pas reproduire aveuglément

1. Score de harvest = 6 quand aucune source n'a de chemin (`process/strategy/scout.ts:195-210`) → la room occupe un slot inutilement.
2. Échec de chemin caché 5000 ticks (`empire/remote-path-manager.ts:27-31`), y compris quand le planner n'était pas prêt.
3. `getEnergyForPickup` remplace le total par le dernier tas au lieu d'additionner (`operation/remote-mining.ts:422-426`).
4. `getNeededWorkForPosition` cherche les chantiers avec `LOOK_STRUCTURES` (`operation/remote-mining.ts:304`).
5. `scoreHarvestPosition` : `_.max` sur une liste vide → `ttl` undefined → `NaN` quand aucun HR (`role/hauler.relay.ts:114-118`) ; sans container l'income vaut 0 de toute façon, mais le `NaN` rend la comparaison instable.
6. Pathlength du claimer tiré au hasard parmi les sources (`spawn-role/remote-mining.ts:301`).
7. Les HR n'ont pas de `memory.sourceRoom` : le test de `spawn-role/builder.ts:84` ne les compte jamais.
8. L'ordre de livraison des TRR est en heap → hors réservations (`role/hauler.relay.ts:248-256`).
9. `brawler.ts:86` : `return` au lieu de `continue` quand l'énergie manque.
10. `performRelay` est un bouchon (`role/hauler.relay.ts:331-335`) : rien à porter.
11. Opération terminée : HR inactifs jusqu'à leur mort (`role/harvester.remote.ts:48-51`) ; prévoir un recyclage.
