# Couche logistique : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remplacer l'acquisition d'énergie individuelle et les tâches de livraison par une couche logistique par room (offres/besoins en heap, réservations dans la mémoire des creeps, appariement glouton).

**Architecture:** Un singleton `logistics` (`src/logistics/`) reconstruit paresseusement, une fois par tick et par room, les offres et besoins à partir de l'état du jeu, en déduisant les réservations lues dans `creep.memory.logistics`. Les workers y prennent leur énergie (`claimOffer`). Un comportement de transport (`runHaul`) sert les transporteurs, et les workers quand un besoin spawn/extension n'est pas couvert. Les tâches `FILL_*`, `PICKUP_RESOURCE` et `WITHDRAW_*` ne sont plus générées.

**Tech Stack:** TypeScript, lodash 3, screeps-cartographer (via `trafficManager`), Rollup. Pas de framework de tests unitaires : on valide par `npx tsc --noEmit -p .`, `npx eslint` et des parties sur le serveur local (`npm run test:server`), avec des compteurs `Memory.stats` (`countStat`).

**Spec:** `docs/superpowers/specs/2026-10-16-logistics-layer-design.md`. Le lire, en particulier « Décisions précisées après relecture ».

## Global Constraints

- **Cible** : serveur officiel face à de vrais joueurs. Budget de départ 20 CPU, la couche ajoute au plus ~1 CPU/tick avec 20 creeps.
- **Données** : demandes en heap uniquement ; seule la réservation de chaque creep va en `Memory` (`creep.memory.logistics`).
- **Reset global** : il ne doit rien casser, les demandes se reconstruisent depuis l'état du jeu.
- **Déplacements** : uniquement via `trafficManager.requestMove`. Un creep au travail rappelle `requestMove` chaque tick, même à portée.
- **Creeps exclus** : ceux à rôle (`memory.role`) ne participent pas.
- **Ressources** : énergie seulement (`RESOURCE_ENERGY`). Le modèle garde un champ `resourceType` pour les minéraux plus tard.
- **Transporteurs** : `BodyType.TRANSPORT` sans `memory.role`, pour que `DemandCalculator` compte toujours leurs CARRY.
- **Mineurs fixes** : désactivés par défaut (`Memory.config.staticMiners`). On ne change pas ce défaut.
- **Mode défense** : le besoin des tours passe avant celui des extensions.

## Review Focus

1. **Creep qui meurt ou cible détruite pendant une réservation.** Attendu : la quantité redevient disponible au tick suivant, sans réservation orpheline. Test : Task 1, étape 4.
2. **Reset global (heap vidée) avec des réservations en Memory.** Attendu : les demandes reconstruites tiennent compte des réservations existantes, sans double réservation. Test : Task 1, étape 4 (compteur après un téléversement de code en cours de partie).
3. **Début de partie : aucun transporteur, spawn vide.** Attendu : un worker bascule et remplit le spawn, le spawn ne s'arrête jamais. Test : Task 2, étape 4 (W7N3, 1 500 ticks, `spawned:worker` ≥ 6).
4. **Room en marais (W9N5).** Attendu : pas de régression par rapport à la référence `cd62340`. Test : Task 4, benchmark.
5. **Offre plus petite que la capacité du creep, loin.** Attendu : le creep ne traverse pas la room pour 10 d'énergie (règle « trop petit »). Test : Task 1, étape 4 (compteur `logistics:offerSkippedSmall`).

---

### Task 1 : Noyau logistique et acquisition d'énergie des workers

**Files:**
- Create: `src/logistics/types.ts`
- Create: `src/logistics/LogisticsNetwork.ts`
- Modify: `src/modules/TaskExecutor.ts` (remplacer `acquireEnergy`, `findEnergySource` et `hasEnergy` par des appels au réseau ; garder `harvestSlotsLeft` pour le repli de récolte)
- Modify: `src/types/TaskTypes.ts` (retirer `energySourceId` de `CreepTaskState`)
- Modify: `src/type.d.ts` (`CreepMemory.logistics?: LogisticsReservation`)

**Interfaces:**
- Produces (`src/logistics/types.ts`) :
  ```ts
  export type LogisticsKind = "offer" | "need";
  export type LogisticsTarget = AnyStoreStructure | Resource | Tombstone | Ruin;
  export interface LogisticsRequest {
      id: string;                       // `${kind}:${targetId}:${resourceType}`
      kind: LogisticsKind;
      targetId: Id<LogisticsTarget>;
      pos: RoomPosition;
      resourceType: ResourceConstant;
      amount: number;                   // effective, après réservations
      priority: number;                 // plus bas = plus important
      upgradersOnly?: boolean;          // container du contrôleur (offre)
  }
  export interface LogisticsReservation {
      kind: LogisticsKind;
      targetId: string;
      resourceType: ResourceConstant;
      amount: number;
      since: number;                    // tick de la réservation, pour l'expiration
  }
  ```
- Produces (`src/logistics/LogisticsNetwork.ts`, export `logistics`) :
  - `claimOffer(creep: Creep, opts?: { forUpgrade?: boolean }): LogisticsRequest | null`
  - `claimNeed(creep: Creep, opts?: { maxPriority?: number }): LogisticsRequest | null`
  - `getTarget(creep: Creep): LogisticsTarget | null` (cible de la réservation courante, `null` si elle a disparu)
  - `release(creep: Creep): void`
  - `hasUncoveredNeed(room: Room, maxPriority: number): boolean`
  - constantes exportées `NEED_PRIORITY = { SPAWN, EXTENSION, TOWER, TOWER_DEFENSE, CONTROLLER_CONTAINER, STORAGE }`. Valeurs laissées au constructeur, avec l'ordre imposé : en mode défense, `TOWER_DEFENSE < SPAWN ≤ EXTENSION < TOWER < CONTROLLER_CONTAINER < STORAGE`.

- [ ] **Step 1 : Types + réseau.** Implémenter `LogisticsNetwork`.
  - Construction paresseuse : un cache heap par room, avec le tick de construction ; on reconstruit si le tick a changé.
  - Agrégation des réservations : on parcourt `Game.creeps` de la room, et on ignore celles dont `since` a plus de 100 ticks (`countStat("logistics:reservationExpired")`).
  - **Offres** : énergie au sol, tombes, ruines, containers de source, stockage.
    - Stockage : visible des non-transporteurs seulement au-dessus du plancher, sauf si la room n'a aucun `TRANSPORT`.
    - Container du contrôleur : offre avec `upgradersOnly`.
  - **Besoins** : spawn, extensions, tours, container du contrôleur, stockage.
  - Score : `priority * K + range`.
  - Règle « trop petit » : on écarte une offre si `amount < 0.5 × capacité libre` et `range > 3`, avec `countStat("logistics:offerSkippedSmall")`.
  - Une réservation diminue immédiatement l'`amount` en heap.
  - Compteurs : `logistics:offerClaimed`, `logistics:needClaimed`.
- [ ] **Step 2 : Brancher `TaskExecutor.acquireEnergy`.**
  - Réservation existante : aller à sa cible (`getTarget`), retirer ou ramasser via `this.act(...)`, puis `release`.
  - Sinon : `claimOffer(creep, { forUpgrade: task.type === UPGRADE_CONTROLLER })`.
  - Sinon, repli : récolter à une source avec `harvestSlotsLeft > 0`, en excluant une source dont le container est occupé par un mineur.
  - Sinon : `handleIdleCreep`.
  - On libère la réservation quand l'état passe à `executing`.
- [ ] **Step 3 : Vérifier la compilation.**
  - Run : `npx tsc --noEmit -p . && npx eslint src/logistics src/modules/TaskExecutor.ts`
  - Expected : aucune sortie d'erreur.
- [ ] **Step 4 : Partie serveur courte.**
  - Run : `npm run test:server -- --ticks 3000 --room W7N3`
  - Expected :
    - tout est PASS (0 erreur de module) ;
    - `logistics:offerClaimed` > 100 dans « Other counters » ;
    - total des `moveError` < 600 (référence `cd62340` : ~530 sur 8 000 ticks).
  - Puis, pendant que la room tourne encore : `npm run compile` puis `node scripts/pserver-test.mjs --no-build --ticks 300 --room W7N3`. Ça téléverse en cours de partie, provoque un reset global, et respawne : vérifier qu'il n'y a pas d'erreur de module.
- [ ] **Step 5 : Commit.**
  ```bash
  git add src/logistics src/modules/TaskExecutor.ts src/types/TaskTypes.ts src/type.d.ts
  git commit -m "feat(logistics): offers/needs network with reservations; workers get energy through it"
  ```

### Task 2 : Transport par la couche logistique (fin des tâches de livraison)

**Files:**
- Create: `src/logistics/haul.ts`
- Modify: `src/modules/TaskGenerator.ts` (ne plus appeler `generateTransportTasks` ; supprimer la méthode)
- Modify: `src/modules/TaskDispatcher.ts` (exclure `bodyType === TRANSPORT` de `dispatchTasks` et `dispatchCrossRoomTasks`)
- Modify: `src/modules/TaskExecutor.ts` (`executeTasks` : TRANSPORT → `runHaul` ; workers → bascule, voir étape 2)
- Modify: `src/modules/TrafficManager.ts` (`getCreepPriority` : 10 si le creep a une réservation `need` de priorité spawn ou extension, à la place du test sur `FILL_SPAWN`/`FILL_EXTENSION`)
- Modify: `src/utils/stats.ts` (`idleCreeps` = ni `currentTask`, ni `memory.logistics`)

**Interfaces:**
- Consumes : Task 1 (`logistics.claimOffer`, `claimNeed`, `getTarget`, `release`, `hasUncoveredNeed`, `NEED_PRIORITY`).
- Produces : `runHaul(creep: Creep): boolean` dans `src/logistics/haul.ts`. Renvoie `true` si le creep a agi ou bougé ce tick, `false` s'il n'a rien trouvé, pour que l'appelant puisse le garer.

- [ ] **Step 1 : `runHaul`.**
  - Creep vide (ou réservation `offer`) : se servir via `claimOffer`.
  - Creep chargé : livrer via `claimNeed` ; à défaut de besoin, livrer au stockage s'il existe.
  - Chaque action passe par `trafficManager.requestMove` à chaque tick, et `release` après le transfert ou le retrait.
  - Compteur : `logistics:delivered` (quantité transférée).
- [ ] **Step 2 : Brancher dans `executeTasks`.**
  - Creep `TRANSPORT` : `runHaul`, sinon `handleIdleCreep`.
  - Worker sans tâche, ou en état `acquiring`, quand `logistics.hasUncoveredNeed(room, NEED_PRIORITY.EXTENSION)` est vrai :
    - il prend le besoin par `claimNeed(creep, { maxPriority: NEED_PRIORITY.EXTENSION })` ;
    - il le livre via `runHaul` ;
    - puis il reprend sa tâche, qu'il ne doit jamais abandonner (spec, décision 1).
- [ ] **Step 3 : Supprimer la génération des tâches de livraison.** Dans `TaskGenerator`, ne plus appeler `generateTransportTasks` et supprimer la méthode. Les valeurs `TaskType` restent dans l'enum, pour les tâches encore en mémoire après déploiement : `cleanupTasks` les purge.
  - Run : `npx tsc --noEmit -p . && npx eslint src/logistics src/modules`
  - Expected : aucune erreur.
- [ ] **Step 4 : Parties serveur.**
  - Run : `npm run test:server -- --ticks 1500 --room W7N3`
    - Expected : PASS, `spawned:worker` ≥ 6, aucune période > 300 ticks sans spawn (vérifier dans la colonne `creeps` des lignes de progression).
  - Run : `npm run test:server -- --ticks 3000 --room W1N3`
    - Expected : PASS, `logistics:delivered` > 5 000, `spawned:transport` ≥ 1.
- [ ] **Step 5 : Commit.**
  ```bash
  git add src/logistics src/modules src/utils/stats.ts
  git commit -m "feat(logistics): haul behaviour replaces FILL/PICKUP/WITHDRAW tasks"
  ```

### Task 3 : Container du contrôleur et plancher du stockage

**Files:**
- Modify: `src/logistics/LogisticsNetwork.ts`
- Modify: `src/modules/TaskExecutor.ts` (`executeUpgrade` : rester près du container du contrôleur s'il existe)

**Interfaces:**
- Consumes : Task 1 (`claimOffer(creep, { forUpgrade })`, champ `upgradersOnly`).
- Produces : rien de nouveau.

- [ ] **Step 1 :** Le container du contrôleur est un container à portée 3 du contrôleur et à plus de 2 cases de toute source.
  - Comme besoin : il est visible de tous.
  - Comme offre : `upgradersOnly`, donc filtrée hors de `claimOffer` sauf si `forUpgrade`.
  - Les transporteurs ne le vident jamais : `claimOffer` sans `forUpgrade` l'ignore.
  - Le plancher de stockage pour les non-transporteurs est une constante exportée `STORAGE_FLOOR`, valeur laissée au constructeur. On l'ignore quand la room n'a aucun TRANSPORT.
- [ ] **Step 2 :** Vérifier.
  - Run : `npx tsc --noEmit -p . && npx eslint src/logistics src/modules/TaskExecutor.ts`
  - Expected : aucune erreur.
  - Run : `npm run test:server -- --ticks 2000 --room W7N3 --preset rcl4`
  - Expected : PASS ; le stockage n'est jamais vidé sous le plancher par des workers. Vérifier avec `npm run inspect:server -- --memory stats.counters` en cours de partie, et que l'énergie du stockage reste au-dessus du plancher. C'est aussi la première validation réelle de `--preset rcl4` : si le preset échoue, corriger `applyPreset` dans `scripts/pserver-test.mjs` dans cette même tâche.
- [ ] **Step 3 : Commit.**
  ```bash
  git add src/logistics src/modules/TaskExecutor.ts scripts/pserver-test.mjs
  git commit -m "feat(logistics): upgrader-only controller container, storage floor for workers"
  ```

### Task 4 : Benchmark avant/après et documentation

**Files:**
- Create: `scripts/compare.sh` (généraliser `test-results/compare.sh` : `CODES="nom=chemin ..."`, `ROOMS`, `RUNS=2`, `TICKS=8000` ; résumé dans `test-results/compare-summary.txt`)
- Modify: `CLAUDE.md` (section Task System : les tâches de livraison n'existent plus ; nouvelle section « Logistics » : API, priorités, réservations ; documenter `scripts/compare.sh`)

**Interfaces:**
- Consumes : bundles construits depuis `cd62340` (référence) et depuis la branche ; Hivemind dans `test-results/refbots/hivemind/package/dist/main.js`.

- [ ] **Step 1 :** Écrire `scripts/compare.sh` ; `bash -n scripts/compare.sh` ne doit rien afficher.
- [ ] **Step 2 :** Construire la référence (`git worktree add` sur `cd62340`, `npx rollup -c`) et la branche (`npm run compile`).
- [ ] **Step 3 : Benchmark.**
  - Run : `CODES="before=<ref>/dist/main.js after=dist/main.js" RUNS=2 bash scripts/compare.sh` (environ 1 h 40).
  - Critère d'acceptation (spec) :
    - moyenne « after » > « before » en W7N3 et en W1N3 ;
    - W9N5 « after » ≥ 90 % de « before » ;
    - 0 erreur de module ;
    - CPU moyen « after » − « before » ≤ 1.
- [ ] **Step 4 :** Mettre à jour `CLAUDE.md` avec le tableau de résultats, puis commit.
  ```bash
  git add scripts/compare.sh CLAUDE.md
  git commit -m "docs: logistics layer, before/after benchmark"
  ```
