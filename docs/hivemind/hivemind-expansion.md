# Hivemind — spécification de portage : EXPANSION (2e room et suivantes) et aide inter-rooms

Source : `C:\Users\ruffa\AppData\Local\Temp\bots\hivemind\src` (Hivemind 3.0.0, commit `dcad7a7`, MIT). Toutes les références `fichier:ligne` sont relatives à `src/`.
Périmètre : décision d'expansion (`process/strategy/expand.ts`), score des rooms candidates (`process/strategy/scout.ts`, `room-intel.ts`), squads (`manager.squad.ts`, `squad.ts`, `spawn-role/squad.ts`), claim (`role/brawler.ts` unité `singleClaim`/`claimer`, `role/claimer.ts`), bootstrap (`role/builder.remote.ts`, room manager d'une room sans spawn), reclaim (`reclaim-manager.ts`, `spawn-role/reclaim.ts`), interactions avec le minage distant. Intershard, évacuation, stripmines, terminaux : mentionnés brièvement.

Conventions (identiques aux autres docs `docs/hivemind/`) : `getBestOption` garde la **priorité la plus haute**, puis le poids le plus haut ; à égalité la première option collectée (ordre d'enregistrement des spawn-roles : `brawler, builder, dismantler, harvester, …, reclaim, remote-mine, room-defense, scout, squad, transporter, upgrader`, cf. `hivemind-spawning.md` §0). BodyBuilder : algorithme exact de `hivemind-spawning.md` §3 (= notre `src/core/bodyBuilder.ts`). `CREEP_LIFE_TIME = 1500`.

---

## 0. Vue d'ensemble

```
ScoutProcess (/25) ─► expansionScore de chaque room connue scoutée (range 1..7), cache heap 20000 ticks
ExpandProcess (/5 si canExpand, sinon /50 ; seulement si une room ≥ RCL4 existe)
  ├─ mayExpand : rooms possédées < GCL  &&  CPU moyen (1000 et 10000 ticks) < 80 % (ou 100 %) de Game.cpu.limit
  ├─ choix de la cible : meilleur score modifié (échecs passés), non possédée, joignable depuis une room ≥ RCL5 avec spawn (navmesh ≤ 500)
  ├─ squad 'expand' (spawn dans la room d'origine) : 1 brawler + 1 singleClaim + 2 builders
  │     builder arrivé dans la room cible ─► devient 'builder.remote' (reste dans la room, upgrade/construit/remplit le spawn)
  ├─ squads 'expandSupport.<cible>.<room>' : 1 builder depuis chaque autre room RCL ≥ 4 avec ≥ 50 000 d'énergie (max 5)
  ├─ RoomPlanner + RoomManager tournent pour la cible (même avant le claim)
  └─ fin : succès quand la cible a RCL ≥ 4 ET un storage ; échec si pas claimée en 7500 ticks, ou 30 000 ticks après le claim, ou perdue
ReclaimProcess (/100) : une room possédée sans spawn (hors cible d'expansion, ≥ 2 rooms) reçoit des builder.remote (prio 3) et des brawlers (prio 4)
```

**Conséquence clé pour nous : Hivemind n'expanse jamais tant qu'aucune room n'est RCL ≥ 5** (la room d'origine doit être RCL ≥ 5, §3.4) **et n'a pas ≥ 5000 d'énergie effective** (sinon le squad ne spawne pas, §4.2). Le `singleClaim` coûte 850 (1 CLAIM + 5 MOVE) : physiquement impossible avant RCL4 (cap 1300).

---

## 1. Activation et cadence

| Process | Fichier:ligne | Intervalle / priorité | Condition |
|---|---|---|---|
| `strategy.expand` | `main.ts:153-158` | `Memory.hivemind.canExpand ? 5 : 50`, `PROCESS_PRIORITY_HIGH` | `shardHasEstablishedRooms` = `info.ownedRooms > 0 && info.maxRoomLevel > 3` (`main.ts:149-151`) → une room RCL ≥ 4 |
| `strategy.scout` | `main.ts:143-147` | `scoutProcessInterval = 25`, LOW | toujours (segments prêts) |
| `strategy.reclaim` | `main.ts:187-190` | 100, LOW | `shardHasEstablishedRooms` |
| `strategy.remote_mining` | `main.ts:161-164` | `myRooms === 1 ? 20 : 100` | ≥ 1 room |
| `strategy.inter_shard` | `main.ts:193-196` | 100 | met à jour `info.ownedRooms`, `info.maxRoomLevel` (`process/strategy/intershard.ts:93-105`) |
| `empire.resources` (terminaux) | `main.ts:203-205` | 5 | **PLUS TARD** (RCL6) |
| spawn-role `squad` | `spawn-role/squad.ts:44-68` | chaque tick de spawn, cache « options vides » 10 ticks | via SpawnManager |
| spawn-role `reclaim` | `spawn-role/reclaim.ts:24-42` | cache « options vides » 100 ticks | segments prêts |

`info.ownedRooms`/`maxRoomLevel` ne sont rafraîchis que toutes les 100 ticks (process intershard) : léger retard après le passage RCL4.

`run()` (`process/strategy/expand.ts:94-110`) :
```ts
if (!stats.getStat('cpu_total', 1000)) return            // :96 : il faut l'historique CPU de niveau 1000 (Memory.history, créé après ~1100 ticks, utils/stats.ts:44-64)
Memory.hivemind.canExpand = false                         // :98
if (!memory.currentTarget && mayExpand()) {               // :99
  Memory.hivemind.canExpand = true                        // => process toutes les 5 ticks tant qu'on cherche
  chooseNewExpansionTarget()
}
manageCurrentExpansion()                                  // §5
abandonWeakRooms(); abandonStripmines(); manageEvacuation()   // hors périmètre (évacuation, §9)
cleanupMemory()                                           // toutes les 5000 ticks : purge des échecs > 1 000 000 ticks (:700-711)
```
Pendant une expansion en cours, `canExpand` reste faux ⇒ **la gestion de l'expansion ne tourne que toutes les 50 ticks**.

Réglages (`settings.default.ts:109-121`) : `expansionScoreCacheDuration: 20_000`, `minOwnedRooms: 1`, `maxOwnedRooms: null`, `maxExpansionCpuPerTick: 30`, `expansionScoreBonusHighwayExit: 0`, `expansionMinRoomDistance: 0`, `expansionMaxRoomDistance: 3`. Scout : `roomScoutInterval: 5000`, `maxScoutDistance` défaut 7 (`Memory.hivemind.maxScoutDistance`, réduit si la mémoire déborde, `main.ts:290-301`).

---

## 2. Quand expanser — `mayExpand()` (`process/strategy/expand.ts:125-138`)

```ts
getCpuStats():                                                        // :112-123
  harvestRooms = Memory.strategy.remoteHarvesting?.currentCount ?? 0
  cpuLimit = harvestRooms < 5 ? 0.8 : 1
  shortTerm = stats.getStat('cpu_total', 1000) / Game.cpu.limit
  longTerm  = stats.getStat('cpu_total', 10000) ? stats.getStat('cpu_total', 10000) / Game.cpu.limit : shortTerm

mayExpand():
  ownedRooms = interShard.getTotalOwnedRooms()                        // rooms de ce shard + shards reliés par portails (intershard.ts:101-121)
  hasFreeControlLevels = ownedRooms < Game.gcl.level
  mayHaveMoreRooms = !maxOwnedRooms (null) || info.ownedRooms < maxOwnedRooms
  return hasFreeControlLevels && mayHaveMoreRooms && shortTerm < cpuLimit && longTerm < cpuLimit
```
- **Aucune condition d'énergie, de RCL ou de storage ici** : elles viennent de `shardHasEstablishedRooms` (RCL ≥ 4, §1), de `findClosestSpawn` (RCL ≥ 5, §3.4) et du spawn du squad (≥ 5000 d'énergie effective, §4.2).
- Quirk : avec une seule room et `Game.cpu.limit ≥ 20`, `remoteHarvesting.currentCount` est forcé à 20 (`process/strategy/mining.ts:72-76`) ⇒ `cpuLimit = 1` (CPU moyen < 100 % de la limite suffit).
- `getStat(key, 1000)` = moyenne glissante sur ~1000 ticks (`utils/stats.ts:78-…`).

---

## 3. Choix de la room cible

### 3.1 Liste des candidates — `room/room-status.ts:76-80`
```ts
getPotentialExpansionTargets() = cache heap 1000 ticks :
  rooms de Memory.strategy.roomList dont expansionScore !== null && !Game.rooms[r]?.isMine()
```
`expansionScore` n'est posé que par le ScoutProcess (`process/strategy/scout.ts:121-149`) :
```ts
calculateRoomPriorities(room):
  resetScores(room)                                  // efface scout/harvest/expansion
  range = getDistanceToOrigin(room)                  // flood par sorties depuis les rooms possédées (cf. hivemind-remote.md §2.1)
  if (range === 0 && intel.isClaimable()) setExpansionScore(calculateExpansionScore(room))   // rooms possédées (pour worstRoom, évacuation)
  if (range > 0 && range <= maxScoutDistance (7)):
    if (intel.getAge() > 5000) scoutPriority = 1
    if (intel.lastScan > 0):
      harvestPriority = calculateHarvestScore(room)
      setExpansionScore(calculateExpansionScore(room))
```
⇒ candidates = rooms **déjà visitées** à ≤ 7 rooms (par sorties) d'une room possédée. Une room jamais vue n'a pas de score.

### 3.2 Score d'expansion — `calculateExpansionScore` (`process/strategy/scout.ts:222-361`)

Cache heap par room `expansionScoreCache[room] = [score, time, reasons]`, valide `expansionScoreCacheDuration = 20 000` ticks (`:371-395`). Le score n'est donc recalculé qu'une fois toutes les 20 000 ticks par room (tant que le heap vit).

```ts
score = 0
if (Game.map.getRoomStatus(room).status === 'closed') return 0                      // :237-241
if (!intel.isClaimable()) return 0              // isClaimable = memory.hasController (room-intel.ts:637-642) ; SK/highway → 0
// NB : une room possédée/réservée par un autre n'est PAS exclue ici (exclue au choix, §3.3)

score += 2 * nbSources - 2                                                           // :250 (1 source → 0, 2 → 2)
for mineralType of intel.getMineralTypes():                                          // :254-259
  score += 1 / (mineralCount[mineralType] + (isMyRoom ? 0 : 1))                      // mineralCount = nb de mes rooms ayant ce minerai (:636-643)

// Rooms de remote autour (range 1 et 2)                                             // :262-282
influence = {}
for adj of exits(room): influence[adj] = 1 ; hasHighwayExit ||= adj finit par '0' ou adj.slice(2) commence par '0'
  for r2 of exits(adj): influence[r2] = 0.5           // ÉCRASE un éventuel 1 (quirk) ; exits(adj) inconnues si adj jamais visitée
for r in influence (r !== room): score += influence[r] * getHarvestRoomScore(r)
if (hasHighwayExit) score += expansionScoreBonusHighwayExit (0)

// Interaction avec mes autres rooms possédées (visibles)                           // :289-326
for other of mes rooms (≠ room) avec d = linearDistance(room, other) ≤ 3:
  normal = intel(other).calculateAdjacentRoomSafety()
  adjusted = intel(other).calculateAdjacentRoomSafety(isMyRoom ? {unsafe:[room]} : {safe:[room]})
  newSafeExits = |Σ adjusted.directions − Σ normal.directions|                        // quirk : cache 'adjacentSafety:<other>' 100 ticks SANS les options (room-intel.ts:918-919) ⇒ quasi toujours 0
  score += newSafeExits * 0.25
  score += countTiles(other,'exit') * 0.005 * (newSafeExits / nbExits(other))
  if (d > 2) continue
  for adj of exits(other):                                                            // remotes partagés
    if (adj === room) score -= getHarvestRoomScore(adj)
    for e of exits(room): if (e === adj) score -= getHarvestRoomScore(adj)
  if (d > 1) continue
  if (exits(room) contient other) score -= getHarvestRoomScore(room)                   // voisin direct : on perd la room comme remote

// Défendabilité de la room elle-même                                                  // :328-340
safety = intel.calculateAdjacentRoomSafety()           // directions N/E/S/W sûres (impasse à ≤ 3 rooms ou mes rooms solides)
score += Σ safety.directions (nb de true) * 0.25
unsafeRatio = (4 − Σ safety.directions) / nbExits(room)
score += 1 − countTiles('exit') * 0.005 * unsafeRatio  // exit = cases non-mur du bord
score += 0.5 − countTiles('wall') * 0.0002              // intérieur (x,y ∈ 1..48)
score += 0.25 − countTiles('swamp') * 0.0001

// Distance à mes rooms                                                                 // :342-356
if (j'ai d'autres rooms):
  dMin = min linearDistance(room, mes rooms ≠ room)
  if (dMin < expansionMinRoomDistance (0)) score += dMin − 0          // jamais
  if (dMin > expansionMaxRoomDistance (3)) score −= dMin − 3
```

`getHarvestRoomScore(r, forOwnedRoom = false)` (`:407-438`) :
```ts
if (isHighway(r)) return 0
if (Game.rooms[r]?.isMine()) return 0
sourceFactor = intel.isSourceKeeperRoom() ? 0.15 : 0.25        // SK = pas de contrôleur mais des sources
if (intel.isOwned() && owner !== 'Invader') return -0.5         // proche d'un autre joueur
if (intel.isClaimed() && reservation.username !== 'Invader') sourceFactor = 0.1   // réservée par un autre
return nbSources * sourceFactor
```

`calculateAdjacentRoomSafety()` (`room-intel.ts:918-1008`, détails `:1020-1089`) : cache heap 100 ticks. Sans `memory.exits` → toutes directions non sûres. Pour chaque sortie, parcours en largeur des rooms « potentiellement dangereuses » (toute room sauf mes rooms avec `level >= min(5, rcl(room) − 1)`, non évacuées, et la room elle-même) : une direction devient non sûre si une room du parcours n'a pas d'intel (`getAge() > 100 000`) ou a encore des sorties à range ≥ 3 ; les directions qui se rejoignent sont unifiées (ET logique).

Intel requis (`room-intel.ts:189-283`) : `hasController`, `owner`, `rcl`, `reservation {username, ticksToEnd}`, `sources[{x,y,id,free}]`, `minerals[{type,…}]`, `terrain {exit, wall, swamp, plain}`, `exits`, position du contrôleur (pour le planner), `lastScan`. **Les sorties des rooms voisines (range 1-3 autour de la candidate) doivent être connues**, sinon directions non sûres et termes de remote manquants.

Ordre de grandeur (2 sources, 1 minerai neuf, 3 voisines à 2 sources neutres, room à distance 2) : 2 + 1 + ~1.5 + 0..1 (sûreté) + ~0.6 (exits) + ~0.3 (murs) + ~0.15 (marais) ≈ 5-6.

### 3.3 Sélection — `chooseNewExpansionTarget` (`process/strategy/expand.ts:143-202`)
```ts
if (!segmentMemory.isReady()) return
reprend expansionTargetScoringProgress (heap : rooms déjà vues + meilleur courant) — reprise sur plusieurs ticks
for room of getPotentialExpansionTargets():
  if (expansionRoomFilter && !filter(room)) { marquer; continue }
  if (cpuUsed − start ≥ maxExpansionCpuPerTick (30)) return          // suspendu, reprise au run suivant (5 ticks)
  if (déjà marquée) continue
  if (intel.isOwned()) continue                                       // possédée par un autre joueur : jamais (non marquée !)
  marquer
  score = roomStatus.getExpansionScore(room) || 0 ; if (score === 0) continue
  mod = getModifiedExpansionScore(room, score)
  if (best && modBest >= mod) continue
  if (Game.rooms[room]?.isMine()) continue
  spawn = findClosestSpawn(room) ; if (!spawn) continue               // §3.4
  best = {spawnRoom: spawn, roomName: room, expansionScore: score}
if (best) { expansionTargetScoringProgress = null; startExpansion(best) }
```
- **Rooms réservées par un autre joueur : candidates normales** (les squads attaquent la réservation, §5.1). Rooms possédées par un autre : exclues (et pathées avec coût ×5 / interdites par le navmesh).
- Pas de seuil minimal de score (> 0 suffit, un score négatif est accepté s'il est le meilleur… sauf exactement 0).

Pénalité d'échecs — `getModifiedExpansionScore` (`:210-225`) :
```ts
for f of memory.failedExpansions:
  elapsed = Game.time − f.time ; if (elapsed > 1 000 000) continue
  m = elapsed > 100 000 ? 1 − (elapsed − 100 000) / 900 000 : 1
  d = linearDistance(room, f.roomName)
  if (d === 0) score −= m ; else if (d < 6) score −= m / (d + 1)
```

### 3.4 Room d'origine — `findClosestSpawn(target)` (`:559-577`)
```ts
for room of Game.myRooms:
  if (room.controller.level < 5) continue                 // ⚠ RCL ≥ 5 obligatoire
  if (room.name === target) continue
  if (aucun STRUCTURE_SPAWN) continue
  path = cache heap 1000 ticks 'spawnPath:<target>:<room>' = navMesh.findPath(center(room), center(target), {maxPathLength: 500})
  if (!path || path.incomplete) continue
  garder le path.path.length minimal
```
NavMesh (`utils/nav-mesh.ts:436-586, 670-692`) : saute les rooms possédées par un non-allié (sauf `allowDanger`), coût ×1.5 pour une room réservée par un autre (hors Invader), ×1.2 SK, ×2 si `Memory.rooms[r].enemies` non sûrs ; `pathLength` pondéré limité à 500 ; CPU max 5 par recherche. Notre équivalent : `Game.map.findRoute` avec les mêmes coûts + longueur de chemin approximative (50 par room).

---

## 4. Squads

### 4.1 Mémoire et API — `squad.ts`, `manager.squad.ts`
`Memory.squads[name] = {composition: {unitType: count}, spawnRoom?, targetPos? (position encodée)}` (`squad.ts:11-16, 29-43`). `setUnitCount`, `clearUnits` (composition = {}), `setSpawn`, `setTarget(pos | null)`, `disband()` = clearUnits + spawn null + target null (**la mémoire du squad n'est pas supprimée, les creeps ne sont pas recyclés**, `:117-122`). `getOrders()` = `[{priority 5, weight 0, target: targetPos}]` si target (`:130-141`). `getAllSquads()` cache 1 tick (`manager.squad.ts:38-47`).

Comptage des unités vivantes : `Game.creepsBySquad[squadName][squadUnitType || role]` (`prototype/creep.ts:149-158`) — **un builder converti en `builder.remote` garde `squadName`/`squadUnitType` et compte toujours** ⇒ le squad ne le remplace qu'à sa mort.

### 4.2 Spawn-role `squad` — `spawn-role/squad.ts:44-92`
```ts
cacheEmptySpawnOptionsFor(room, 10, () =>
  for squad of getAllSquads() with squad.getSpawn() === room.name:
    energy = room.getEffectiveAvailableEnergy()        // storage + terminal + tas au centre + containers de harvest (cf. hivemind-spawning.md §6.3)
    if (energy < 5000) continue
    unit = needsSpawning(room, squad)                  // _.sample() parmi les types dont composition[type] > nb vivants
    if (!unit) continue
    options.push({priority: energy > 10 000 ? 4 : 2, weight: 1.1, unitType: unit, squad: name})
)
getCreepMemory = {role: 'brawler', squadName, squadUnitType: unit}            // :202-208 — TOUTES les unités ont le rôle brawler
```
Une option par squad et par tick ; le type est **tiré au hasard** parmi les manquants (pas d'ordre claim → builders).

Corps (`:105-189`, simulés avec notre `buildBody`, énergie pleine ; limite `min(cap, max(0.9·cap, energyAvailable))` sauf singleClaim = `cap`) :

| Unité | Poids / options | 1300 (RCL4) | 1800 (RCL5) | 2300 (RCL6) |
|---|---|---|---|---|
| `brawler` (défaut si méthode absente) | ATTACK 3, HEAL 2, `moveBufferRatio 0.4`, PLAINS | 4A 2H 6M (1120) | 5A 3H 8M (1550) | 7A 4H 11M (2110) |
| `singleClaim` | CLAIM 1, limite CLAIM 1, **SWAMP** | 1K 5M (850) | 1K 5M | 1K 5M |
| `claimer` (contre réservation ennemie) | CLAIM 3, TOUGH 2, PLAINS | 1T 1K 2M (710) | 2T 2K 4M (1420) | 2T 3K 5M (2070) |
| `builder` | CARRY 3, WORK 2, PLAINS | 7C 4W 11M (1300) | 9C 6W 15M (1800) | 11C 8W 19M (2300) |

(singleClaim : rien sous 850 de capacité ; claimer : rien sous 710.)

### 4.3 Comportement des unités — `role/brawler.ts`
- `initBrawlerState` (`:114-129`) : unité `builder` → `memory.fillWithEnergy = true`.
- Remplissage (`:351-363`) : dans une room à moi, non plein : si énergie effective < 3000 → attendre à portée 5 du centre (**bloqué tant que < 3000**) ; sinon `transporterRole.performGetEnergy` (dispatcher de sources). Plein ou hors de mes rooms → `fillWithEnergy` supprimé.
- Déplacement (`:365-405`, `performSquadMove :568-604`) : `memory.target = squad.getOrders()[0].target` ; squads `expand*` → `allowDanger = false` (évitent les rooms dangereuses). Les unités de combat interrompent le trajet si un ennemi **joueur** dangereux est dans la room (kiting). Sans target (squad dissous) : dans la room de spawn, `renewCreep` si TTL < 990 (0.66 × 1500), sinon attendre au centre.
- Arrivée dans la room cible (`militaryRoomReached :612-620`) : unité `builder` et la room a un contrôleur → **`role = 'builder.remote'`, `target = pos actuelle`, `singleRoom = room`** (garde `squadName`).
- Cibles (`getAvailableMilitaryTargets :168-218`, seulement dans la room de la target) : ennemis (prio 4 dangereux / 1 inoffensifs, poids `1 − range/50`), structures hostiles (hors room possédée : seulement invader cores ; prio 5 si sous la target, 4 spawn, 3 tour, 2 autre), soins (prio 3), contrôleur pour une unité CLAIM : prio 5 s'il a un propriétaire (autre), prio 4 s'il n'en a pas. Unité CLAIM d'un squad `expand*` sans aucune option (room déjà à moi) → `performRecycle` (`role/role.ts:94-…` : retour au spawn le plus proche par chemin, sinon suicide).
- Action contrôleur (`run :98-103` + `attackMilitaryTarget :690-715`) :
  ```ts
  if (controller.owner && attackController OK) return
  if (squadName && squad.targetPos est EXACTEMENT sur le contrôleur):
    if (reservation par un autre) attackController
    else claimController
  else if (!squadName) reserveController
  ```
  ⇒ **Le claim n'a lieu qu'une fois que l'ExpandProcess a déplacé la target du squad sur `controller.pos`** (fait quand la room est visible, §5.1 — jusqu'à 50 ticks de latence). Pas de repli « reserve » si la GCL manque (contrairement à `role/claimer.ts`).
- `role/claimer.ts` mission `claim` (`:76-97`) : `whenInRange(1, controller)` ; contrôleur possédé ou réservé par un autre → `attackController` ; sinon `claimController` si `myRooms < gcl`, sinon `reserveController`. **Aucun spawn-role ne crée de claimer `mission: 'claim'`** (seul `reserve` est utilisé, `spawn-role/remote-mining.ts:572`) : code mort, utile comme modèle simple.

---

## 5. Gestion de l'expansion en cours

### 5.1 `startExpansion` et `manageCurrentExpansion` (`process/strategy/expand.ts:233-314`)
```ts
startExpansion(info):                                            // :233-251
  memory.currentTarget = info ; manageStripmines (no-op, maxMines = 0)
  squad 'expand' : setSpawn(info.spawnRoom), setTarget(RoomPosition(25,25,cible)), clearUnits,
                   brawler: 1, singleClaim: 1, builder: 2
  memory.started = Game.time

manageCurrentExpansion():                                        // toutes les 50 ticks
  manageExpansionSupport()                                       // §5.3
  checkAccessPath()                                              // §5.2
  if (cible visible):
    squad.setTarget(room.controller.pos)
    if (controller.my):
      if (!memory.claimed) { memory.claimed = Game.time ; singleClaim = 0 ; claimer = 0 }
      if (controller.level > 3 && room.storage) { stopExpansion() ; return }       // SUCCÈS : RCL ≥ 4 + storage
    else:
      if (reservation par un autre && ticksToEnd > 100) { singleClaim = 0 ; claimer = ceil(ticksToEnd / 2000) }
      else { singleClaim = 1 ; claimer = 0 }
      checkClaimPath()                                           // tunnels (optionnel, §5.4)
  if (hasExpansionFailed()) { recordFailedExpansion() ; stopExpansion() }
```
Le brawler (1) et les 2 builders restent dans la composition **jusqu'au succès** : ils sont respawnés à leur mort pendant toute l'expansion (jusqu'à ~30 000 ticks).

`hasExpansionFailed` (`:319-334`) :
- pas claimée et `Game.time − started > 5 × 1500 = 7500` ;
- claimée et `Game.time − claimed > 20 × 1500 = 30 000` (la room est alors laissée à elle-même, comptée comme échec) ;
- claimée et (room invisible ou `!controller.my`).

`recordFailedExpansion` → `failedExpansions.push({roomName, time})` (`:339-349`). `stopExpansion` (`:354-371`) : dissout `expand` et `expandSupport.<cible>*`, supprime `currentTarget`, `started`, `claimed`, `pathBlocked`. Les `builder.remote` déjà convertis restent dans la room (`singleRoom`) jusqu'à leur mort.

### 5.2 Chemin d'accès — `checkAccessPath` (`:517-548`)
```ts
if (spawnRoom visible):
  path = navMesh.findPath(center(spawnRoom), center(cible), {maxPathLength: 500})   // non caché
  incomplet → pathBlocked ||= Game.time ; sinon delete pathBlocked
if (!spawnRoom visible || (pathBlocked && Game.time − pathBlocked > 7500)):
  newOrigin = findClosestSpawn(cible) ; si trouvé → info.spawnRoom = squad.spawn = newOrigin
  sinon stopExpansion()                       // sans enregistrer d'échec
```

### 5.3 Soutien — `manageExpansionSupport` (`:376-419`)
```ts
info.supportingRooms = []
for room of Game.myRooms (ordre de Game.myRooms, pas de tri par distance):
  if (squads actifs ≥ 5) break
  if (room.controller.level < 4 || aucun spawn || room ∈ {spawnRoom, cible} || effectiveEnergy < 50 000) continue
  path = cache heap 2000 'spawnAssistPath:<cible>:<room>' = navMesh(center(room) → center(cible), maxPathLength 700) ; incomplet → continue
  squad 'expandSupport.<cible>.<room>' : spawn room, target (25,25,cible), clearUnits, builder: 1
  if (Math.random() < 0.05 && !claimed) singleClaim: 1        // 5 % par run tant que non claimée
dissoudre tout 'expandSupport.*' non actif
```
Avec une seule room existante (la nôtre est la room d'origine), **aucun soutien** : seulement le squad `expand`.

### 5.4 Tunnels — `checkClaimPath` (`:424-512`) [optionnel]
Pour chaque creep à moi dans la cible : PathFinder vers le contrôleur (range 1, murs 255, plaine/marais 1, routes et chantiers de route 1, structures non franchissables 255). Si aucun creep ne l'atteint : recherche autorisant les murs naturels (coût 50) et pose des chantiers `STRUCTURE_ROAD` sur les cases mur du chemin (tunnels). Un seul chemin.

### 5.5 Room planner et manager de la cible — `process/rooms.ts:88-125`
Chaque tick, si `currentTarget` : `new RoomPlanner(cible).runLogic()` (plan généré depuis le terrain + intel, **avant même le claim** ; throttle interne 100 ticks, rien si bucket < 3500, `room/planner/room-planner.ts:99-111`). Si la cible est visible : `RoomManager` en process `<room>_manager`, intervalle `runNextTick ? 0 : (needsReclaiming ? 20 : 100)`.

Room manager d'une room de RCL 0/1 (cf. `hivemind-construction.md` §1) — `room/room-manager.ts:356-389, 451-466` :
- RCL 0 (pas encore claimée) : `manageSpawns` (quota 0), puis routes planifiées `road.source` et `road.controller` sur marais, puis **toutes** les routes planifiées (« on s'occupe en attendant le claim ») — max 5 chantiers (`canCreateConstructionSites`).
- RCL 1 : `manageSpawns` → chantier sur l'emplacement planifié `spawn.0` (puis `spawn`) ; rien d'autre (RCL < 2).
- RCL ≥ 2 : programme normal (extensions, containers, …).
- Cas « room qui récupère » (`isRoomRecovering :199-206`) : pas de spawn **et** RCL ≥ 3 (ou `needsReclaiming`, sauf safe mode > 5000) → `buildRoomDefenseFirst` (`:208-233`) : tours + remparts d'abord, et le spawn seulement si `checkWallIntegrity(10 000)` ; tant qu'il n'y a pas de spawn, rien d'autre n'est construit. ⇒ **si le spawn n'est pas fini avant RCL3, les tours/remparts passent avant lui.**
- Aucun ancrage sur un spawn existant (il n'y en a pas) : la position du spawn = plan.

### 5.6 Mémoire
```ts
Memory.strategy.expand = {
  currentTarget?: {roomName, spawnRoom, expansionScore, supportingRooms: string[]},
  started?: number, claimed?: number, pathBlocked?: number,
  failedExpansions?: Array<{roomName, time}>,         // purgés après 1 000 000 ticks
  evacuatingRoom?: {name?, cooldown}                  // évacuation (hors périmètre)
}
Memory.hivemind.canExpand: boolean
Memory.squads['expand' | 'expandSupport.<cible>.<room>'] = {composition, spawnRoom, targetPos}
Memory.strategy.roomList[room].expansionScore        // + heap : expansionScoreCache (20 000), expansionTargetScoringProgress, RoomStatus.expansionTargets (1000)
```

---

## 6. Bootstrap de la nouvelle room — `role/builder.remote.ts`

Les 2 builders du squad (+ 1 par room de soutien) deviennent `builder.remote` à l'arrivée (§4.3) et forment toute la main-d'œuvre jusqu'au premier spawn ; ils continuent ensuite jusqu'à leur mort et sont respawnés par le squad jusqu'au succès (RCL4 + storage). `stopAt = throttleAt = 0` (jamais throttlés).

```ts
run(creep):                                                               // :53-106
  if (memory.targetRoom) { interRoomTravel(25,25,targetRoom) ; à l'arrivée singleRoom = targetRoom }   // creeps du reclaim
  hystérésis : building && énergie 0 → false ; !building && plein → true   // setBuilderState efface buildTarget/repairTarget/resourceTarget/extraEnergyTarget/upgrading
  if (extraEnergyTarget) collectExtraEnergy()
  else if (sourceRoom) retour dans sourceRoom (puis singleRoom = sourceRoom)
  else if (upgrading) performControllerUpgrade()        // whenInRange(3, controller) ; stop si level 0 / pas à moi / upgradeBlocked
  else if (building) performRemoteBuild()
  else performGetRemoteBuilderEnergy()
```

`performRemoteBuild` (`:127-199`), ordre exact :
1. Room à moi, upgrade possible et (`level < 2` **ou** `ticksToDowngrade < 500`) → `upgrading = true` ⇒ **à RCL1 les builders montent d'abord le contrôleur en RCL2** (le spawn attend !).
2. Room `needsReclaiming()` et `level < 4` → upgrade.
3. `progress > progressTotal` (contrôleur rétrogradé à restaurer) et aucun upgrader ni builder.remote en upgrade → upgrade.
4. Spawn (à moi/allié) < 80 % d'énergie → le remplir (si pas de cible en cours, ou spawn à < 5).
5. Tour à moi avec > 50 % de capacité libre → la remplir.
6. Si la cible n'est pas un chantier spawn/tour : `saveExpiringRamparts(10 000)` (remparts < min(10 000, hitsMax), spawns/tours abîmés ; réparation jusqu'à `max(minHits×1.1, RCL<6 ? 15 000 : 550 000, …)`, 15 000 si safe mode > 5000).
7. Sans cible : `determineBuildTarget` (`:271-311`) : **chantier de tour > chantier de spawn > chantier le plus proche par chemin** ; RCL ≥ 6 : remparts < 500 000. Toujours rien : remparts si reclaim, sinon upgrade (room à moi) ou attendre à portée 4 du contrôleur (room non claimée).
8. `whenInRange(3, site, build)`.

`performGetRemoteBuilderEnergy` (`:328-405`) :
```ts
hors de la room de memory.target → moveToRange(target, 5)
un creep m'apporte de l'énergie (ordre 'workerCreep' sur moi) → aller à portée 1 de lui
tas d'énergie (> 30 % de ma capacité, ou ≤ 1 case et > 20) le plus proche par chemin → pickup
storage > 5000 → withdraw
container (> 500 énergie) le plus proche par chemin, si room à moi ou sans safe mode → withdraw
source active la plus proche par chemin, si room à moi ou non réservée ou réservée par moi → resourceTarget (harvest jusqu'à plein)
sinon setExtraEnergyTarget() (sources des rooms adjacentes sans ennemis, non claimées, sans keeper, navmesh ≤ 100 → une au hasard)
      + transporterRole.performGetEnergy (dispatcher)
```
Les builders récoltent donc eux-mêmes (corps 9C6W15M à RCL5 : 12 énergie/tick de récolte).

Une fois le spawn construit, la nouvelle room tourne son économie normale (`hivemind-spawning.md`) ; les `builder.remote` présents (`room.creepsByRole` = par room **courante**) :
- réduisent le quota de transporters de 1 chacun (`spawn-role/transporter.ts:141-142`) et comptent comme « builders » (`:40`) ;
- sont des destinations `workerCreep` prioritaires (poids 2 vs builder 1.5, upgrader 0.5 ; prio `2 − 3 × livreurs déjà assignés`), tant qu'il n'y a ni storage ni terminal (`dispatcher/resource-destination/worker-creep.ts:28-66`) ;
- reçoivent l'énergie des harvesters voisins (`role/harvester.ts:299`).

Il n'existe **aucun hauler ni transfert d'énergie depuis la room mère** avant les terminaux : l'aide = builders qui partent pleins (remplis au storage de la room mère, §4.3) puis récoltent sur place.

---

## 7. Reclaim (room possédée sans spawn) — `reclaim-manager.ts`, `spawn-role/reclaim.ts`

Mécanisme générique d'aide pour une room **déjà à moi** qui a perdu (ou jamais eu) son spawn, **hors expansion en cours**.

```ts
ReclaimProcess (/100, rooms établies) : pour chaque room à moi → updateReclaimStatus           // process/strategy/reclaim.ts:17-29
needsToReclaim(room) = myRooms.length > 1 && aucun spawn à moi && room ≠ expand.currentTarget    // reclaim-manager.ts:23-41
  oui → isReclaimableSince ||= Game.time ; remis à Game.time si pas de tour, safe mode ≤ 3000 et un ennemi
        non allié avec (RANGED×10 + HEAL×5×12) ≥ 10×10 + 5×5×12 = 400                          // :43-67
  non et hasJustFinishedReclaiming (spawn + ≥ 1 tour + checkWallIntegrity) → delete isReclaimableSince   // :69-82
needsReclaiming() = !!isReclaimableSince ; isSafeForReclaiming() = Game.time − since > 2000 || safeMode > 2000   // :96-107
```
Spawn-role `reclaim` (dans chaque autre room) : cache vide 100 ticks ; requiert `effectiveEnergy ≥ 10 000` et `Game.cpu.bucket ≥ 8000` ; pour chaque room cible `needsReclaiming && isSafeForReclaiming && roomPlanner` avec ≤ 5 `builder.remote` (targetRoom ou singleRoom) et un chemin navmesh centre→centre ≤ 700 (cache 100) → option **prio 3, poids 1**, corps CARRY 3 / WORK 2 (comme le builder de squad), mémoire `{role: 'builder.remote', targetRoom}` (`spawn-role/reclaim.ts:24-69, 145-174`).
Spawn-role `brawler` (`spawn-role/brawler.ts:271-305`) : même condition (≥ 10 000) → brawler `RESPONSE_BLINKY` **prio 4, poids 0** vers le centre planifié de la cible, max 4 (> 3 refusé).

Pour une expansion : le reclaim ne prend le relais qu'après `stopExpansion` si la room n'a toujours pas de spawn (ex. échec à 30 000 ticks), ou si le spawn est détruit plus tard.

---

## 8. Interactions avec le minage distant et le scoutage

- **La cible peut être un de nos remotes** (rien ne l'exclut). Avant le claim, notre réservation n'empêche pas `claimController` ; l'opération `mine:<cible>` continue jusqu'au claim. Après : `getRemoteHarvestRooms` ignore les rooms `isMine()` (`empire/remote-mine-prioritizer.ts:123`) → l'opération est terminée au run suivant du mining (20 ticks avec 1 room, 100 avec ≥ 2) (`process/strategy/mining.ts:107-122`) ; les HR restants deviennent inactifs (quirk `hivemind-remote.md` §12.11) ; les sources des opérations ignorent les positions dans une room à moi (`operation/remote-mining.ts:251, 267, 284, 532, 570`).
- **Capacité de remote de la room mère** : `max = floor(5 × spawns − roomNeeds)` avec `roomNeeds` = 1 (RCL ≥ 4) + 1 (RCL ≥ 6) + **nombre de squads dont `spawn` = cette room** (`remote-mine-prioritizer.ts:75-114`) ⇒ le squad `expand` coûte un remote pendant toute l'expansion (un squad dissous a `spawn = null` et ne compte plus).
- **Remotes de la nouvelle room** : une room sans spawn opérationnel n'est source de remote que si RCL 4-6 (`:80-90`) ⇒ rien avant son premier spawn. Ensuite, le flood du scout lui donne `range 0` (origine) ; le `RemotePathManager` choisit, parmi mes rooms à ≤ 3 de distance linéaire ayant un plan, celle dont le chemin source → storage planifié est le plus court (`empire/remote-path-manager.ts:25-63`, cache 5000 ticks ⇒ réattribution différée jusqu'à 5000 ticks) ; la `sourceRoom` d'une source = room de fin du chemin (`operation/remote-mining.ts:148`).
- **Score d'expansion et remotes** : bonus pour les sources des rooms à 1-2 sorties, malus pour les remotes partagés avec une room à moi à ≤ 2 et pour une cible voisine directe (§3.2).
- **Scoutage requis** : intel (§3.2) des candidates **et de leurs voisines jusqu'à 3 rooms** (sûreté des sorties), rafraîchie toutes les 5000 ticks ; navmesh des rooms traversées (sinon pas de chemin, `findPath` incomplet). Le flood s'étend jusqu'à `maxScoutDistance = 7` rooms.

---

## 9. Hors périmètre (résumé)

- **Évacuation / abandon** (`abandonWeakRooms :582-622`, `manageEvacuation :649-698`) : seulement avec > `minOwnedRooms` (1) rooms, CPU dépassé ou trop de rooms, et une meilleure expansion (écart de score ≥ 0.5) ; vide storage/terminal puis `unclaim`, cooldown 5000 ticks.
- **Stripmines** : désactivés (`maxMines = 0`, `:254`).
- **Intershard** (`process/strategy/intershard.ts:83-85, 306-382`) : expansions par portail, squads `singleClaim` — ignoré.
- **Aide en énergie par terminal — PLUS TARD (RCL6)** : `empire.resources` (/5) transfère via `TradeRouteManager.getAvailableTransportRoutes` (`process/resources.ts:16-60`) ; `FunnelManager` (/500, `empire/funnel-manager.ts:19-60`) concentre l'énergie vers des rooms RCL6-7 ; `mule` (trade routes, nécessite storage). Aucune aide d'énergie inter-rooms sans terminal hormis les builders.

---

## 10. Priorités de spawn (convention Hivemind : priorité la plus haute, puis poids)

| Option | Room qui spawne | priority | weight | Condition |
|---|---|---|---|---|
| Unité de squad `expand` / `expandSupport` (brawler, singleClaim, claimer, builder — type tiré au hasard) | room d'origine (RCL ≥ 5) / rooms de soutien (RCL ≥ 4) | **4** si énergie effective > 10 000, **2** si 5000-10 000 | 1.1 | énergie effective ≥ 5000 |
| `reclaim` → builder.remote | toute autre room | 3 | 1 | ≥ 10 000 énergie, bucket ≥ 8000, cible sans spawn depuis > 2000 ticks |
| brawler de reclaim (BLINKY) | toute autre room | 4 | 0 | ≥ 10 000 énergie |
| Économie (rappel `hivemind-spawning.md` §0) | | harvester 4-6, transporter 3-6, builder 3-4 (0.5), upgrader 3/5 (1), brawler défense 5 (1), scout 4 (1) / 1 (0) | | |
| Remote (rappel `hivemind-remote.md` §6.7) | | hauler/builder/harvester/claimer 3, premier harvester 1 | | |

Lecture : avec > 10 000 d'énergie, un squad à 4 (poids 1.1) **bat** builders (4, 0.5), transporters à 4 (0-0.5), harvesters avec storage (4, < 1), scout (4, 1) et tout le remote (3) ; il **perd** contre les urgences à 5-6 (harvester initial, premier transporter, upgrader en downgrade, défense). Entre 5000 et 10 000 (prio 2) il ne passe qu'après toute l'économie et le remote (mais avant le premier harvester de remote à 1).

---

## 11. Points d'attention pour le portage

1. **Gate RCL** : Hivemind exige une room RCL ≥ 4 pour lancer le process et une room d'origine RCL ≥ 5 avec spawn ; `singleClaim` = 850 d'énergie (RCL4 minimum). Notre `ExpansionManager` actuel (`MIN_RCL` + storage, GCL ≥ 2) est proche ; décider explicitement si l'on garde RCL5 (fidèle) ou RCL4 + storage (mesurer).
2. **Énergie** : squad seulement avec énergie effective ≥ 5000 (prio 2) / > 10 000 (prio 4) ; les builders attendent ≥ 3000 dans la room mère pour se remplir. Notre `roomState.effectiveEnergy` est l'équivalent.
3. **CPU** : `cpu_total` moyen sur 1000 et 10 000 ticks < 80 % de `Game.cpu.limit` (100 % avec ≥ 5 remotes ou une seule room, quirk). Utiliser `Memory.stats` (moyenne glissante) ; ne rien décider avant ~1100 ticks d'historique.
4. **Squads → `requestSpawn`** : pas besoin du système de squads générique ; une composition `{brawler:1, singleClaim:1, builder:2}` comptée par `memory.squad` + `memory.unit` (garder le compteur après conversion en builder.remote), spawn dans la room d'origine. Reproduire le tirage aléatoire ou (mieux, écart à mesurer) un ordre fixe claim → builders → brawler.
5. **Claim seulement quand la target est sur le contrôleur** : chez nous, claimer directement à l'arrivée (pas de latence de 50 ticks) ; garder `attackController` si réservation ennemie et le repli `reserveController` du `role/claimer.ts` si la GCL manque.
6. **Brawler permanent** pendant toute l'expansion : coûteux (1120-1550 d'énergie toutes les 1500 ticks, jusqu'à 30 000 ticks). Optionnel si la cible est neutre et calme ; le garder si `Memory.rooms[cible].enemies` signale des hostiles.
7. **Builders à RCL1 upgradent d'abord** jusqu'à RCL2 avant de construire le spawn (règle 1 de §6) : fidèle mais lent ; à mesurer contre « spawn d'abord ».
8. **Spawn de la nouvelle room** : chantier sur `spawn.0` du plan, plan calculé avant le claim depuis l'intel (contrôleur, sources) — notre `RoomPlanner` doit pouvoir planifier une room non possédée (centre = meilleur candidat, pas de spawn existant). Notre `RoomBuilder` limite à 5 chantiers : OK. Attention au cas RCL ≥ 3 sans spawn (tours/remparts avant le spawn).
9. **Fin de l'aide** : RCL ≥ 4 + storage (succès) ou 30 000 ticks après le claim ; échec si pas claimée en 7500 ticks → pénalité de score sur la cible et ses voisines (< 6 rooms) pendant 100 000 ticks puis décroissance jusqu'à 1 000 000.
10. **Remotes** : retirer la cible de nos remotes au claim (et recycler les remote harvesters/haulers/reservers), réduire de 1 le quota de remotes de la room mère pendant l'expansion, ne donner des remotes à la nouvelle room qu'une fois son spawn construit ; recalculer les chemins des remotes (notre cache 5000) pour réattribuer les sources plus proches de la nouvelle room.
11. **Intel** : il faut `exits`, `terrain {exit, wall, swamp}`, `minerals`, `owner`, `reservation`, `hasController` pour les rooms jusqu'à ~6 rooms (candidates à ≤ 3 + voisines à ≤ 3) ; notre scout (portée 3) doit être étendu ou la sûreté des sorties sera sous-estimée (directions non sûres = score plus bas, pas d'exclusion).
12. **Quirks à ne pas reproduire aveuglément** : cache de `calculateAdjacentRoomSafety` sans les options (terme `newSafeExits` toujours 0) ; `influence` des rooms à range 2 qui écrase celle des voisines directes ; détection de highway par `endsWith('0')` ; rooms possédées par un autre jamais marquées « vues » dans la recherche (re-testées à chaque run) ; squads dissous jamais supprimés de `Memory.squads` ; `stopExpansion` sur chemin bloqué sans enregistrer d'échec (la même cible peut être re-choisie aussitôt).
