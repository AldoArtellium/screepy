# Hivemind — spécification de portage : comportement des creeps & logistique (RCL 1-4, room unique)

Source : `C:\Users\ruffa\AppData\Local\Temp\bots\hivemind\src` (MIT). Toutes les références `fichier:ligne` sont relatives à `src/`.
Périmètre : roles `harvester`, `transporter`, `builder`, `upgrader` + dispatcher de ressources (sources/destinations). Remote, combat, labs, power, factory ignorés sauf mention.

---

## 0. Conventions transverses

### 0.1 Ordre d'exécution du tick
- `main.ts:127-140` : process `init` → `creeps` → `rooms` (spawns, tours, room planner, room manager tournent APRÈS les creeps).
- `process/creeps.ts:86-114` : pour chaque rôle de `Game.creepsByRole` (ordre d'insertion = ordre de `Game.creeps`), `creepManager.manageCreeps(creeps)` ; puis power creeps ; puis **`trafficManager.manageTraffic()` en dernier** (résolution des embouteillages).
- `creep-manager.ts:130-164` `runCreepLogic` : skip si `creep.spawning` ; throttle (voir 0.4) ; `role.preRun(creep)` puis `role.run(creep)`.
- `role/role.ts:39-47` `preRun` : si `containSingleRoomCreep()` → ne pas exécuter `run` ; idem si boostManager prend la main.
- `role/role.ts:58-92` `containSingleRoomCreep` : si `memory.singleRoom` défini — hors room → `whenInRange(10, (25,25,singleRoom))` et return true ; dans la room mais sur un bord (x/y = 0 ou 49) → `move(RIGHT|BOTTOM|LEFT|TOP)`, `say('unstuck!')`, efface `memory.go` + chemin, return true. Harvester est spawné avec `singleRoom: room.name` (`spawn-role/harvester.ts:214-219`).

### 0.2 `whenInRange(range, target, cb)` — `prototype/creep.movement.ts:157-185`
```ts
whenInRange(range, target, cb) {
  target = target.pos ?? target;
  TrafficManager.setPreferredArea(this, target, range);   // ← enregistré à CHAQUE appel, même à portée
  if (this.pos.getRangeTo(target) > range) { this.moveToRange(target, range); return; }
  cb();
}
```
Équivalent direct de notre `requestMove` "stay in range". `creep.whenInRange(1, creep, () => {})` = "rester sur place" (idiome d'attente).

### 0.3 `utilities.getBestOption(options)` — `utilities.ts:141-152`
```ts
best = null;
for (o of options) {
  if (o.priority < 0) continue;                 // priorité négative = jamais choisie
  if (!best || o.priority > best.priority || (o.priority === best.priority && o.weight > best.weight)) best = o;
}
return best;
```
**Priorité plus HAUTE = plus important** (inverse de notre TaskQueue). Égalité départagée par `weight` le plus grand. Priorité 0 reste choisissable (sauf builder, cf. §4.4).

### 0.4 Throttle CPU — `creep-manager.ts:110-122`, `utils/throttle.ts`
- Jamais de throttle sur un bord de room. Si `cpu.getUsed() > tickLimit*0.85` → throttle tout.
- Sinon `throttle(offset, role.stopAt, role.throttleAt)` : bucket >= throttleAt → tourne ; bucket < stopAt → ne tourne pas ; entre les deux, probabiliste.
- Valeurs : Role par défaut `throttleAt 8000 / stopAt 2000` (`role/role.ts:31-32`) — **builder** utilise ces défauts ; harvester `2000/0` (`role/harvester.ts:39-40`), transporter `5000/0` (`role/transporter.ts:70-71`), upgrader `2000/0` (`role/upgrader.ts:33-34`).

### 0.5 Réservation par comptage : `room.getCreepsWithOrder(type, target)` — `prototype/room.creeps.ts:24-33`
```ts
getCreepsWithOrder(type, target) = room.creeps.filter(c =>
  c.memory.order && c.memory.order.type === type
  && (!c.memory.order.target || c.memory.order.target === target)
  && (!c.memory.order.name   || c.memory.order.name === target));
```
- Pas de quantités réservées : chaque provider **diminue la priorité** de l'option de `N_creeps_ayant_déjà_cet_ordre × k` (k = 2 ou 3 selon le provider). Le comptage porte sur TOUS les creeps de la room (rôle quelconque) ayant `memory.order` de ce type/cible, sauf mention (spawn/extension : seulement les transporters).
- Les ordres builder (`build`/`repair`) et les ordres de transport partagent la même clé `memory.order`.
- `room.creeps` = creeps physiquement dans la room (`prototype/creep.ts:121-147`), pareil pour `room.creepsByRole`.

### 0.6 Cycle de vie des dispatchers et cache
- `room.sourceDispatcher` / `room.destinationDispatcher` : `cache.inObject(room, …, 1)` (`prototype/room.resources.ts:86-98`) → recréés chaque tick (l'objet Room est neuf chaque tick).
- `TaskProvider.cacheEmptyTaskListFor(key, timeout, cb)` (`dispatcher/task-provider.ts:18-38`) : si la liste est **vide**, on ne recalcule plus pendant `timeout` ticks. Comme le provider vit un tick, l'effet pratique est : "le premier creep qui ne trouve rien ce tick → les suivants du même tick sautent ce provider". (À porter tel quel si on garde les providers en heap, ce qui donne le vrai sens au timeout.) Les listes non vides sont recalculées à chaque appel (le weight dépend du creep).

### 0.7 Dispatcher générique — `dispatcher/dispatcher.ts:9-52`
```ts
getTask(context, validator?) {
  options = []; highest = -10;
  for (p of providers sorted by -p.getHighestPriority(context)) {      // l.37-38
    if (p.getHighestPriority(context) < highest) break;                // l.14 : élagage
    for (o of p.getTasks(context)) {
      if (o.priority < highest) continue;
      if (!p.isValid(o, context)) continue;
      if (validator && !validator(o, context)) continue;
      options.push(o); highest = max(highest, o.priority);
    }
  }
  return getBestOption(options);                                       // l.26
}
validateTask(task, ctx) = providers[task.type].isValid(task, ctx);
executeTask(task, ctx)  = providers[task.type].execute(task, ctx);
```
Providers enregistrés : destinations `bay, container, drop, factory, lab, link, nuker, powerSpawn, spawn, storage, terminal, tower, workerCreep` (`dispatcher/resource-destination/dispatcher.ts:32-44`) ; sources `container, drop, factory, grave, lab, link, overfullExtension, storage` (`dispatcher/resource-source/dispatcher.ts:27-34`).

Contexte : `{creep, resourceType?, ignoreStoreContent?}`.

---

## 1. Dépendances au room planner (et repli)

| Usage | Clé planner | Code | Repli sans planner |
|---|---|---|---|
| Position de récolte d'un harvester | `harvester.<sourceId>` (1 tuile adjacente à la source, celle qui maximise les tuiles constructibles autour) | `role/harvester.ts:98-109`, `room/planner/variation-builder.ts:111-160` | `memory.noHarvestPos = true` → va à portée 1 de la source |
| La même tuile est aussi `harvester`, `bay_center`, `container.source`, `container` | | `variation-builder.ts:117-120, 328-331` | — |
| Bays (extensions autour d'une tuile centrale) | `bay_center` ; bays de source : extensions `extension.harvester` + 1 link `link.source` + éventuellement 1 spawn autour de la tuile de récolte | `prototype/room.intel.ts:198-221`, `variation-builder-base.ts:52-108` | `room.bays = []` (pas de planner ⇒ pas de bay) |
| Centre de base / emplacement de dépôt au sol avant storage | `center` (storage planifié en center+(0,1)) | `prototype/room.resources.ts:333-338`, `room/planner/room-planner.ts:223-230`, `variation-builder.ts:350-366` | `getRoomCenter()` sans `center` → (25,25). **Sans planner du tout** : `storage ? storage.pos : null` |
| Container de contrôleur | `container.controller` | `prototype/room.intel.ts:261-283` | tout container à portée ≤ 3 du contrôleur |
| Container de source | `container.source` à portée ≤ 5 de la source | `manager.source.ts:122-149` (cache heap 150 ticks) | tout container à portée ≤ 5, le plus proche |
| Position de l'upgrader unique | `upgrader.0` (1ère tuile de la route du contrôleur) | `role/upgrader.ts:89-98`, `variation-builder.ts:198` | `moveToRange(controller, 3)` |
| Routes réparées | `road` planifiée ou route d'opération | `role/builder.ts:379-385` | sans planner, `isPlannedRoad` falsy → seules les routes d'opération sont réparées (!) |
| Ramparts / murs réparés | `rampart`, `wall`, `wall.quad`, `rampart.ramp`, `wall.blocker`, `wall.deco` | `role/builder.ts:387-447` | sans planner : tous réparés |

`room.roomPlanner` n'existe que pour les rooms à moi et quand la segment memory est prête (`process/init.ts:73-76`).

`room.memory.controllerContainer` est mis à jour par `room.scan()` toutes les 10 ticks (`prototype/room.intel.ts:242-255`).

---

## 2. HARVESTER — `role/harvester.ts`

### 2.1 Mémoire
`harvesting?: boolean`, `fixedSource: Id<Source>` (toujours défini au spawn, `spawn-role/harvester.ts:216-218`), `fixedMineralSource?`, `harvestPos?: number` (coords sérialisées), `noHarvestPos?: boolean`, `order?` (emprunté au transporter pour livrer). Heap : `suicideSpawn?`.

### 2.2 Machine à états — `run()` l.51-76
```ts
if (heap.suicideSpawn) return performRecycle();                         // l.52-55
transporterRole.creep = creep;                                          // l.59 (réutilise la logique transporter)
isStationary = (fixedSource || fixedMineralSource) && size(room.creepsByRole.transporter) > 0;   // l.86-88
if (!harvesting && store.used === 0)               setState(true);      // l.61-62, 78-80
else if (harvesting && store.free === 0 && !isStationary) setState(false);  // l.64-68, 82-84
// setState(h): memory.harvesting = h; delete memory.resourceTarget     // l.119-122
if (harvesting) performHarvest(); else performHarvesterDeliver();
```
Au spawn `harvesting` est undefined et le store vide ⇒ passe à `true` au 1er tick.
**Point clé** : dès qu'il existe ≥ 1 transporter dans la room, le harvester ne quitte JAMAIS l'état récolte (stationnaire) ; plein, il continue `harvest()` → le surplus tombe au sol (comportement moteur) ou dans le container sous lui.

### 2.3 `performHarvest()` l.130-186
```ts
source = getObjectById(fixedSource);   // minerai : recycle si mineralAmount <= 0 (l.136-148)
determineHarvestPosition(source);      // l.98-109 : une seule fois ; _.sample(planner.getLocations('harvester.'+id)) sinon noHarvestPos
targetPos = source.pos; range = 1;
if (harvestPos && aucun creep sur harvestPos) { targetPos = harvestPos; range = 0; }      // l.157-163
container = source.getNearbyContainer();
if (container && container.pos.getRangeTo(targetPos) > 1
    && store.free < WORK * HARVEST_POWER /*2*/) { targetPos = container.pos; range = 1; } // l.166-175
whenInRange(range, targetPos, () => {
  harvest(source);
  if (depositInBay()) return;        // l.181
  depositResources(source);          // l.184
});
```
Note : si un autre creep occupe `harvestPos`, le harvester se contente de portée 1 de la source.

### 2.4 `depositInBay()` l.197-209 (remplissage des extensions par le harvester)
```ts
if (!harvestPos) return false;
bay = room.bays.find(b => b.name === encode(harvestPos));
if (!bay || creep.pos !== bay.pos) return false;
if (store.used >= store.capacity * (bay.needsRefill() ? 0.6 : 1)) bay.refillFrom(creep);   // seuil 60 % si la bay a besoin
if (bay.needsRefill()) pickupEnergy();   // l.217-230 : pickup énergie au sol sous lui, sinon withdraw du container sous lui (si >0)
return bay.energyCapacity > 0;           // true ⇒ on SAUTE depositResources (pas de link/container/creeps adjacents)
```
Donc une bay de source avec ≥ 1 extension/spawn opérationnel désactive `depositResources` ; le container sous le harvester reçoit passivement le surplus (drop sur la tuile = container).

### 2.5 `depositResources(source)` l.240-310
```ts
if (store.free >= WORK * HARVEST_POWER) return;        // l.242 : n'agit que si "presque plein" (place < 1 tick de récolte)
container = source.getNearbyContainer();
// (a) Construire son propre container — l.246-260
if (!container
    && store.energy > max(WORK * BUILD_POWER /*5*/, capacity - WORK * HARVEST_POWER)
    && room.creepsByRole.builder.filter(c => c.store.free > 20).length === 0) {
  sites = source.pos.findInRange(FIND_CONSTRUCTION_SITES, 3, {structureType: CONTAINER});
  if (sites.length) { whenInRange(3, sites[0], () => build(sites[0])); return; }
}
// (b) cible structure — l.262-282
target = container; if (target?.store.free === 0) target = null;
if (source is Source && store.energy > 0) {
  link = source.getNearbyLink();                       // link à portée ≤ 3 (cache 1000)
  if (link && link.free(energy) > 0) target = link;
  else { l = myLinks.filter(free>0 && range(source) <= 3)[0]; if (l) target = l; }
}
if (target) whenInRange(1, target, () => {
  if (target is container && distance === 0) {/* rien : le surplus tombe dedans */}
  else transferAny(target);                            // prototype/creep.ts:91-100 (1er type de ressource ; énergie seulement pour link)
});
// (c) livraison aux creeps adjacents (RCL < 6) — l.296-309
if (controller.level < 6 && store.energy > 0) {
  near = pos.findInRange(FIND_MY_CREEPS, 1, c => ['transporter','upgrader','builder','builder.remote'].includes(c.memory.role) && c.store.free > 0);
  if (near.length) { t = _.sample(near); transfer(t, ENERGY, min(store.energy, t.store.free)); }
}
```
NB : (b) et (c) peuvent tous deux émettre une intention ce tick (le moteur n'en garde qu'une de type transfer).

### 2.6 `performHarvesterDeliver()` l.318-328 (état livraison, uniquement sans transporter)
```ts
if (!fixedSource && !fixedMineralSource) return;
if (size(room.creepsByRole.transporter) === 0) { transporterRole.performDeliver(); return; }  // §3.3, même dispatcher de destinations
setState(true);   // un transporter est apparu → retour récolte
```
Sans transporter : le harvester plein livre comme un transporter (spawn/extension prio 5/4, tower, workerCreep, container contrôleur, drop au centre…). Il ne repasse en récolte qu'à store vide (`hasFinishedDelivering`).
Cas limite : `calculateDeliveryTarget` sans cible et `store.free > 0` appelle `setDelivering(false)` (sans effet pour un harvester sauf effacer `order`) ; il attend sur place. Sans storage il y a toujours une option `drop` pour l'énergie (§3.6.h) donc ça n'arrive quasi pas.

### 2.7 Recyclage — `role/role.ts:94-117`
`heap.suicideSpawn` = spawn le plus proche par chemin (si aucun → `suicide()`) ; `whenInRange(1, spawn, () => spawn.recycleCreep(creep))`.

---

## 3. TRANSPORTER — `role/transporter.ts` (+ sert de bibliothèque d'acquisition/livraison aux autres rôles)

### 3.1 Mémoire
`delivering?: boolean`, `order?: ResourceSourceTask | ResourceDestinationTask` (contient `type`, `priority`, `weight`, `resourceType`, `amount?`, `target?` ou `name` pour une bay). Heap : `idlingFor?: number`.

### 3.2 `run()` l.80-130
```ts
// 1. ordre ciblant hors singleRoom → setDelivering(delivering) (= efface l'ordre)       l.84-89
// 2. attente : if (heap.idlingFor > 0) { idlingFor--; whenInRange(1, creep); say('⌛n'); return; }   l.92-97
if (used >= capacity * 0.9 && !order && !delivering) setDelivering(true);             // l.99-105
else if (used <= capacity * 0.1 && delivering && !order
         && aucune ressource non-énergie > 0) setDelivering(false);                      // l.106-113
// setDelivering(d): memory.delivering = d; delete memory.order                         // l.138-141
if (unblockBayIfNeeded()) return;                                                       // l.115, 149-176
if (delivering) return performDeliver();
// Ne pas stationner sur la tuile de dépôt au sol (avant storage) :
if (!room.storage && storageLoc && pos == storageLoc && (!order || !('target' in order)))
  { move(random 1..8); return; }                                                        // l.123-127
performGetResources();
```
Important : les bascules 90 %/10 % ne se font **que sans ordre en cours** ; un ordre en cours va à son terme (ou est invalidé).

`unblockBayIfNeeded` (l.149-176) : si le creep est sur le centre d'une bay non bloquée, et n'est ni en train de livrer CETTE bay (ordre `bay` avec `name` = bay) ni de pomper une `overfullExtension` à portée ≤ 1 de la bay → si `bay.getPossibleExitTiles().length === 1`, `move(dir vers cette sortie)` et return true.

### 3.3 Livraison — `performDeliver()` l.181-193, `ensureDeliveryTaskValidity()` l.201-216, `calculateDeliveryTarget()` l.221-231
```ts
performDeliver() {
  if (!ensureDeliveryTaskValidity(order)) { whenInRange(1, creep); delete order; return; }
  destinationDispatcher.executeTask(order, {creep});
}
ensureDeliveryTaskValidity(order) {
  if (!order) { order = memory.order = destinationDispatcher.getTask({creep});
                if (!order && store.free > 0) setDelivering(false); }
  if (!order) return false;
  return isDestinationOrder(order) && destinationDispatcher.validateTask(order, {creep});  // revalidé CHAQUE tick
}
```
Pas de `resourceType` dans le contexte de livraison : toutes destinations considérées, filtrées par le contenu du creep via `isValid` (`creep.store[resourceType] > 0` sauf `ignoreStoreContent`).

### 3.4 Collecte — `performGetResources()` l.239-266, `ensureSourceTaskValidity()` l.277-300
```ts
performGetResources(cb = calculateSource) {
  if (!ensureSourceTaskValidity(order, cb)) {
    delete order; whenInRange(1, creep);
    if (role === 'transporter') setDelivering(used > capacity * 0.1);   // livre ce qu'il a s'il ne trouve plus rien
    return;
  }
  sourceDispatcher.executeTask(order, {creep});
}
ensureSourceTaskValidity(order, cb) {
  if (!order) { cb(); order = memory.order; }
  if (!order) {
    if (used > 0) { setDelivering(true); return false; }
    heap.idlingFor = 5; return false;                    // 5 ticks d'attente (consommés seulement par transporter.run)
  }
  return isSourceOrder(order) && sourceDispatcher.validateTask(order, {creep});
}
```

### 3.5 `calculateSource()` l.305-350 / `getSource()` l.358-370
```ts
getSource() = sourceDispatcher.getTask({creep, resourceType: (terminal||storage) ? null : ENERGY});  // sans storage : énergie seulement
calculateSource() {
  best = getSource();
  if (terminal || storage) {
    dest = destinationDispatcher.getTask({creep, ignoreStoreContent: true},
                                         t => room.getCurrentResourceAmount(t.resourceType) > 0);
    if (destinationHasHigherPriority(dest, best)) {        // l.383-391 : dest.prio > src.prio, ou égal et dest.weight > src.weight ; !best ⇒ true
      src = sourceDispatcher.getTask({creep, resourceType: dest.resourceType},
                                     t => !(t.target && dest.target) || t.target !== dest.target);  // ne pas prendre là où on livre
      if (src) best = src;
    }
  }
  memory.order = best ?? (delete);
}
```
⇒ Avec storage (RCL4), un transporter vide va d'abord chercher la ressource pour la destination la plus prioritaire (ex. spawn prio 5 → source `storage` prio 2 avec resourceType énergie) plutôt que la meilleure source brute.

### 3.6 `performGetEnergy(creep)` l.399-404 / `calculateEnergySource()` l.409-425 (utilisé par builder, upgrader)
```ts
performGetEnergy(c) { this.creep = c; performGetResources(() => {
  best = getBestOption([ sourceDispatcher.getTask({creep, resourceType: ENERGY}) ].filter(Boolean));
  memory.order = best ?? delete;
}); }
```
Pour un non-transporter : échec ⇒ `delete order; whenInRange(1, creep)` et éventuellement `memory.delivering = true` (inoffensif) ; `idlingFor` est écrit mais pas consommé.

---

## 4. Providers de DESTINATION (RCL 1-4)

Base `StructureDestination` — `dispatcher/resource-destination/structure.ts:26-56`
```ts
isValid(t, ctx) = s exists && s.isOperational() && (!singleRoom || s.room === singleRoom)
                  && s.store.free(t.resourceType) > 0
                  && (ctx.ignoreStoreContent || ctx.creep.store[t.resourceType] > 0);
execute(t, ctx) {
  if (creep.store[t.resourceType] === 0) { delete order; return; }
  whenInRange(1, target, () => {
    transfer(target, t.resourceType, t.amount ? min(t.amount, creep.store[rt], target.free(rt)) : undefined);
    delete order;                         // l'ordre se termine après UN transfert (même s'il reste de l'énergie)
  });
}
```

### 4.a `spawn` — `resource-destination/spawn.ts` (highestPriority 5)
- Seulement énergie. `cacheEmptyTaskListFor('', 5)`.
- Cibles : spawns avec `free>0` et (`!isBaySpawn()` **ou RCL < 3**) ; extensions avec `free>0` et `!isBayExtension()` (l.27-33). Les extensions de bay sont gérées par le provider `bay`.
- `priority = spawn ? 5 : 4` ; `amount = free` ;
  `weight = min(creep.energy, free)/creep.capacity + 1 - range/100` (l.45-46) ;
  `priority -= 3 × (nb de TRANSPORTERS ayant l'ordre spawn sur cette cible)` (l.47).

### 4.b `bay` — `resource-destination/bay.ts` (highestPriority 5)
- Seulement énergie. Pour chaque `room.bays` : `priority 5`, `amount = energyCapacity - energy`, `weight = min(creep.energy, manquant)/capacity + 1 - range/100`, `priority -= 3 × getCreepsWithOrder('bay', bay.name)` (l.29-44).
- `isValid` (l.50-58) : bay existe, `energy < energyCapacity`, **`!bay.hasHarvester()`** (un harvester sur le centre la remplit lui-même), creep porte de l'énergie.
- `execute` (l.60-91) : `whenInRange(0, bay.pos)` (aller SUR le centre) puis `bay.refillFrom(creep)` ; si false → fin d'ordre + sortir via `getExitPosition()` (tuile de route planifiée adjacente). En route (range > 0), transférer opportunément dans une extension/spawn de la bay adjacente (pas container ni link) ayant de la place.
- Classe Bay — `manager.bay.ts` : structures de bay = spawn, extension, tower, link, container à portée ≤ 1 du centre, opérationnelles (cache 250, l.46-63) ; `energy`/`energyCapacity` ne comptent que spawn+extension (l.73-76). `isBlocked()` (l.80-114, cache 100) : structure non-walkable sur le centre, ou extension sur-remplie, ou storage/terminal/factory/lab/nuker/powerSpawn à portée 1 ⇒ bay vide (aucune extension). `refillFrom` (l.161-182) : cible = structure manquante d'énergie avec l'index le plus bas dans `[spawn, extension, tower, link, container]` ; un harvester ne remplit pas le container sur lequel il est ; retourne false si c'est le dernier transfert nécessaire. `hasHarvester` : centre = position `harvester` et un de mes creeps `harvester` dessus (`prototype/room.intel.ts:206-210`).

### 4.c `tower` — `resource-destination/tower.ts` (highestPriority 5)
- Seulement énergie. `cacheEmptyTaskListFor('', 25)`.
- Tours avec `energy < 0.8 × capacity` (l.27). `priority 3` ; `weight = (cap - energy)/100` ; `amount = cap - energy` ;
  `+1` si `room.memory.enemies && !enemies.safe` ; `+1` si `energy < 0.2 × cap` ; `-2 × getCreepsWithOrder('tower', id)` (l.30-47).

### 4.d `container` (container de contrôleur) — `resource-destination/container.ts` (highestPriority 4)
- Seulement énergie. `cacheEmptyTaskListFor('', 25)`. Uniquement si la room a des upgraders **ou** des builders et `memory.controllerContainer` existe (l.36-39).
- ```ts
  upgraderWork = sum(upgraders, WORK actifs);
  refillPathLength = heap(5000, 'ccRefillPathLength:'+room) = path(storageLocation → container).length (1 si pas de storageLocation / incomplet);
  needed = container.free + upgraderWork * UPGRADE_CONTROLLER_POWER(1) * refillPathLength
           - sum(creeps ayant l'ordre container/ce container, energy portée);
  option = {priority 4, weight needed/100, amount needed};
  if (needed/cap < 0.5) priority -= 2; else if (needed/cap < 0.75) priority -= 1;      // l.65-71
  ```
- `isValid` spécifique (l.76-100) : pas de test "free>0" global ; un container plein invalide seulement si on est déjà à portée 1 ; recalcul `needed` avec `refillPathLength = range(creep, container)` et en ne décomptant que les autres livreurs plus proches que soi ; invalide si `needed <= 0`.

### 4.e `workerCreep` (livraison directe aux builders/upgraders) — `resource-destination/worker-creep.ts` (highestPriority 2)
- Seulement énergie. `cacheEmptyTaskListFor('', 25)`.
- Actif seulement si **ni storage ni terminal**, ou si `enemyStrength > NORMAL(2)` (l.46-51).
- Rôles et poids : `builder.remote 2`, `builder 1.5`, `upgrader 0.5` ; hors builder ignorés si `enemyStrength > NORMAL` (l.30-40).
- Par creep cible non-spawning dont `free >= capacity/3` (l.55-56) : `priority = 2 - 3 × getCreepsWithOrder('workerCreep', id)`, `weight = roleWeight + min(1, cible.free / porteur.energy)`, `amount = porteur.energy` (l.58-65).
- `isValid` (l.69-78) : cible existe, non spawning, `free >= capacity/5`, même room, porteur a de l'énergie. `execute` : `whenInRange(1, cible)` puis transfer `min(amount, porté, free)` et fin d'ordre.
- Côté récepteurs : builder (l.131-135) et upgrader (l.202-205) **vont à la rencontre** du premier creep qui a un ordre `workerCreep` vers eux (`moveToRange(livreur, 1)`).

### 4.f `storage` — `resource-destination/storage.ts` (highestPriority 0)
- Pour chaque ressource portée : `target = room.getBestStorageTarget(amount, rt)` (`prototype/room.resources.ts:513-517` : sans terminal → `storage`) ; option `priority 0, weight amount/100, amount`. Sans storage/terminal : aucune option.

### 4.g (hors périmètre bref) `link`, `terminal`, `lab`, `factory`, `nuker`, `powerSpawn` : inexistants ou inactifs RCL ≤ 4 (link dès RCL5).

### 4.h `drop` — dépôt au sol — `resource-destination/drop.ts` (highestPriority 0)
- `cacheEmptyTaskListFor(context.resourceType || '', 100)`.
- Pour chaque ressource portée : si `getBestStorageTarget` renvoie une cible (et ne bloquerait pas le terminal) → pas d'option ; **sinon (pas de storage ni terminal) → `{priority 0, weight 0, type 'drop', amount}`** (l.36-51).
- `execute` (l.60-76) : si énergie et pas sur `room.getStorageLocation()` → `whenInRange(0, storageLocation, () => drop() === OK && delete order)` ; sinon `drop()` sur place. ⇒ **Avant le storage, l'énergie excédentaire est empilée au sol sur le centre de base** (tuile où sera bâti… le centre ; le storage est planifié à center+(0,1)). Cette pile est ensuite une source (`drop`, §5.b) de faible priorité pour les transporters, prioritaire (4) pour les autres.
- Sans planner ET sans storage, `getStorageLocation()` = null → `getRangeTo(null)` : comportement indéfini (à éviter dans le portage : repli = drop sur place ou tuile près du spawn).

**Ordre effectif d'une livraison (sans storage)** : spawn 5 = bay 5 > extension 4 = container-contrôleur 4 (2-3 si peu de besoin) = tour 3-5 > workerCreep 2 (-3/porteur déjà assigné) > drop 0. Les décréments de réservation font basculer vers la cible suivante.

---

## 5. Providers de SOURCE (RCL 1-4)

Base `StructureSource` — `resource-source/structure.ts:27-55`
```ts
isValid = t.resourceType && s exists && s.store[rt] > 0 && creep.store.free(rt) > 0 && position sûre (danger matrix si ennemis);
execute = whenInRange(1, s, () => { r = withdraw(s, rt, t.amount ? min(s.store[rt], order.amount, creep.free) : undefined); if (r === OK) delete order; });
```

### 5.a `container` — `resource-source/container.ts` (highestPriority 4)
Énergie (l.31-85), si `resourceType` absent ou énergie :
```ts
for (c of containers where c.energy > creep.capacity * 0.1) {
  o = {priority 1, weight c.energy/100};
  if (c.id === memory.controllerContainer && (upgraders || builders) && creep.role === 'transporter') continue;  // l.49-55
  if (c est le container d'une source) {                                                                    // l.57-66
    o.priority += 1;
    if (c.used >= creep.free && (energyAvailable >= energyCapacityAvailable || !room.storage || role !== 'transporter'))
      o.priority += 2;                                    // → 4 : container qui se remplit
  }
  if (c est sur un bay_center ET position 'harvester' && c.used < c.capacity/3) o.priority = -1;   // l.68-79 : laisser l'énergie au harvester-bay
  o.priority -= 3 × getCreepsWithOrder('container', c.id);                                          // l.81
}
```
Non-énergie (l.87-123) : seulement avec storage/terminal ; prio 3, `weight amount/20`, `-2 × assignés` ; le minerai assigné n'est sorti qu'à ≥ `CONTAINER_CAPACITY/2`.
NB : le container contrôleur RESTE une source pour builders/upgraders (prio 1).

### 5.b `drop` (ressources au sol) — `resource-source/drop.ts` (highestPriority 5)
```ts
resources = room.find(FIND_DROPPED_RESOURCES, r => r.amount >= 10 && PathFinder.search(creep.pos, r.pos) complet);   // l.35-44
for (r of resources) {
  if (ctx.resourceType && ctx.resourceType !== r.resourceType) return;   // ⚠ bug : `return` au lieu de `continue` (l.47) — arrête toute la liste
  o = {priority 4, weight r.amount / (energy ? 100 : 30)};
  if (power) o.priority++;
  else if (energy) {
    if (r.pos == storageLocation)   // pile du centre de base
      o.priority = role === 'transporter' ? ((storage || terminal) ? 1 : 0) : 4;   // l.64-66
    else {
      if (r.amount < 100) o.priority--; if (r.amount < 200) o.priority--;          // <100 → 2, <200 → 3
      if (energyAvailable < energyCapacityAvailable && getCurrentResourceAmount(ENERGY) > 5000 && role === 'transporter') o.priority -= 2;
      if (storage && getFreeStorage() < r.amount && effectiveEnergy > 20000) o.priority -= 2;
    }
  }
  if ((storage || terminal) && getFreeStorage() < r.amount) continue;
  if (r.amount < creep.capacity * 2) o.priority -= 2 × getCreepsWithOrder('drop', r.id);   // réservation seulement pour petits tas
}
isValid: existe, amount > 0, creep a de la place, position sûre.
execute: whenInRange(1, r, () => pickup(r));    // l'ordre n'est pas effacé : il devient invalide (plein / tas vide) au tick suivant
```
`getCurrentResourceAmount(ENERGY)` = storage + terminal + énergie portée par les transporters (+ haulers si pas de storage) (`prototype/room.resources.ts:158-192`).

### 5.c `grave` (tombstones + ruines) — `resource-source/grave.ts` (highestPriority 5)
Cibles avec `store.used > 10` ; une option par ressource : `priority 4`, `weight amount/(energy?100:30)`, power +1, énergie : `<100 → -1`, `<200 → -1`, mêmes malus transporter (-2) et storage plein (-2) que `drop` ; `continue` si `getFreeStorage() < amount` ; `-2 × getCreepsWithOrder('grave', id)` si `used < 2 × creep.capacity`. `execute` : `whenInRange(1) withdraw(rt)`.
`getFreeStorage()` sans storage : limite par défaut incluant +10000 "au sol" (`prototype/room.resources.ts:118-146`).

### 5.d `storage` — `resource-source/storage.ts` (highestPriority 3)
- Rien sans `room.storage` (l.23).
- Énergie (l.35-55) : **seulement si `ctx.resourceType === ENERGY`** (jamais pour une requête "toutes ressources") ; source = `getBestStorageSource(ENERGY)` ; option `priority 2, weight 0` si `role === 'transporter'` **ou** `storage.energy > 5000` (les non-transporters ne descendent pas le storage sous 5000).
- Autres (fallback minerais prio 0, vidage storage/terminal) : RCL ≥ 6, ignorer.

### 5.e `overfullExtension` — `resource-source/overfull-extension.ts` (highestPriority 5)
Extensions avec `energy > capacity` (non opérationnelle ⇒ capacity 0, après down-grade RCL) : `priority 5`, `weight = 1 - range/100 - (opérationnelle ? 0 : 0.5)`, `-2 × assignés`. `cacheEmptyTaskListFor('', 1500)`. ⚠ `amount` calculé à 0 (bug `used - used`, l.37) ⇒ withdraw sans montant via `task.amount` falsy → retire tout.

### 5.f Récap priorités de source (énergie, RCL 1-4, sans storage)
| Source | Transporter | Builder/Upgrader |
|---|---|---|
| tas au sol hors centre ≥ 200 | 4 (2 si spawn non plein & stock > 5000) | 4 |
| tas 100-199 / < 100 | 3 / 2 | 3 / 2 |
| tombstone/ruine (énergie) | 4 / 3 / 2 idem | idem |
| container de source qui se remplit (`used >= creep.free`) | 4 | 4 |
| container de source sinon | 2 | 2 |
| autre container (> 10 % capa creep) | 1 | 1 |
| container contrôleur | exclu (si upgraders/builders) | 1 |
| pile au centre (storageLocation) | 0 (1 avec storage) | 4 |
| storage (RCL4) | 2 | 2 si > 5000 |
Toutes : `-3` (container) ou `-2` (drop/grave petits tas) par creep déjà assigné.

---

## 6. BUILDER — `role/builder.ts`

### 6.1 Mémoire
`repairing?: boolean` (= "en train de travailler", build OU repair), `upgrading?: boolean`, `order?: {type:'repair', target, maxHealth} | {type:'build', target}`, `sourceTarget?` (legacy). Room : `memory.noBuilderNeeded?: number` (tick).

### 6.2 `run()` l.83-144
```ts
if (heap.suicideSpawn) return performRecycle();
dumpResources();                  // l.146-154 : drop la 1ère ressource non-énergie portée
if ((repairing || upgrading) && energy === 0)                 setBuilderState(false);   // l.91-92
else if (!repairing && !upgrading && used >= capacity * 0.9)  setBuilderState(true);    // l.94-95
// setBuilderState(r): repairing = r; delete upgrading, sourceTarget, order          // l.164-169
if (upgrading) return performUpgrade();
if (repairing) {
  if (!performRepair() && (enemyStrength < NORMAL(2) || safeMode)) {                    // l.104-106
    room.memory.noBuilderNeeded = Game.time;
    if (RCL < 8 && !funnelingElsewhere && !stripmine && !controller.upgradeBlocked) {
      upgrading = true; delete repairing; performUpgrade();                              // l.112-116 : rien à faire → upgrade
    } else if (!isMovingMisplacedSpawn) { delete repairing; performRecycle(); }
  }
  return;
}
// collecte
if (sourceTarget && !order) delete sourceTarget;
livreurs = room.getCreepsWithOrder('workerCreep', creep.id);
if (livreurs.length) { moveToRange(livreurs[0], 1); return; }                           // l.131-135
if (!room.storage || room.getEffectiveAvailableEnergy() > 2500)                        // l.137
  transporterRole.performGetEnergy(creep);                                              // §3.6 (pas de harvest !)
// sinon : storage présent et < 2500 → reste inactif
```
Seuils : commence à travailler à **90 %** plein, retourne chercher à **0** énergie. Hivemind : **les builders ne récoltent jamais** une source.

### 6.3 `performUpgrade()` l.171-208 (builder en mode upgrade)
```ts
if (isMovingMisplacedSpawn || (enemyStrength >= NORMAL && !safeMode) || room.find(FIND_MY_CONSTRUCTION_SITES).length > 0) {
  delete upgrading; delete room.memory.noBuilderNeeded; return;   // un site apparaît → retour build au tick suivant (repairing reste false → re-bascule à 90 %… voir note)
}
room.memory.noBuilderNeeded = Game.time;
if ((storage && effectiveEnergy < 25000) || (RCL 8 && !balancer) || funnelingElsewhere || stripmine || upgradeBlocked)
  return performRecycle();                                         // ⚠ RCL4 avec storage < 25000 : le builder sans travail est RECYCLÉ
whenInRange(3, controller, () => upgradeController(controller));
```
Note : après `delete upgrading` avec de l'énergie restante, `repairing` est absent et `used` peut être < 90 % → il repart en collecte jusqu'à 90 % avant de construire.

### 6.4 `performRepair()` l.219-271 et choix de cible `calculateBuilderTarget()` l.279-291
```ts
performRepair() {
  if (!order?.target || !getObjectById(order.target)) calculateBuilderTarget();
  if (!order?.target || !getObjectById(order.target)) return false;
  if (enemyStrength > NORMAL && !safeMode && cible ∉ {spawn, rampart, tower, wall}) { calculateBuilderTarget(); if (!valide) return false; }
  if (order.type === 'repair') {
    maxHealth = order.maxHealth || target.hitsMax;
    if (order.maxHealth && target is rampart) maxHealth = min(maxHealth + 10000, hitsMax);    // l.247-249 : marge anti-decay
    if (!target.hits || target.hits >= maxHealth) { calculateBuilderTarget(); return true; }
    repairTarget(target); return true;                                                      // §6.6
  }
  if (order.type === 'build') { buildTarget(target); return true; }
}
calculateBuilderTarget() {
  delete order;
  best = getBestOption([...repairOptions, ...buildOptions]);
  if (!best || best.priority <= 0) return;                  // ⚠ priorité 0 = refusée ici
  delete room.memory.noBuilderNeeded;
  order = {type: best.type, target: best.object.id, maxHealth: best.maxHealth};
}
```
Re-calcul uniquement quand la cible disparaît (site terminé ⇒ objet inexistant) ou qu'une réparation atteint `maxHealth`.

### 6.5 Options
**Build** — `addBuildOptions()` l.515-556, sur `FIND_MY_CONSTRUCTION_SITES` en position sûre :
```ts
o = {priority 4, weight progress/progressTotal - range/100};
if (progressTotal < 1000) o.priority -= getCreepsWithOrder('build', site.id).length;   // petits chantiers : 1 builder
if (site is spawn) o.priority = 5;
if (site ∈ {road, rampart, wall, container}) o.weight -= 1;         // structures fonctionnelles d'abord (même prio)
if (site ∈ {lab, nuker, factory}) o.priority -= 1;
```
Coûts de référence : extension 3000, container 5000, road 300, tower 5000, storage 30000 → seuls road (300) / rampart (1) / wall (1) sont < 1000 (réservation 1 builder).

**Repair** — `addRepairOptions()` l.319-370 sur `getAvailableRepairTargets()` filtré `hits < hitsMax && !needsDismantling && position sûre` :
```ts
o = {priority 3, weight 1 - hits/hitsMax, maxHealth: null};
if (wall || rampart) modifyRepairDefensesOption(o);       // ci-dessous
else {
  if (hits/hitsMax > 0.9) o.priority--;                    // 2
  if (hits/hitsMax < 0.2) o.priority++;                    // 4 (= niveau du build !)
  if (road && hits > hitsMax/3) o.priority = 0;            // routes : seulement sous 1/3 (prio 0 ⇒ jamais choisie comme cible principale)
  o.weight -= range/100;
}
if ((road || rampart || container) && hits / (o.maxHealth || hitsMax) > 0.9) continue;   // decaying presque pleins ignorés
if (enemyStrength === NONE) o.priority -= getCreepsWithOrder('repair', id).length;          // étalement
```
Donc : container < 20 % → prio 4 ; 20-90 % → 3 ; route < 1/3 → 3 (ou 4 si < 20 %), sinon 0 ; autres structures > 90 % → 2.

`getAvailableRepairTargets()` l.372-415 (cache heap 5 ticks, objets 1 tick) : structures avec `hits < getStructureMaxHits()`, non à démanteler ; routes seulement si planifiées (`roomPlanner.isPlannedLocation(pos,'road')`) ou route d'opération (remote) ; ramparts/murs non planifiés ignorés (si planner).
`getStructureMaxHits()` l.417-447 : hitsMax sauf mur/rampart → `room.defense.getDesiredWallStrength()` (÷10 pour `wall.quad` / `rampart.ramp`, 10000 pour `wall.blocker`/`wall.deco`).

`modifyRepairDefensesOption()` l.459-505 (murs/ramparts) :
```ts
o.priority--; if (wall) o.priority--;                         // rampart 2, mur 1
maxHealth = getStructureMaxHits(t);
if (pas blocker/deco && hits >= 0.9*maxHealth && hits < hitsMax) { o.priority = RCL < 8 ? -1 : 0; maxHealth = hitsMax; }
o.weight = 1 - hits/maxHealth; o.maxHealth = maxHealth;
if (rampart) {
  if (hits < 10000 && RCL >= 3) { o.priority += 2; o.weight += 1; }            // ramparts neufs : 4
  if (enemyStrength >= NORMAL) { o.priority += 2; o.weight += 1; }
  else if (effectiveEnergy < 5000 && hits >= 10000) o.priority = -1;           // room pauvre : pas de renforcement
  else if (hits < settings.minWallIntegrity && RCL >= 6 && terminal) o.priority++;
}
```

### 6.6 Exécution
- `buildTarget` l.585-594 / `repairTarget` l.566-575 : `whenInRange(3, cible, () => build|repair)` ; si encore à > 3 : `repairNearby()`.
- `repairNearby()` l.602-621 : ne s'exécute que si énergie ≥ 70 % **ou** ≤ 30 % de la capacité (pas entre les deux) et pas throttlé ; répare la 1ère structure à portée ≤ 3 de `getAvailableRepairTargets` dont `hits <= maxHits - WORK*100` (une action par tick).

---

## 7. UPGRADER — `role/upgrader.ts`

### 7.1 Mémoire
`upgrading?: boolean`. Heap : `currentRcl?: number`.

### 7.2 `run()` l.45-75
```ts
if (!heap.currentRcl) heap.currentRcl = RCL;
else if (heap.currentRcl !== RCL && room.find(FIND_MY_CONSTRUCTION_SITES).length > 0 && RCL < 5) {
  delete upgrading; memory.role = 'builder'; return;          // l.49-59 : à la montée de RCL (< 5) avec chantiers, l'upgrader DEVIENT builder (définitivement)
}
if (upgrading && energy === 0) upgrading = false;                                           // l.61-63
if (!upgrading && (energy === capacity || (energy > 0 && room.memory.controllerContainer))) upgrading = true;   // l.65-67
if (upgrading) performUpgrade(true); else performGetUpgraderEnergy();
```
Seuils : commence à 100 % plein, **ou dès > 0 s'il existe un container de contrôleur** (il se ré-alimente au contact, §7.3).

### 7.3 `performUpgrade(allowRefilling)` l.85-137
```ts
isOnlyUpgrader = role === 'upgrader' && size(room.creepsByRole.upgrader) === 1;
if (range(controller) > 3 && isOnlyUpgrader) {
  pos = heap(500, 'upgraderPosition:'+room) = _.sample(planner.getLocations('upgrader.0'));
  pos ? goTo(pos) : moveToRange(controller, 3);
} else whenInRange(3, controller, () => { upgradeController(controller); /* + signature si besoin : whenInRange(1, controller, sign) */ });
// Siphonnage continu : si allowRefilling && used < WORK * 2 :
//   controllerLink (RCL5+) avec > 50 et à portée ≤ 1 → withdraw ; sinon
//   controllerContainer avec > 50 et à portée ≤ 1 → withdraw              // l.120-136
```
NB : seul l'upgrader unique va sur `upgrader.0` (adjacent au container contrôleur par construction). Les autres se placent à portée 3 quelconque ; le traffic manager les garde dans la zone.

### 7.4 `performGetUpgraderEnergy()` l.145-219 — ordre strict
1. `controllerLink` avec `energy > 50` → `whenInRange(1) withdraw`, return. (RCL5+)
2. `controllerContainer` avec `energy > 50` → `whenInRange(1) withdraw`, return. (l.158-167)
3. Énergie au sol à portée **≤ 10 du contrôleur si RCL < 4, sinon ≤ 3**, avec `amount >= creep.capacity` → `whenInRange(1) pickup`, return. (l.170-179)
4. Autre container (≠ container contrôleur) avec `energy > CONTAINER_CAPACITY/4` (= 500) à portée ≤ 10 (RCL < 4) / ≤ 3 du contrôleur → withdraw, return. (l.182-195)
5. Si `energy > 0` → `upgrading = true` (prend effet au prochain tick ; la suite s'exécute quand même). (l.198-200)
6. Un creep a un ordre `workerCreep` vers moi → `moveToRange(livreur, 1)`, return. (l.202-205)
7. **Pas de link ni de container contrôleur** → `transporterRole.performGetEnergy(creep)` (dispatcher de sources, §3.6/§5) ; **sinon** attendre à portée 3 du contrôleur (`say('🔄')`). (l.209-218)

L'upgrader ne récolte jamais une source non plus.

---

## 8. Scénarios RCL 1-4 (comportement émergent)

1. **RCL1, aucun transporter, aucun container** : harvester non stationnaire : récolte jusqu'à plein (sur `harvestPos` = futur centre de bay de source, sinon portée 1) → livre via le dispatcher de destinations (spawn prio 5, extensions 4, workerCreep 2 vers builders/upgraders, drop 0 sur le centre de base) → revient à vide. En récoltant presque plein, il donne aussi aux transporters/upgraders/builders adjacents (RCL < 6). Builders/upgraders se nourrissent au sol / tombstones / containers via le dispatcher de sources (prio 4 pour le tas du centre).
   Hivemind spawne jusqu'à 3 transporters dès RCL1 (`spawn-role/transporter.ts:80-115` : `max(base*2/3/size, 3)`, base 1 à RCL<3, 2 à RCL3), donc cette phase est courte.
2. **≥ 1 transporter** : harvester **stationnaire** ; plein, il continue à récolter → surplus au sol sur sa tuile (ou dans le container une fois bâti). Si pas de container mais un chantier de container à portée 3 de la source, et aucun builder avec > 20 de place libre, il le construit lui-même (§2.5a). Transporters : collecte au sol/container (prio 4 si tas ≥ 200 ou container qui se remplit), livraison spawn/bay/extension > tour/container contrôleur > workerCreep > drop au centre.
3. **Bays de source (RCL2+, extensions planifiées autour de la tuile de récolte)** : le harvester sur le centre remplit les extensions de sa bay dès 60 % de son stock, se ré-alimente du sol/container sous lui ; la bay est exclue des destinations transporters (`hasHarvester`). Les containers de bay de source ne sont pas vidés sous 1/3 (prio -1).
4. **Container contrôleur** : destination prio 4 (2-3 si peu de besoin) pour transporters ; upgraders démarrent dès > 0 énergie et pompent à < 2×WORK.
5. **RCL4 storage** : drop → storage (prio 0) ; workerCreep désactivé (sauf ennemis forts) ; les builders n'opèrent que si `effectiveEnergy > 2500` et sont **recyclés** sans travail si < 25000 ; non-transporters ne prennent pas le storage sous 5000 ; transporters ciblent la source qui alimente la destination la plus prioritaire (§3.5) ; la pile au centre devient prio 1 pour les transporters.

## 9. Bugs/quirks repérés (ne pas reproduire aveuglément)
- `resource-source/drop.ts:47` : `return` au lieu de `continue` sur filtre `resourceType`.
- `resource-source/overfull-extension.ts:37` : `amount` toujours 0.
- `resource-destination/drop.ts:63` : `getStorageLocation()` peut être null sans planner ni storage.
- `role/builder.ts:283` : options de priorité 0 rejetées (routes > 1/3, etc.) alors que `getBestOption` les accepte.
- `role/transporter.ts:291` : `idlingFor = 5` écrit aussi pour builder/upgrader mais seulement consommé par `transporter.run`.
- Réservation par comptage d'ordres (pas de montants) : plusieurs creeps peuvent cibler la même petite source si la priorité décrémentée reste la meilleure.
