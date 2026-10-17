# Refonte du cœur sur le modèle Hivemind : conception (jalon 1)

Date : 2026-10-17. Branche : `feat/hivemind-rework`.

## Intention

Le cœur actuel (file de tâches génériques + `DemandCalculator` + phases + rôles à côté) accumule des exceptions dans `TaskExecutor` et reste ~22x derrière Hivemind sur le banc (W7N3 : 4 783 points contre 107 085). Aucun des bots de référence analysés (Hivemind, Overmind, The International, TooAngel) n'utilise une file de tâches globale : chaque creep a un rôle qui sait pourquoi il existe, et le spawn interroge chaque besoin puis arbitre à un seul endroit.

L'utilisateur a choisi le modèle Hivemind (le plus propre à son avis) et demandé de réimporter ses règles « à notre sauce » : on porte la **logique** (formules, priorités, ordre de construction, planner) dans notre propre structure TypeScript (modules, singletons, `ModuleManager`, `trafficManager`), pas ses prototypes.

Les règles exactes, avec références `fichier:ligne` dans Hivemind, sont dans :
- `docs/hivemind/hivemind-spawning.md` (spawn manager, spawn-roles, body builder)
- `docs/hivemind/hivemind-roles.md` (rôles, dispatcher de ressources)
- `docs/hivemind/hivemind-construction.md` (room manager, planner, défense)

Hivemind est sous licence MIT : notice dans `THIRD_PARTY_NOTICES.md`, chaque fichier porté cite son origine.

## Objectifs du jalon 1

1. Économie mono-room RCL1-4 complète au format Hivemind : harvester, transporter, builder, upgrader, brawler.
2. Spawn par options `{priority, weight}` (plus haut gagne), arbitrées par un `SpawnManager` unique.
3. Dispatcher de ressources (sources / destinations) avec ordres en mémoire des creeps.
4. Plan de base calculé une fois et stocké, construction pilotée par le plan dans l'ordre Hivemind.
5. Mesure : meilleur que l'état actuel (`ac17616`) sur W7N3, W9N5 et W1N3, 8 000 ticks, sans erreur de module, CPU moyen < 20.

## Hors périmètre (jalons suivants)

- Remote mining dès RCL1 (Hivemind) : le `RemoteMiningManager` actuel reste (gaté sur le storage) ; J4.
- Ramparts / min-cut, quad-breaker, safe mode automatique, labs, links, terminal, factory.
- Throttling CPU par rôle (une room = CPU faible).
- Variantes multiples et scoring du planner.

## Anti-objectifs

- Reproduire les prototypes Hivemind (`Room.prototype.*`) ou leur couplage global.
- Garder des chemins de code morts « au cas où » : l'historique git les conserve.
- Régression d'un module conservé (scout, intel, expansion, remote, market, tours).

## Architecture cible

```
main.ts → gameLoop (ModuleManager)
  RoomIntel        (mandatory)  hostiles → room.memory.enemies / defenseMode
  RoomPlanner      (every 1, sleeps once planned)  calcule et stocke le plan
  Creeps           (mandatory)  exécute chaque creep selon memory.role (registre)
  SpawnManager     (mandatory)  options des spawn-roles → meilleure option
  RoomBuilder      (every 20)   chantiers selon le plan
  TowerManager, IntelManager, ScoutManager, RemoteMiningManager, ExpansionManager, MarketManager (inchangés)
  TrafficManager   (mandatory, last)
```

Fichiers :
- `src/core/` : `bodyBuilder.ts` (algorithme exact Hivemind), `options.ts` (`getBestOption`), `roomState.ts` (index par tick : creeps par rôle et par room, ordres par cible, énergie stockée effective, storage location, containers de source / contrôleur).
- `src/planner/` : `RoomPlanner.ts` (planner simplifié), `RoomPlan.ts` (positions par type, packées en `Memory.rooms[r].plan`).
- `src/dispatcher/` : `Dispatcher.ts`, `sources.ts`, `destinations.ts`.
- `src/roles/` : `registry.ts` (conservé), `harvester.ts`, `transporter.ts`, `builder.ts`, `upgrader.ts`, `brawler.ts`, `recycle.ts`.
- `src/spawning/` : `SpawnManager.ts`, `spawnRoles.ts` (harvester, transporter, builder, upgrader, défense, requêtes externes).
- `src/construction/RoomBuilder.ts`.

Supprimés : `TaskGenerator`, `TaskDispatcher`, `TaskExecutor`, `DemandCalculator`, `RoomManager` (phases), `ConstructionManager`, `BasePlanner`, `DefenderManager`, `MetricsCollector`, `visuals/*`, `logistics/*`, `types/TaskTypes.ts`, `config/bodyTypes.ts`, `utils/memoryReset.ts`, et les modules désactivés (Combat, Lab, Highway, SK, Stronghold, PowerCreep, Factory). `Memory.config` et ses trois interrupteurs disparaissent.

## Règles portées (résumé ; détail dans `docs/hivemind/`)

**Convention** : `getBestOption` garde la priorité la plus haute, puis le poids le plus haut ; priorité < 0 jamais choisie ; à égalité, la première collectée.

**Spawn** : un creep max par tick et par room ; si la meilleure option n'est pas finançable, la room attend (pas de repli). Énergie du corps `min(cap, max(X, energyAvailable))`, X = cap (harvester), 300 (harvester forcé), 250 (transporter forcé), 0.9·cap (autres). Cache « options vides » par rôle (harvester/transporter/défense 10, builder 50, upgrader 100) et par room (10).
- Harvester : remplacement quand `ttl ≤ 3·taille + distance` ; prio 6 si aucun harvester (et pas de storage ou storage < 5 000), 5 sans storage, 4 avec ; poids `(50−d)/50` ; additionnels en RCL ≤ 3 jusqu'à 5 WORK par source dans la limite des cases libres ; corps W4/C1, W ≤ 5, MINIMAL sous 600 de capacité sinon ROAD.
- Transporter : `max(base·2/3/12, 3)` + 1 par container de source > 75 % (RCL < 4) + extra upgrader ; corps CARRY ≤ 12, ROAD ; règles de priorité selon le nombre existant (spec §5.1).
- Builder : 0 sans plan ; quota WORK `(5 | 10) × (1 + E/3000)` sans storage (règles complètes spec §6.2) ; corps W4/C3 ROAD.
- Upgrader : 0 sans storage (sauf downgrade) ; avec storage selon E ; corps W10/C1 SLOW avec container contrôleur.
- Brawler : RCL < 4, ennemis non sûrs, < 2, prio 5.
- Requêtes externes (scout, remote, claimer) : API `requestSpawn` conservée, priorités ramenées à l'échelle Hivemind (scout 1, remote 3, claimer 3).

**Rôles** :
- Harvester attaché à sa source, stationnaire dès qu'un transporter existe, sinon livre comme un transporter ; position de récolte du plan (= container de source) ; construit son container si aucun builder libre ; donne aux creeps adjacents (RCL < 6) ; remplit sa bay de source.
- Transporter : bascule 90 % / 10 % sans ordre en cours ; ordre revalidé chaque tick ; attente 5 ticks sans source ; avec storage, cherche la source de la destination la plus prioritaire.
- Builder : travaille dès 90 % plein, build/repair selon priorités, sinon upgrade (recyclé à RCL4 si storage < 25 000) ; ne récolte jamais.
- Upgrader : ordre d'approvisionnement en 7 étapes ; démarre dès > 0 avec un container de contrôleur ; devient builder à la montée de RCL (< 5) s'il y a des chantiers.

**Dispatcher** : destinations spawn 5 / extension 4 / bay 5 / tour 3(+1+1) / container contrôleur 4(−1−2) / workerCreep 2 (sans storage) / storage 0 / drop au centre 0 ; sources drop & tombes 4(−1−1) / container de source 2 ou 4 / autre container 1 / tas central 0 (transporter) ou 4 / storage 2 ; pénalité par creep ayant déjà l'ordre (−3 ou −2).

**Construction** (spec §1.4) : max 5 chantiers ; RCL1 spawns ; RCL2+ extensions bay par bay, containers source et contrôleur, routes source/contrôleur **sur marais seulement** ; RCL3 extensions de source, tour ; RCL4 storage puis toutes les routes une fois le storage construit.

**Planner simplifié** (spec §2.8) : matrices mur/sortie, une seule variante « weighted », positions de récolte, upgrader + container contrôleur, couloirs de sortie, cœur (storage en C+(0,1)), bays de source sans spawn, bays d'extensions par flood-fill, tours par flood-fill depuis le centre.

## Écarts volontaires (choix de l'implémenteur)

1. **Une seule variante de plan**, calculée en un tick (bucket ≥ 1 000), pas de scoring ni de labs réservés (les bays sont un peu plus proches du centre). Le plan ne s'ancre pas sur le spawn initial, comme Hivemind.
2. **Tours** : placées par flood-fill depuis le centre (pas de ramparts pour guider la couverture).
3. **RoomBuilder toutes les 20 ticks** au lieu de 100 (coût CPU faible, chantiers enchaînés plus vite).
4. **Index des ordres par tick** au lieu de `_.filter(room.creeps)` à chaque appel (même résultat, O(1)).
5. **Bugs Hivemind non reproduits** : `drop.ts:47` (`return` → `continue`), montant d'`overfullExtension`, storage location nulle (repli : position du spawn), builder qui refuse la priorité 0 (gardé tel quel : c'est ce qui fait upgrader les builders).
6. **Mouvement** : `whenInRange` = `trafficManager.requestMove(creep, pos, { range })` à chaque tick, y compris à portée.
7. **Pas de throttling par rôle** (bucket plein avec une room).

## Validation

- `npm run build` sans erreur.
- `npm run test:server -- --ticks 3000` sur W7N3 : PASS.
- `CODES="before=test-results/bundles/before-ac17616.js after=dist/main.js" RUNS=1 bash scripts/compare.sh` (8 000 ticks, 3 rooms) : `after` > `before` sur les trois rooms ; résultats ajoutés à `CLAUDE.md`.

## Résultats (2026-10-17)

Points de contrôleur sur 8 000 ticks. Avant = `ac17616`.

| Room | Avant (serveur) | Après (serveur, 1 run) | Avant (mockup) | Après (mockup, moyenne de 3) |
|---|---|---|---|---|
| W7N3 | 4 818 | 49 787 | 5 209 | 50 056 |
| W1N3 | 7 086 | 24 482 | 7 503 | 29 111 |
| W9N5 | 4 858 | 3 163 | 4 456 | 4 613 |

Le serveur a fait tourner la version finale sur W9N5, mais une version précédente sur W7N3 et W1N3 (sans l'ancrage sur le spawn, la priorité de l'upgrader et le poids des transporteurs). W9N5 est très bruité, avec des runs isolés de 2 800 à 5 500 points dans le mockup : le critère « meilleur sur les trois rooms » est atteint en moyenne dans le mockup, mais pas sur l'unique run serveur de W9N5. Les écarts ajoutés après coup sont listés dans `CLAUDE.md` (« Deliberate deviations »).

## Jalon 2 : minage distant (2026-10-17)

Choix du périmètre : un recensement dans le mockup (W7N3, 8 000 ticks) a montré que l'écart restant avec Hivemind venait de son minage distant précoce (7 harvesters distants, 12 haulers, 9 claimers dans 3 rooms voisines dès RCL 2). Le planificateur à plusieurs variantes est reporté. Règles : `docs/hivemind/hivemind-remote.md` ; implémentation : `src/remote/`, `src/roles/remote*.ts`, `src/roles/reserver.ts`, `src/roles/flee.ts`.

Hors périmètre de ce jalon : builders et routes distantes (ils exigent un storage), défense des remotes, dismantlers.

Points sur 8 000 ticks, serveur privé, 1 run :

| Room | Avant (`ac17616`) | J1 | J2 | Hivemind 3.0.0 |
|---|---|---|---|---|
| W7N3 | 4 818 | 49 787 | 101 095 | 107 085 |
| W1N3 | 7 086 | 24 482 | 31 751 | 20 300 |
| W9N5 | 4 858 | 3 163 | 4 422 | 189 |

Pour J1, les runs serveur de W7N3 et W1N3 viennent d'une version antérieure aux trois derniers correctifs du jalon. Dans le mockup (moyenne de 2 runs), J2 donne W7N3 94 645, W1N3 39 901 et W9N5 4 525.

CPU moyen sur le serveur avec J2 : 10,1 sur W7N3, 8,2 sur W1N3 et 5,6 sur W9N5, sans erreur de module. Le gros du coût vient de l'exécution des creeps et du trafic.
