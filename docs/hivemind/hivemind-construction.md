# Hivemind : construction, plan de base, défense de base (spec de portage RCL1-4)

Source : bot Hivemind (MIT), `C:\Users\ruffa\AppData\Local\Temp\bots\hivemind` (lecture seule).
Toutes les références sont `fichier:ligne` relatives à `src/`. Constantes Screeps citées par leur nom (valeurs entre parenthèses).

Légende : **[RCL1-4]** = indispensable pour l'économie mono-room RCL1-4 ; **[PLUS TARD]** = peut être omis/stubé pour la première version.

---

## 0. Vue d'ensemble et cadence

| Process | Cadence | Source |
|---|---|---|
| `RoomPlanner.runLogic()` | chaque tick (throttle interne) | `process/rooms/owned.ts:64-67` |
| `RoomManager.runLogic()` (construction) | `interval: 100` ticks, ou `0` + priorité ALWAYS si `memory.runNextTick` | `process/rooms/owned.ts:69-77` |
| `RoomDefenseProcess.run()` (tours, safe mode) | chaque tick (PROCESS_PRIORITY_ALWAYS) | `process/rooms/owned.ts:81-86` |
| Intel hostiles (`room.memory.enemies`) | cache 1 tick si bucket > 8000, sinon 10 | `process/rooms/intel.ts:52-53` |

`hasIntervalPassed(interval, last)` : vrai si `Game.time - last >= interval * throttleMultiplier` (multiplicateur >= 1 selon le bucket) (`hivemind.ts:327-337`).

Chaîne : plan généré (multi-tick, plusieurs variantes, la meilleure gagne) -> stocké en segment -> RoomManager pose les chantiers selon le plan, par RCL, max 5 chantiers par room.

---

## 1. RoomManager : construction (`room/room-manager.ts`)

### 1.1 État persistant

- `Memory.rooms[r].manager = { dismantle: {}, runNextTick, hasMisplacedSpawn, isMovingMisplacedSpawn }` (`:73-87`).
- Feature flags persistants en segment mémoire, clé `'room:managerFlags:' + roomName` (`:89`, `utils/persistent-feature-flag.ts`) : `finishedRecovering`, `cleanedRoom`, `builtAllStructures`, `ranAtRcl` (numérique). `reset()` efface **tout** (y compris `ranAtRcl`) (`persistent-feature-flag.ts:38-41`).
- Les flags sont aussi reset quand un nouveau plan est stocké (`room/planner/room-plan-management.ts:210-212`).

### 1.2 `runLogic()` (`:105-148`)

```ts
function runLogic() {
  delete memory.runNextTick;
  if (!roomPlanner) return;
  if (!roomPlanner.isPlanningFinished()) { flags.reset(); return; }          // :108-113

  // Sous attaque (autre que NPC Invader) et pas de safe mode : on ne construit rien.
  if (room.defense.getEnemyStrength() > ENEMY_STRENGTH_NONE && !controller.safeMode) {   // :115
    flags.reset();
    if (!room.defense.getEnemyInfo().invaderOnly) return;                    // :121 (invaders seuls => on continue)
  }

  if (controller.level !== flags.getNumeric('ranAtRcl')) {                   // :125-128
    flags.reset(); flags.setNumeric('ranAtRcl', controller.level);
  }

  if (flags.isSet('builtAllStructures') && !memory.isMovingMisplacedSpawn && !memory.hasMisplacedSpawn) {
    periodicallyCheckDecayingStructures();                                   // :130-136
    return;
  }

  initializeStructureInformation();   // newStructures=0, sites=FIND_MY_CONSTRUCTION_SITES groupés par type (:175-181)
  if (recoverRoom()) return;          // :140
  cleanRoom();                        // :141
  manageStructures();                 // :142

  if (checkWallIntegrity() && roomConstructionSites.length + newStructures === 0)
    flags.set('builtAllStructures');  // :145-147
}
```

Conséquence : à RCL1-2 aucun rempart n'est construit, `checkWallIntegrity()` renvoie false s'il y a des remparts planifiés => `builtAllStructures` jamais posé => le manager tourne en entier toutes les 100 ticks. Idem tant qu'un spawn est mal placé (`hasMisplacedSpawn`).

### 1.3 Plafonds de chantiers et `tryBuild` (`:235-237`, `:698-739`)

```ts
canCreateConstructionSites = () => newStructures + roomConstructionSites.length < 5;     // :236  (5 PAR ROOM, existants compris)

function tryBuild(pos, type): boolean /* true = on peut continuer */ {
  if (pos.lookFor(LOOK_STRUCTURES).some(s => s.structureType === type)) return true;        // déjà là
  if (pos.lookFor(LOOK_CONSTRUCTION_SITES).some(s => s.structureType === type)) return true; // déjà en chantier
  const canCreateMoreSites = newStructures + roomConstructionSites.length < 5;
  if (canCreateMoreSites && _.size(Game.constructionSites) < MAX_CONSTRUCTION_SITES * 0.9) {  // 100*0.9 = 90 global
    // Nuke à portée 2 : on saute (sans bloquer) spawn/extension/link/container/road      :720
    if ([SPAWN, EXTENSION, LINK, CONTAINER, ROAD].includes(type) && pos.findInRange(FIND_NUKES, 2).length) return true;
    const isBlocked = OBSTACLE_OBJECT_TYPES.includes(type) && (pos.lookFor(LOOK_CREEPS).length || pos.lookFor(LOOK_POWER_CREEPS).length);
    if (!isBlocked && pos.createConstructionSite(type) === OK) newStructures++;
    return true;      // même en cas d'échec (structure gênante, quota RCL atteint) on continue    :732-734
  }
  return false;       // plus de place : stoppe la boucle courante
}

function buildPlannedStructures(locationType, structureType, filter?): boolean {          // :665-676
  for (const pos of roomPlanner.getLocations(locationType)) {
    if (filter && !filter(pos)) continue;
    if (!tryBuild(pos, structureType)) return false;
  }
  return true;
}
```

**Ordre d'itération des positions** : `RoomPlan` stocke chaque type dans un objet indexé par `x + 50*y` (`room-plan.ts:62-66`, `utils/serialization.ts:79-84`). Les clés entières JS sont itérées par ordre croissant => **ordre ligne par ligne (y croissant puis x croissant)**, pas par distance. Seul `manageLinks` trie explicitement. Pour reproduire, itérer les positions triées par `y*50+x`.

Le quota RCL (`CONTROLLER_STRUCTURES`) n'est jamais vérifié avant `createConstructionSite` : c'est le moteur qui renvoie `ERR_RCL_NOT_ENOUGH`, et la boucle continue.

### 1.4 `manageStructures()` : ORDRE EXACT (`:356-439`)

```ts
function manageStructures() {
  // A. Première room (1 seul spawn au total, dans cette room) et RCL < 4 : extensions d'abord.   :357-361
  if (_.size(Game.spawns) === 1 && onlySpawn.room.name === room.name && rcl < 4) manageExtensions();

  if (!canCreateConstructionSites()) return;                                  // :363
  manageTowers();                                                             // :365  (§1.5)
  manageSpawns();                                                             // :366  (§1.6)
  buildPlannedStructures('wall.blocker', WALL);   // :367 (aucun générateur ne planifie 'wall.blocker' : no-op)
  if (!canCreateConstructionSites()) return;

  if (rcl === 0) { /* room pas encore claimée : routes */ }                   // :370-381 (hors périmètre)
  if (rcl < 2) return;                                                        // :383   => RCL1 : uniquement tours/spawns/extensions(A)

  // B. Extensions tant que capacité < MAX_CREEP_SIZE*(WORK+MOVE)/2 = 50*150/2 = 3750      :386-389
  if (room.energyCapacityAvailable < 3750) { manageExtensions(); if (!canCreate()) return; }

  manageContainers();                                                         // :391  (RCL2+)
  manageRamparts();                                                           // :392  (RCL3+, §1.9)
  if (!canCreateConstructionSites()) return;

  manageStorage();                                                            // :395
  manageTerminal();                                                           // :396  [PLUS TARD]

  // C. Routes sur MARAIS uniquement, routes source puis controller,                       :398-407
  //    quand storage existe OU storage impossible à ce RCL (RCL 1-3 => CONTROLLER_STRUCTURES[storage][rcl] = 0).
  if (room.storage || CONTROLLER_STRUCTURES[STORAGE][rcl] === 0) {
    buildPlannedStructures('road.source',     ROAD, pos => terrain.get(pos) === TERRAIN_MASK_SWAMP);
    buildPlannedStructures('road.controller', ROAD, pos => terrain.get(pos) === TERRAIN_MASK_SWAMP);
  }
  if (!canCreateConstructionSites()) return;

  manageLinks();                                                              // :411 [PLUS TARD] (RCL5)
  if (CONTROLLER_STRUCTURES[EXTRACTOR][rcl] > 0) { manageExtractors(); buildPlannedStructures('container.mineral', CONTAINER); } // RCL6
  if (rcl < 4) return;                                                        // :418
  if (!canCreateConstructionSites()) return;

  dismantleUnwantedDefenses();                                                // :422 (§1.11)
  if (room.storage) {                                                         // :425-428
    buildPlannedStructures('road', ROAD);     // TOUTES les routes planifiées (plaine comprise)
    buildOperationRoads();                    // routes des opérations de remote mining dans cette room
  }
  manageExtensions();                                                         // :431 extensions manquantes
  if (room.isEvacuating()) return;
  if (!checkWallIntegrity()) return;                                          // :435
  buildEndgameStructures();                   // labs/nuker/powerSpawn/observer/factory [PLUS TARD]
  buildPlannedStructures('wall.deco', WALL);  // [PLUS TARD]
}
```

Résumé par RCL (première room) :

| RCL | Ce qui est posé, dans l'ordre |
|---|---|
| 1 | extensions (rien, quota 0) ; tours (quota 0) ; spawns manquants (`spawn.0`) |
| 2 | extensions (bay par bay) ; tours (0) ; spawns ; **extensions** (B) ; **containers source + controller** ; storage (quota 0) ; **routes source/controller sur marais seulement** |
| 3 | idem + `extension.harvester` (extensions autour des sources) ; **tour `tower.0`** ; **remparts** si safe mode < 2000 ou cooldown |
| 4 | idem + **storage** ; routes marais seulement **après** storage construit ; puis (storage présent) **toutes les routes** ; démolition murs non planifiés |

Point clé : **aucune route en plaine avant RCL4 + storage**. Avant cela, seules les routes `road.source` et `road.controller` situées sur marais (RCL2-3, puis RCL4 après storage).

### 1.5 Tours (`manageTowers`, `:441-449`) [RCL1-4]

```ts
removeUnplannedStructures('tower', TOWER, 1);
for (let i = 0; i < CONTROLLER_STRUCTURES[TOWER][rcl]; i++)           // RCL3:1, RCL4:1, RCL5:2
  buildPlannedStructures(`tower.${i}`, TOWER, pos => roomPlanner.isPlannedLocation(pos, 'tower'));
buildPlannedStructures('tower', TOWER);    // filet de sécurité
```
`tower.0` est la meilleure position (ordre de placement du planner, §2.6 étape 16).

### 1.6 Spawns (`manageSpawns`, `:451-466`, `removeMisplacedSpawn :747-782`)

```ts
delete memory.isMovingMisplacedSpawn;
const max = CONTROLLER_STRUCTURES[SPAWN][rcl];       // RCL1-6 : 1, RCL7 : 2, RCL8 : 3
if (spawns.length >= max && roomConstructionSites.length === 0) removeMisplacedSpawn(spawns);
else if (spawns.length + spawnSites.length < max) {
  for (i < max) buildPlannedStructures(`spawn.${i}`, SPAWN, pos => isPlannedLocation(pos, 'spawn'));
  buildPlannedStructures('spawn', SPAWN);
}

function removeMisplacedSpawn(spawns) {
  memory.hasMisplacedSpawn = false;
  for (const spawn of spawns) {
    if (isPlannedLocation(spawn.pos, 'spawn')) continue;
    memory.hasMisplacedSpawn = true;
    const roomEnergy = room.storage?.store.energy ?? 0;
    const ok = roomEnergy > CONSTRUCTION_COST[SPAWN] * 2 /* 30000 */ && builders.length > 1;
    if (!ok && spawns.length === 1) return;                         // premier spawn : jamais détruit sans storage
    if (roomEnergy > 30000) memory.isMovingMisplacedSpawn = true;   // => spawn de builders en plus
    if (spawn.spawning) continue;
    const buildPower = Σ builders creep.getActiveBodyparts(WORK) * ttl / CREEP_LIFE_TIME;
    if (buildPower > 15) { spawn.destroy(); memory.runNextTick = true; return; }   // un seul à la fois
  }
}
```
Le planner **ne s'ancre pas sur le spawn initial** posé par le joueur : le premier spawn est presque toujours "mal placé" mais n'est détruit qu'avec storage > 30000 énergie, > 1 builder et buildPower > 15, donc jamais en RCL1-4 en pratique. NB : `CONSTRUCTION_COST[SPAWN]` = 15000.

### 1.7 Extensions (`manageExtensions`, `:528-547`) [RCL1-4]

```ts
if (!canCreateConstructionSites()) return;
removeUnplannedStructures('extension', EXTENSION, 1);
if (rcl >= 3)   // à RCL3 les harvesters sont assez gros pour vider la source même avec des extensions autour
  buildPlannedStructures('extension.harvester', EXTENSION, pos => isPlannedLocation(pos, 'extension'));
for (let i = 0; i < 10; i++)                                  // une bay à la fois, bay 0 = la plus proche du centre
  buildPlannedStructures(`extension.bay.${i}`, EXTENSION, pos => isPlannedLocation(pos, 'extension'));
buildPlannedStructures('extension.bay', EXTENSION, pos => isPlannedLocation(pos, 'extension'));
buildPlannedStructures('extension', EXTENSION);
```
Le filtre `isPlannedLocation(pos,'extension')` sert car l'étape 17 du planner peut retirer `extension` d'une position sans retirer tous les sous-types.

### 1.8 Containers (`manageContainers`, `:468-472`) [RCL1-4]

```ts
removeUnplannedStructures('container', CONTAINER);   // pas d'amount => détruit jusqu'à min(5, nb planifiés) containers hors plan
buildPlannedStructures('container.source', CONTAINER);       // sur la harvest position de chaque source
buildPlannedStructures('container.controller', CONTAINER);   // = case "upgrader.0" (voir §2.6 étape 4)
```
Uniquement à partir de RCL2 (retour `rcl < 2` avant).

### 1.9 Remparts (`manageRamparts`, `:474-486`)

```ts
const sm = controller.safeMode ?? 0;
if (rcl >= 3 && (sm < 2000 || controller.safeModeCooldown)) {
  buildPlannedStructures('rampart', RAMPART, pos => !isPlannedLocation(pos, 'rampart.ramp'));  // remparts principaux
  buildPlannedStructures('rampart', RAMPART);                                                   // puis on-ramps
}
```

### 1.10 Storage / Terminal (`:488-502`)

```ts
if (hasMisplacedStorage() && room.storage.store.getUsedCapacity() < 5000) removeUnplannedStructures('storage', STORAGE, 1);
buildPlannedStructures('storage', STORAGE);   // quota 0 avant RCL4
// terminal : même logique [PLUS TARD]
```

### 1.11 `removeUnplannedStructures(locationType, type, amount?)` (`:832-857`)

```ts
let limit = Math.min(CONTROLLER_STRUCTURES[type][rcl], plannedPositions(locationType).length);
if (amount) limit = amount + structures.length + sites.length - limit;
// => avec amount=1 : ne détruit que si on est AU quota (ex : 10 ext existantes à RCL3 => limit=1 ; 5 existantes => limit<0 => rien)
let count = 0;
for (s of structures) if (!isPlannedLocation(s.pos, locationType)) { if (count < limit) { s.destroy(); count++; } else break; }
for (site of sites) if (!isPlannedLocation(site.pos, locationType)) site.remove();   // TOUS les chantiers hors plan sont supprimés
```

### 1.12 `cleanRoom()` (une fois, flag `cleanedRoom`) (`:242-324`)

1. Détruit toutes les `FIND_HOSTILE_STRUCTURES` ; supprime les chantiers non `my`.
2. Si plan présent :
   - extensions : garde si (planifiée `extension` ET opérationnelle) ou (pas sur une `road` planifiée ET opérationnelle) ; sinon `destroy()` (`:257-268`).
   - labs / links : détruits s'ils ne sont pas planifiés pour leur type ET sont sur `road|spawn|link|extension` planifiés (`:270-296`).
   - murs : détruits si sur `road|harvester|spawn|storage|extension` planifiés (`:298-310`).
3. `flags.set('cleanedRoom')`.

### 1.13 `dismantleUnwantedDefenses()` (RCL4+, `:504-526`)

`memory.dismantle = {}` ; si `!room.needsReclaiming()` : murs non planifiés `'wall'` + (si setting `dismantleUnwantedRamparts`=true, défaut `settings.default.ts:164`) remparts non planifiés `'rampart'`. Avec ce setting à true, tous sont mis dans `memory.dismantle[id]=1` (spawn d'un dismantler), sinon les murs sont `destroy()` directement.

### 1.14 Intégrité des murs (`checkWallIntegrity`, `:865-885`)

```ts
minHits = arg ?? settings.minWallIntegrity;            // 500_000 (settings.default.ts:130)
targetHealth = minHits * maxWallHealth[rcl] / maxWallHealth[8];
// maxWallHealth = {0:1, 1:5000, 2:10000, 3:20000, 4:100000, 5:500000, 6:2M, 7:3M, 8:20M} (settings.default.ts:131-141)
// => RCL3 : 500 hits, RCL4 : 2500 hits
// cache heap 100 ticks : vrai si chaque position 'rampart' (hors 'rampart.ramp') porte un rempart >= targetHealth
```

### 1.15 Structures qui se dégradent (room "finie", `:150-173`)

Si `builtAllStructures` : toutes les `CREEP_LIFE_TIME` (1500) ticks (timer heap `lastDecayCheck`) :
- RCL >= 6 : tous les `container` ; RCL 2-5 : `container.source` + `container.controller`.
- RCL >= 4 : `rampart` puis `road`. Puis `buildOperationRoads()`.

### 1.16 `recoverRoom()` (`:183-233`) (cas rare : room RCL>=3 sans spawn, ou reclaim)

`isRoomRecovering` : faux si safeMode > 5000 ; vrai si `needsReclaiming()` ; faux s'il y a un spawn ou RCL < 3 ; sinon vrai. Alors `buildRoomDefenseFirst` : remparts sur `tower.i` puis tours, remparts normaux ; si `checkWallIntegrity(10000)` : extensions si `energyCapacityAvailable + 300 < 6*100+3*50+3*50 = 900`, puis `spawn.0`, `container.source`, `storage`. Bloque le reste tant qu'il n'y a ni spawn ni (storage si autorisé). Non nécessaire pour un portage mono-room de base.

### 1.17 Côté builder (qui exécute les chantiers) : priorités utiles (`role/builder.ts`)

- Build : priorité 4 ; poids = progress/progressTotal - range/100 ; si progressTotal < 1000 : priorité -= nb builders déjà dessus ; **spawn = priorité 5** ; road/rampart/wall/container : poids -1 ; lab/nuker/factory : priorité -1 (`:522-560`).
- Repair : priorité 3, poids 1 - hits/hitsMax ; >90% : -1 ; <20% : +1 ; **routes : priorité 0 tant que hits > hitsMax/3** ; routes non planifiées (ni opération) ignorées, remparts/murs non planifiés ignorés (`:319-414`).
- Hits max visés murs/remparts = `maxWallHealth[rcl] * mult` (mult 2 si cooldown safe mode, 1.5 si une room est safe-modée, sinon 1) (`room-defense.ts:101-113`) ; `rampart.ramp` et `wall.quad` /10 ; `wall.deco` 10000 (`builder.ts:417-447`). Rempart < 10000 hits à RCL3+ : priorité +2 (`:481-485`). Les tours ne réparent **pas** routes/containers (§3.1).

---

## 2. Planner (`room/planner/**`)

### 2.1 Pilotage et budget CPU (`room-planner.ts`)

- Version : `roomPlannerVersion = 41` (`:62`). Replanification si pas de plan ou version stockée différente (`:124-129`).
- `runLogic` (`:99-111`) : rien si `Game.cpu.bucket < 3500` ou segment mémoire pas prêt ; `manageRoomPlanGeneration()` chaque tick ; toutes les 100 ticks `checkAdjacentRooms()` : si la sécurité d'une direction (N/E/S/W) change => **replanification complète** (`:173-205`).
- Budget par tick (`continueRoomPlanGeneration`, `:136-146`) :

```ts
const cpuStart = Game.cpu.getUsed();
if (cpuStart >= Game.cpu.tickLimit / 2) return;
const cpuUsage = avg('cpu_total', 1000) || avg('cpu_total', 10) || 0;
const cpuLimit = Math.min(Game.cpu.tickLimit / 2, 0.8 * Math.max(Game.cpu.limit - cpuUsage, Game.cpu.limit / 10));
while (!finished && Game.cpu.getUsed() - cpuStart < cpuLimit) generator.generate();   // 1 appel = 1 étape d'une variante
```
- Le générateur vit en heap (`generatorCache`, `:29`) ; un reset global relance tout. Pendant la génération, RoomManager ne fait rien (§1.2).
- À la fin (`applyGeneratedRoomPlan`, `:148-168`) : meilleur plan stocké, flags RoomManager reset, `harvestPos`/`noHarvestPos` des harvesters effacés, visualisation 20 ticks.

### 2.2 Format stocké (`room-plan.ts`, `room-plan-management.ts`)

- Segment mémoire, clé `'room-plan:' + roomName` => `{ plan: Record<locationType, string>, version: number }` (`room-plan-management.ts:214-224`).
- Chaque liste de positions est packée : 1 caractère UTF-16 par coordonnée, `String.fromCharCode(((x << 6) | y) + 65)` (`utils/packrat.ts:172-179`).
- En mémoire : `positionsByType[type][x + 50*y] = RoomPosition` (`room-plan.ts:62-66`).
- `canPlaceMore(type)` / `remainingStructureCount(type)` = `CONTROLLER_STRUCTURES[type][8] - nbPlanifiés` (`:106-121`) : le plan prévoit d'emblée le RCL8 (60 extensions, 3 spawns, 6 tours, 6 links, 10 labs, 1 storage...).
- Cache heap de la matrice de navigation 500 ticks (`room-planner.ts:285-289`).

**Types de locations** (un même tile peut en avoir plusieurs) : `exit`, `center`, `harvester`, `harvester.<sourceId>`, `bay_center`, `extractor`, `road`, `road.mineral`, `road.controller`, `road.source`, `road.rampart`, `road.toRampart`, `upgrader.0`, `container`, `container.source|controller|mineral`, `link`, `link.controller|source|storage`, `storage`, `terminal`, `factory`, `spawn`, `spawn.<i>`, `extension`, `extension.harvester`, `extension.bay`, `extension.bay.<i>`, `helper_parking`, `lab`, `lab.reaction`, `powerSpawn`, `nuker`, `observer`, `rampart`, `rampart.ramp`, `wall`, `wall.quad`, `wall.deco`, `safe`, `tower`, `tower.<i>`.

### 2.3 Matrices de distance (`matrix-generator.ts`)

```ts
// wallMatrix : mur = 255 ; case non-mur adjacente (8-voisinage) à un mur = 1 ; puis BFS : case à 0 adjacente à une case = d => d+1.
// exitMatrix : mur = 255 ; case de bord non-mur (x|y ∈ {0,49}) = 1 ; puis même BFS (les zones inaccessibles restent 0).
// propagation itérative : d=1,2,... balayage x 0..49 / y 0..49 jusqu'à stabilité  (:283-298, :315-330)
```
Distances de Chebyshev (8-voisins), contournant les murs.

### 2.4 PlacementManager (`placement-manager.ts`) : matrice de construction et primitives

Constantes : `ROAD_POSITION=1`, `DISCOURAGED_POSITION=5`, `IMPASSABLE_POSITION=255`, `ROAD_THROUGH_WALL_COST=30` (`:6-20`).

```ts
prepareBuildingMatrix():                                         // :55-78
  mur => 30  (les routes peuvent tunneler !)
  bord (x|y = 0|49) => 255
  exitDistance <= 2 => 10

planLocation(pos, type, cost = 255):                             // :90-100
  roomPlan.add(type, pos);
  if (cost && matrix.get(pos) < 100) matrix.set(pos, cost);      // cost null/0 => ne touche pas la matrice

discouragePosition(x,y): si valeur < 5 et != 1 => 5              // :102-106
blockPosition => 255 ; unblockPosition => 0 ; isBlockedTile = valeur >= 100

isBuildableTile(x, y, allowRoads = false, allowNearExit = false):   // :141-163
  if (terrain mur) return false;
  if (exitDistance <= (allowNearExit ? 2 : 5)) return false;
  const v = matrix.get(x,y);
  if (v > 100) return false;
  if (v === 5 && wallDistance <= 2) return true;      // découragé mais près d'un mur : OK
  if (v > 1) return false;
  if (v === 1 && !allowRoads) return false;
  return true;

findAccessRoad(from, to[], breakExtensions = false):             // :317-343
  PathFinder.search(from, to, { roomCallback: matrix (clone avec extensions à 25 si breakExtensions),
    maxRooms: 1, plainCost: 2, swampCost: 2, heuristicWeight: 0.9 })   // marais = plaine pour le tracé
  return result.path   // n'inclut pas `from`, inclut la dernière case (adjacente/égale à la cible)

placeAccessRoad(to): for pos of findAccessRoad(to, originEntrances) planLocation(pos, 'road', 1)

// Flood-fill "prochaine case constructible" depuis origin (centre) :     :168-243
startBuildingPlacement(origin?, entrances?): openList = {origin: {range 0}} ; closedList = {}
getNextAvailableBuildSpot():
  tant que openList non vide :
    prendre l'entrée de range minimale (premier rencontré en cas d'égalité)
    la fermer ; ajouter ses 8 voisins si isBuildableTile(x,y,allowRoads=true) et pas déjà vus (range+1)
    si range Chebyshev à origin < 3 => continue
    si !isBuildableTile(x,y) (pas sur route) => continue
    return pos
filterOpenList(p): retire de l'openList les entrées dont le chemin passe par p
placeAll(type, addRoad): tant que canPlaceMore(type) : pos = next ; planLocation(pos,type) ; filterOpenList(pos) ; if addRoad placeAccessRoad(pos)
isPositionAccessible(pos, noTunnels): PathFinder(pos -> entrances, coûts 1/1) non incomplet ; noTunnels => refuse si le chemin passe par un mur sans route planifiée
```

### 2.5 Variantes (`variation-generator.ts`, `room-plan-generator.ts`)

```ts
// Candidats "core" : case non-mur avec 3 <= wallDistance < 255 et exitDistance > 8     (:57-75)
// Variante "weighted" (:77-129) :
//   cx,cy = moyenne(controller, centres de toutes les sorties, minéraux, sources), Math.floor
//   centre = candidat de range Chebyshev minimale à (cx,cy) (premier en ordre x puis y en cas d'égalité)
// Centres de sortie (utils/room-info.ts:43-78) : pour chaque côté, chaque segment contigu de cases de bord non-mur
//   (i de 1 à 48) => milieu = (ceil((x1+x2)/2), ceil((y1+y2)/2))
// Variantes "grille" (:131-155) : room découpée 3x3 (floor(x*3/50) 'x' floor(y*3/50)) ;
//   dans chaque cellule, le candidat de wallDistance maximale (premier trouvé en cas d'égalité).
// Puis pour chaque source : variante '-' (pas de spawn dans la bay de source) et '+' (spawn dans la bay de source) (:157-184)
// Clé ex. "weighted:+-", "1x2:--". Total = (1 + nb cellules non vides <= 9) * 2^nbSources  (<= 40 pour 2 sources)
```
Génération (`room-plan-generator.ts:37-88`) : chaque variante est construite étape par étape (1 étape par `generate()`), puis notée ; `getRoomPlan()` = variante de `score.total` max (`:90-97`). Une room "stripmine" utilise un builder réduit (`stripmine-variation-builder.ts`), hors périmètre.

### 2.6 Les 18 étapes (`variation-builder.ts:50-69`)

Le résultat d'étape (`'ok' | 'failed' | 'done'`) n'arrête rien sauf `'done'` (`variation-builder-base.ts:37-46`) : un `'failed'` passe simplement à l'étape suivante.

Rappel `protectPosition(pos, d = minCutRampartDistance = 4)` (`variation-builder-base.ts:203-210`) : ajoute le rectangle `[max(2,x-d) .. min(47,x+d)] x [max(2,y-d) .. min(47,y+d)]` à `minCutBounds` (zones à protéger par le min-cut, étape 12).

**1. gatherExitCoords** (`:82-93`) [RCL1-4] — `planLocation(centreDeSortie, 'exit', null)` pour chaque centre de sortie.

**2. determineCorePosition** (`:95-111`) [RCL1-4] — `roomCenter = variation.roomCenter` (sinon `'failed'`). Entrées du centre = `C+(2,0), C-(2,0), C+(0,2), C-(0,2)`. `planLocation(C, 'center', null)`.

**3. determineHarvesterPositions** (`:113-181`) [RCL1-4]
```ts
for (source of sources) {
  // harvest pos = case adjacente à la source, isBuildableTile(x,y) (défauts : pas route, exitDistance > 5),
  //   maximisant le nb de cases du 3x3 centré sur elle (elle comprise) qui sont isBuildableTile ; strict > (premier gagne)
  plan(hp, 'harvester', null); plan(hp, 'harvester.' + source.id, null); plan(hp, 'bay_center', null);
  for 8 voisins non-mur de hp : discouragePosition()              // les routes évitent le tour de la harvest pos
  blockPosition(hp)                                               // 255 : aucun chemin ne la traverse
}
for (mineral of minerals) {                                       // [PLUS TARD] mais influe sur le plan
  plan(mineral, 'extractor');
  roads = findAccessRoad(mineral, entrances) ; plan(roads, 'road', 1) + 'road.mineral' ;
  placeContainer(roads, 'mineral') ; blockPosition(roads[0])
}
```

**4. determineUpgraderPosition** (`:183-295`) [RCL1-4]
```ts
protectPosition(controller, 1);
// candidat = toute case non-mur à range <= 3 du controller (handleMapArea range 3)
// spots(c) = nb de cases non-mur du 3x3 autour de c (c compris) à range <= 3 du controller ; exige spots >= 3
// path = [c, ...findAccessRoad(c, entrances)] ; score = path.length - 1.1 * spots ; garder le score MIN
controllerRoads = best.path;
for (pos of controllerRoads) { protectPosition(pos, 0); if (pos == controllerRoads[0]) continue; plan(pos,'road',1); plan(pos,'road.controller',null); }
plan(controllerRoads[0], 'upgrader.0', 1); protectPosition(controllerRoads[0], 1);
container = placeContainer(controllerRoads, 'controller');   // en pratique = controllerRoads[0] (coût 1 => constructible avec allowRoads)
plan(container, 'road', null); plan(container, 'road.controller', null);   // route SOUS le container controller
placeControllerLink(controllerRoads[0], controller);   // [PLUS TARD RCL5] case adjacente constructible (allowNearExit),
   // score = spots(case) - 1 + (range(case, controller) > 3 ? 1.5 : 0), max ; plan 'link.controller' + 'link' ; protectPosition(.,0)
for (8 voisins du container) if (isBuildableTile(x,y,false,true) && terrain == SWAMP) plan('road',1) + 'road.controller';
blockPosition(controllerRoads[0]);
```
`placeContainer(roads, type)` (`variation-builder-base.ts:165-198`) : `roads[0]` si `isBuildableTile(.., allowRoads=true, allowNearExit=true)`, sinon `roads[1]`, sinon première case constructible adjacente à `roads[0..2]` ; plan `'container.'+type` (coût null) et `'container'` (coût 1).

**5. placeRoadNetwork** (`:297-314`) [RCL1-4] — pour chaque centre de sortie, `findAccessRoad(exit, entrances)` ; chaque case planifiée `'road.exit'` coût 1, puis le type `road.exit` est **supprimé du plan** : seul l'effet matrice (coût 1 = non constructible sans allowRoads) reste, ce qui garde des couloirs libres vers chaque sortie. Aucune route réelle.

**6. placeRoomCore** (`:340-359`) [RCL1-4] — losange 5x5 autour de C :
```
routes (coût 1) : C±(2,0), C±(0,2), C+(±1,±1)
storage  : C+(0,+1)      terminal : C+(0,-1)     [terminal PLUS TARD]
factory  : C+(+1,0)      link + link.storage : C+(-1,0)   [PLUS TARD]
C lui-même : rien (case libre, 'center')
```

**7. placeHarvestBayStructures** (`:316-335`) [RCL1-4]
```ts
for (source of sources) {
  const withSpawn = variation.sourcesWithSpawn.includes(source.id);
  const roads = findAccessRoad(hp, entrances);
  for (pos of roads) { plan(pos,'road',1); plan(pos,'road.source',null); if (withSpawn) protectPosition(pos,0); }
  plan(hp, 'container.source', null); plan(hp, 'container', null);     // container SUR la harvest position
  placeBayStructures(hp, { spawn: withSpawn, source: true });
}
```
`placeBayStructures(bay, {spawn, source, id})` (`variation-builder-base.ts:52-107`) :
```ts
const allowNearExit = source && !spawn;
if (canPlaceMore('spawn') && spawn) {
  // 1er voisin (ordre dx -1..1 puis dy -1..1) non-mur, isBuildableTile(x,y,false,allowNearExit), != bay,
  // ayant une case 'road' planifiée dans son 3x3 (hors bay) => plan 'spawn.<n>' et 'spawn' (255). Un seul spawn par bay.
}
let linkPlaced = !canPlaceMore('link') || !source;
for (8 voisins non-mur, isBuildableTile(x,y,false,allowNearExit), != bay) {
  if (linkPlaced) {
    plan 'extension';
    source ? plan 'extension.harvester' : (id !== undefined && plan 'extension.bay.'+id, plan 'extension.bay');
  } else { plan 'link' (+ 'link.source' si source); linkPlaced = true; }   // bay de source : 1re case libre = link
}
```
NB : autour de la harvest position, les cases ont été découragées (5) à l'étape 3 : elles ne sont constructibles que si `wallDistance <= 2`.

**8. placeHelperParkingLot** (`:364-377`) [PLUS TARD, mais réserve une case] — `startBuildingPlacement(C, entrances)` ; première case => `plan('road', 255)` + `'helper_parking'` ; `placeAccessRoad` ; `filterOpenList`.

**9. placeLabs** (`:456-531`) [PLUS TARD] — exécuté **avant** les bays : pour reproduire exactement le layout il faut réserver ce tampon, sinon les bays seront plus proches du centre (acceptable pour notre portage). Flood depuis C ; ignore exitDistance < 8 ; pour chaque orientation (dx,dy) ∈ {(1,1),(-1,1),(1,-1),(-1,-1)} : 4 cases centrales (x,y),(x+dx,y),(x,y+dy),(x+dx,y+dy) constructibles et > 8 des 10 cases périphériques constructibles ; place routes en (x,y) et (x+dx,y+dy), 2 labs au centre, puis labs périphériques jusqu'à 10 ; `placeAccessRoad`.

**10. placeBays** (`:382-451`) [RCL1-4 : c'est là que sont les extensions et les spawns 2-3]
```ts
startBuildingPlacement();
let count = 0;
while (canPlaceMore('extension')) {                 // 60 au total (extensions de bays de source comprises)
  const pos = findBayPosition(); if (!pos) return 'failed';
  placeAccessRoad(pos);                             // route de C jusqu'à côté du centre de bay
  plan(pos, 'bay_center', 1);                       // case de stationnement du remplisseur (coût 1, pas une route)
  placeBayStructures(pos, { spawn: true, id: count++ });   // jusqu'à 8 ext (moins le spawn tant qu'il en reste à placer)
  protectPosition(pos);                             // rayon 4
  startBuildingPlacement();
}

function findBayPosition() {
  let max = 0, best = null, bestScore = 0;
  startBuildingPlacement(C, entrances);
  while (max < 8) {
    const p = getNextAvailableBuildSpot(); if (!p) break;
    if (exitDistance(p) < 8) continue;
    if (!isBuildableTile(p)) continue;
    const n = nb des 8 voisins isBuildableTile (sans route, exitDistance > 5);
    if (n <= max) continue;
    max = n;
    const score = n / (currentBuildSpot.range + 10);
    if (score > bestScore && n >= 4) { best = p; bestScore = score; }
  }
  return max < 4 ? null : best;      // s'arrête dès qu'un centre à 8 voisins libres est trouvé
}
```
Bay = carré 3x3 : centre vide (le filler s'y tient, cf. `manager.bay.ts`), jusqu'à 8 structures autour (extensions + éventuel spawn), atteinte par une route. Bay 0 = la plus proche du centre ; RoomManager construit les bays dans l'ordre 0..9 (§1.7).

**11. placeHighLevelStructures** (`:533-539`) [PLUS TARD] — `placeAll('powerSpawn', road)`, `placeAll('nuker', road)`, `placeAll('observer', sans route)` (flood en cours de l'étape 10).

**12. placeRamparts** (`:541-590`) [RCL3-4 : remparts ; peut être simplifié]
```ts
protectPosition(controller, 1);
for (type of plan.types) {
  base = type.split('.')[0];
  if (!CONTROLLER_STRUCTURES[base] || ['extension','road','container','extractor','link'].includes(base)) continue;
  for (pos of plan[type]) protectPosition(pos);     // rayon 4 : spawn, storage, terminal, factory, lab, nuker, powerSpawn, observer...
}
bounds = {x1:0,y1:0,x2:49,y2:49, protect{Top|Bottom|Left|Right}Exits: direction sûre (N/S/W/E)};
cut = minCut.getCutTiles(room, minCutBounds, bounds);
pruneWalls(cut);                                     // marque isRelevant
for (w of cut) if (w.isRelevant && terrain != mur) {
  plan(w, 'rampart', null);
  if (settings.constructRoadsUnderRamparts /* true */ || swamp) { plan(w,'road',null); plan(w,'road.rampart',null); }
}
```
Min-cut (`utils/mincut.ts`, algorithme de Saruss, Dinic) : graphe 2 sommets par tile (top->bot capacité 1), arêtes infinies bot->top des voisins NORMAL/TO_EXIT ; bordures des rectangles protégés = source (intérieur des rectangles UNWALKABLE) ; cases à distance 1 d'une sortie (`TO_EXIT`) = puits ; les sorties vers directions sûres sont neutralisées (sauf coins problématiques). Résultat = tiles coupés ; si bounds != room entière, suppression des tiles menant à des culs-de-sac (`:441-494`).

`pruneWalls` (`:598-650`) : flood-fill 8-voisins depuis C, controller, sources, minéraux (murs terrain ignorés sauf route planifiée, bornes 1..48) : cases atteintes = `SAFE(1)`, remparts touchés = relevant. 2e passe depuis les cases de bord des directions **non sûres** : cases atteintes = `UNSAFE(2)` ; seuls les remparts touchés par les deux passes restent relevant. Puis toute case SAFE à range <= 3 d'une case UNSAFE devient `ENDANGERED(0)` (valeur par défaut aussi pour les cases non visitées, dont les remparts).

**13. placeQuadBreaker** (`:877-920`) [PLUS TARD] — autour (range 3) de chaque rempart, cases UNSAFE (passées à 3) à exitDistance >= 3, non bloquées, non route : mur `wall`+`wall.quad` si adjacent (4-voisins) à une route non-`road.rampart`, sinon seulement si `(x+y) % 2 === 1`.

**14. placeDecorativeWalls** (`:922-942`) [PLUS TARD] — motif 14x12 (`:17-32`) sur les cases UNSAFE, exitDistance >= 3, non bloquées, non route => `wall` + `wall.deco`.

**15. sealRoom** (`:762-783`) [RCL1-4 si tours placées par le planner] — pour x,y ∈ 1..48 : mur => block ; SAFE => plan `'safe'` ; ENDANGERED => rien ; sinon (UNSAFE/3) => block.

**16. placeTowers** (`step/place-towers.ts`) [RCL3-4 : `tower.0`]
```ts
positions = cases (1..48) isBuildableTile && safety == SAFE ; [] si les 4 directions sont sûres (aucune tour !)
ramparts = plan 'rampart' (score 1)
effect(p, q) = 1 - (clamp(range(p,q) + 2, TOWER_OPTIMAL_RANGE=5, TOWER_FALLOFF_RANGE=20) - 5) / 15
while (canPlaceMore('tower')) {                      // 6
  newTowers = [];
  scoreRamparts(): rampart.score = Π_{t ∈ tower ∪ tower_placeholder} (1 - 0.8 * effect(t, rampart))
  scoreTowers(): pos.score = Σ rampart.score * effect(rampart, pos)   (-1 si plus constructible)
  while (newTowers.length < remaining) {
    info = max score ; stop si score < 0 ; info.score = -1 ;
    if (!isPositionAccessible(info.pos, noTunnels=true)) continue;
    newTowers.push(pos) ; planTemporaryLocation(pos, 'tower') (=> 'tower_placeholder', 255) ;
    rescore ramparts + tours
  }
  if (!newTowers.length) break;
  for (pos of newTowers) if (isPositionAccessible(pos, true)) {
    commitTemporaryLocation(pos,'tower'); placeAccessRoad(pos); plan(pos, 'tower.' + towerCount++);
  }
  discardTemporaryLocations('tower');
}
```
Ordre = ordre du choix glouton => `tower.0` est la tour qui couvre le mieux les remparts.

**17. placeRoadsToRamps** (`:790-850`) [RCL3-4 utile] — remparts groupés en composantes 8-connexes ; pour chaque groupe : `findAccessRoad(entrances[0] = C+(2,0), groupe, breakExtensions=true)` (extensions à coût 25) ; toute extension sur le chemin est retirée du plan (`extension`, `extension.bay`, `extension.bay.0..9`) et la case débloquée ; route `road` coût 1 (ou `road.toRampart` si setting false).

**18. placeOnRamps** (`:852-875`) [RCL3-4] — autour (range 3) de chaque rempart, case ENDANGERED non-mur, portant `road` ou `road.toRampart`, pas déjà rempart => `rampart` + `rampart.ramp` (remparts d'accès, construits après les principaux, hits visés /10).

### 2.7 Scoring (`room-plan-scorer.ts`), total = somme

```ts
structures = 0.01*ext + 0.01*factory + 0.01*observer + 0.02*lab + 0.02*nuker + 0.05*extractor
           + 0.05*powerSpawn + 0.1*spawn + 0.2*terminal + 0.2*tower + 1*storage     // compte plafonné à CONTROLLER_STRUCTURES[.][8]  (:24-44)
maintenance = -0.001*ramparts*RAMPART_DECAY_AMOUNT/RAMPART_DECAY_TIME (300/100)
              -0.001*containers*CONTAINER_DECAY/CONTAINER_DECAY_TIME_OWNED (5000/500)
              - Σ_routes f * ROAD_DECAY_AMOUNT/ROAD_DECAY_TIME (100/1000), f = 0.002 (x5 marais, x150 mur)     (:46-62)
towers = 0.2 * Σ_{rampart,tour} effect(tour, rampart) / nbRamparts    (même formule effect)            (:64-89)
defense = -0.003 * Σ_{rampart, exitDist<6} (6 - exitDist)^2 - 0.001 * nb('wall.quad')                  (:91-102)
distance (PathFinder sur navigationMatrix, plain 2, swamp 10, 1000 si incomplet) :                     (:104-161)
   -0.003 * Σ harvester -> spawns(range 1)
   -0.002 * upgrader(container.controller) -> spawns
   -0.001 * Σ minéral -> spawns
   -0.005 * Σ bay_center -> centre
   -0.001 * Σ harvester -> centre
   -0.01  * container.controller -> centre
   -0.001 * Σ lab -> centre ; -0.001 * Σ tour -> centre
```
`createNavigationMatrix` (`room-plan.ts:148-180`) : `road` = 1 (route-tunnel seulement si déjà construite), `harvester`, `bay_center`, `wall` et types d'OBSTACLE_OBJECT_TYPES = 255.

### 2.8 Ce qu'il faut porter pour RCL1-4

Indispensable : matrices wall/exit ; choix du centre (au moins "weighted", idéalement + grille) ; harvest positions + container source + `road.source` ; upgrader.0 + container controller + `road.controller` (+ routes marais autour) ; couloirs de sortie (effet matrice étape 5) ; core (storage C+(0,1), routes du losange) ; bays (ordre, 8 places, spawn adjacent à une route) ; `extension.harvester` ; tours (`tower.0`, au minimum une heuristique de couverture) ; remparts min-cut + on-ramps si on veut les remparts RCL3-4.
Plus tard : labs, terminal, factory, links, nuker, powerSpawn, observer, quad-breaker, murs déco, helper parking, extractor/minéral (mais l'étape minéral influence le tracé des routes).
Variante simplifiée raisonnable : une seule variante (weighted, sans spawn en bay de source), puis scoring inutile.

---

## 3. Défense de base

### 3.1 Tours (`process/rooms/owned/defense.ts:40-149`), chaque tick

```ts
towers = myTowers.filter(t => t.energy > 0 && t.isOperational());
hostiles = enemyCreeps hors alliés;
for (tower of towers) {
  if (attack(tower)) continue;
  if (heal(tower, enemyStrength)) continue;
  if (rampartRepair(tower, hostiles, enemyStrength)) continue;
}                      // aucune réparation de routes/containers par les tours

attack:
  target = room.getTowerTarget();       // §3.2
  if (!target) return false;
  if ((controller.safeMode ?? 1000) < 200          // fin de safe mode
      || target.pos.getRangeTo(25,25) <= 20        // pas collé au bord (évite le tower drain)
      || target.owner.username === 'Invader'
      || target.hits < target.hitsMax
      || canKillBeforeFleeing(target))
    return tower.attack(target) === OK;
canKillBeforeFleeing: dist = 24 - range(target, 25,25) ; if (dist <= 0) false ;
                      effectiveDamage(myDamage au pos) * dist > target.hits

heal:  candidats (cache 1 tick) = mes creeps blessés ayant ATTACK ou RANGED_ATTACK, ou tous si enemyStrength == 0 ; + power creeps blessés
       cible = min(hits/hitsMax / (1 + towerPowerAtRange(range)))
       towerPowerAtRange(r) = 1 - (clamp(r,5,20) - 5)/15 * TOWER_FALLOFF(0.75)     (prototype/structure.ts:164-169)

rampartRepair: seulement si enemyStrength >= NORMAL(2) et énergie tour >= 50% ;
       remparts à portée (3 si RANGED_ATTACK sinon 1) d'un hostile dangereux ; cible = min(hits / (1 + powerAtRange))
```

### 3.2 Choix de la cible (`manager.military.ts`)

- `assertMilitarySituation` (une fois par tick) : hostiles = creeps non-miens `isDangerous()` et non alliés. Puissance des tours propres comptée seulement si énergie >= `TOWER_ENERGY_COST*10` (100) (`:207-211`) : `myDamage[pos] += powerAtRange * TOWER_POWER_ATTACK (600)`. Creeps : ATTACK range 1 (30/part), RANGED range 3 (10/part), HEAL ennemi : range 3 `RANGED_HEAL_POWER` (4) + range 1 `HEAL_POWER-RANGED_HEAL_POWER` (8), parts boostées multipliées, parts à 0 hits ignorées (`:131-198`).
- `assertTargetPriorities` (`:290-306`) : `eff = getEffectiveDamage(myDamage)` (TOUGH boosté réduit) ; `factor = hits === hitsMax ? 1.1 : 1` ; si `eff > healing * factor` : `militaryPriority = militaryValue * (eff - healing) * (hitsMax/hits) * ttl / 1500`.
- `militaryValue = Σ parts (0.1 + 0.9*part.hits/100) * {ATTACK:1, RANGED:2, HEAL:5, CLAIM:10, WORK:1, autres 0}` (`:370-400`).
- `getTowerTarget` = creep de `militaryPriority` max (> 0), cache 1 tick (`:313-328`). Pas de cible => les tours ne tirent pas (ex : healer qui compense).
- `isDangerous` (`prototype/creep.military.ts:32-55`) : non allié et possède une part autre que MOVE/TOUGH (dans nos rooms, WORK/CARRY comptent) ; ou se trouve à <= 5 d'un de nos chantiers (stomp).

### 3.3 Force ennemie (`room-defense.ts:186-256`), cache 5 ticks

```ts
towerStrength = TOWER_POWER_ATTACK * nbTours / 2;
defCreep = 2 * ATTACK_POWER * min(25, floor(energyCapacityAvailable / 130));
normalThr = lowestWallStrength / 3000 ; highThr = lowestWallStrength / 1000;   // lowestWall = 0 si un rempart planifié manque
attack = Σ parts ATTACK(30)/RANGED(10)/CLAIM(15)/WORK(DISMANTLE_POWER 50) * boost ; heal = Σ HEAL(12) * boost
if (attack === 0) NONE(0)
else if (invaderOnly || (heal < towerStrength && attack < highThr)) WEAK(1)
else if (heal < towerStrength + defCreep && attack > normalThr) NORMAL(2)
else if (heal < towerStrength + defCreep && attack > highThr) STRONG(3)
else DEADLY(4)
```
`room.memory.enemies.safe` = aucun creep dangereux hors SK près de leur lair, pas d'invader core actif (`process/rooms/intel.ts:50-119`).

### 3.4 Safe mode (`defense.ts:154-236`), chaque tick

```ts
if (controller.safeMode || controller.safeModeCooldown || controller.safeModeAvailable === 0) return;
if (enemyStrength === NONE) return;
if (enemyStrength < NORMAL && Game.myRooms.length > 1) return;   // avec UNE seule room, même WEAK (dont invaders) peut déclencher
if (room.defense.isWallIntact()) return;     // tous les remparts planifiés (hors ramp) existent avec hits > 0
if (!mySpawns.length) return;
if (!isEnemyCloseToImportantStructures()) return;
controller.activateSafeMode();   // ERR_BUSY => abandon d'une autre room safe-modée seulement si RCL >= 6
```
Structures importantes : factory, lab, nuker, powerSpawn, **spawn, storage**, terminal, **le controller**, + leurs chantiers avec progress >= 10000. Proche = range <= 4 si l'ennemi a RANGED_ATTACK, sinon <= 2 ; une structure exige un creep `isDangerous()`, un chantier n'importe quel creep.
Remarque : à RCL1-2 il n'y a pas de remparts construits, donc `isWallIntact()` est faux dès qu'au moins un rempart est planifié => safe mode dès qu'un hostile (même invader, en mono-room) arrive à 2 cases d'un spawn ou du controller.

### 3.5 Spawn role `room-defense` (`spawn-role/room-defense.ts`), options en cache 10 ticks

| Option | Condition | Priorité | Corps |
|---|---|---|---|
| `brawler` | RCL < 4, safeMode <= 500, `memory.enemies` présent et non safe, < 2 brawlers | 5 | ATTACK seul + MOVE (move buffer 0.8, mode route) (`:46-58`, `:169-176`) |
| `guardian` | RCL >= 4, (force >= NORMAL ou safeMode < 300), < 5 guardians | 5 | ATTACK, ou RANGED si rangés < floor(total/4) (`:68-139`) |
| `builder` (réparation d'urgence) | RCL >= 4, ennemis non safe, énergie dispo >= 10000, force >= NORMAL, < 5 builders | 4 | WORK+CARRY, mode route (`:103-122`) |

Limite d'énergie des corps : `min(capacity, max(capacity*0.9, energyAvailable))`. Boosts seulement si force > NORMAL. Si force < NORMAL : pas de guardian (« les tours s'en chargent »).

### 3.6 Remplissage des tours (`dispatcher/resource-destination/tower.ts:25-55`)

Tours < 80% de capacité : priorité 3 (+1 si ennemis non safe, +1 si < 20%) - 2 par creep déjà assigné ; poids = manque/100. Dans Hivemind, la priorité la plus haute est servie d'abord (`utilities.getBestOption`).

---

## 4. Points d'attention pour le portage

1. Itération row-major des positions planifiées (y puis x) : impacte l'ordre des chantiers dans une même catégorie.
2. 5 chantiers max par room, manager toutes les 100 ticks => en RCL2 la progression des extensions est limitée par ce cycle si les builders finissent vite (Hivemind compense via `runNextTick` seulement pour spawn/extractor détruits). On peut réduire l'intervalle chez nous.
3. Aucune route en plaine avant RCL4 + storage ; routes source/controller **sur marais** dès RCL2.
4. Containers source + controller dès RCL2 ; container controller = case de l'upgrader principal, avec route dessous.
5. Spawn initial jamais déplacé en RCL1-4 ; le plan peut prévoir `spawn.0` ailleurs => il sera construit à RCL7 (quand le quota passe à 2). Pour notre bot, ancrer le plan sur le spawn existant est un écart volontaire à envisager.
6. Pas de construction (sauf invaders seuls) quand un joueur attaque sans safe mode.
7. Le safe mode mono-room se déclenche aussi pour des invaders (WEAK) si les remparts ne sont pas complets.
