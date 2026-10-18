# Hivemind — spécification de portage : FIN DE PARTIE (planner complet, terminal, extracteur, minerais, échanges entre rooms, market)

Source : `C:\Users\ruffa\AppData\Local\Temp\bots\hivemind\src` (MIT). Toutes les références `fichier:ligne` sont relatives à `src/`.
Conventions : `getBestOption` (`utilities.ts:141-152`) garde la priorité la plus haute, puis le poids le plus haut ; une priorité négative n'est jamais choisie. Les dispatchers (`dispatcher/dispatcher.ts:9-27`) interrogent les providers par `getHighestPriority()` décroissant.

Hors périmètre (non portés, mentionnés pour mémoire) : évacuation et vidage du storage / du terminal, labs (réactions, boosts, helper), factory (barres, batteries), power, ops, commodities, pixels, demandes des alliés, stripmine, murs anti-quad et décoratifs.

---

## 1. Planner : structures de fin de partie

Ordre des étapes (`room/planner/variation-builder.ts:51-70`) : ... `placeHarvestBayStructures`, **`placeHelperParkingLot`**, **`placeLabs`**, `placeBays`, **`placeHighLevelStructures`**, `placeRamparts`, `placeQuadBreaker`, `placeDecorativeWalls`, `sealRoom`, `placeTowers`, `placeRoadsToRamps`, `placeOnRamps`.

- **Parking du helper** (`:364-379`) : flood fill depuis le centre (`startBuildingPlacement(center, entrances)`), premier emplacement libre (portée >= 3 du centre, pas sur une route) : `road` à coût 255 (bloqué) + `helper_parking`, route d'accès, `filterOpenList`.
- **Labs** (`:456-509`) : flood fill repris ; tant qu'on peut placer des labs (10 à RCL 8) : emplacement suivant à >= 8 des sorties ; pour chaque orientation `(dx, dy)` parmi `(1,1) (-1,1) (1,-1) (-1,-1)`, le tampon tient si les 4 cases du carré 2x2 `(x,y) (x+dx,y) (x,y+dy) (x+dx,y+dy)` sont constructibles et au moins 9 des 10 cases autour (`:511-531`) ; alors routes en `(x,y)` et `(x+dx,y+dy)`, labs `lab` + `lab.reaction` en `(x+dx,y)` et `(x,y+dy)` (les 2 labs sources : chaque autre lab est à portée 2 des deux), route d'accès, puis labs sur les cases libres de la liste jusqu'à 10. Aucun emplacement : la variation échoue (`return 'failed'`).
- **Structures de haut niveau** (`:533-539`) : `placeAll('powerSpawn', route)`, `placeAll('nuker', route)`, `placeAll('observer', sans route)` sur les emplacements suivants du flood fill.
- Les labs, power spawn, nuker et observer font partie des structures protégées par le min-cut (toutes les `CONTROLLER_STRUCTURES` sauf extension, route, container, extracteur, lien).
- Score (`room/planner/room-plan-scorer.ts`) : lab 0,02, nuker 0,02, powerSpawn 0,05, observer 0,01 par structure, et -0,001 x chemin de chaque lab au centre.

**Chez nous** (`src/planner/RoomPlanner.ts`) : mêmes étapes et mêmes tampons ; les 2 labs sources sont aussi marqués `lab.source`. Écarts : moins de 10 labs sont gardés si aucun tampon ne tient (pas d'échec de la variation) ; `PLAN_VERSION` 4 ; un plan de version 3 (sans ces structures, p. ex. W29N7 en live) n'est pas replanifié mais **étendu sur place** (`extendRoomPlan`) : on recharge le plan, toutes les cases hors de la zone `safe` et toutes les structures planifiées sont bloquées, puis on place parking, labs et structures de haut niveau sur les cases libres restantes. Rien de construit ne bouge, les nouvelles structures restent derrière les ramparts existants. Vérifié par `node tests/planner/run.mjs` (« extended v3 plan ... nothing moved »).

## 2. Construction (`room/room-manager.ts`)

Dans `manageStructures` (`:356-439`) :
- après `manageStorage` : **`manageTerminal`** (`:496-502`) construit le `terminal` planifié (RCL 6) ; un terminal mal placé contenant < 5000 ressources est détruit (non porté).
- après les liens : si `CONTROLLER_STRUCTURES[extractor][rcl] > 0` (RCL 6) : **`manageExtractors`** (`:570-620`, construit `extractor` ; plusieurs minerais : non porté) puis le container `container.mineral` (`:413-416`).
- à RCL 4+, après les routes et les extensions manquantes : si la room n'évacue pas et **`checkWallIntegrity()`** (`:865-885` : chaque rampart principal planifié, hors `rampart.ramp`, a au moins `minWallIntegrity x maxWallHealth[rcl] / maxWallHealth[8]` = 500 000 x ... / 20 M points, soit 12,5k à RCL 5, 50k à RCL 6, 75k à RCL 7, 500k à RCL 8) : **`buildEndgameStructures`** (`:890-912`) dans cet ordre, en s'arrêtant dès qu'on ne peut plus créer de chantier : labs (`:913-929` : si 3 labs permis, `lab.reaction` d'abord ; sinon `lab.boost` puis `lab`), nuker (`:931`), power spawn (`:939`), observer (`:947`), factory (`:955`). Les structures mal placées sont retirées (non porté).
- `tryBuild` (`:698-737`) : 5 chantiers par room, 90 % de `MAX_CONSTRUCTION_SITES` en tout ; un `createConstructionSite` refusé (RCL) ne bloque pas la suite.

**Chez nous** (`src/construction/RoomBuilder.ts`) : même ordre ; les types que la RCL n'autorise pas encore sont sautés sans appel (économie de CPU).

## 3. Minerais

### Spawn (`spawn-role/harvester.minerals.ts`)
- Résultat vide caché 50 ticks (`:18`). Rien si la room évacue (`:20`) ou si `getEffectiveAvailableEnergy() < 5000` (`:21`).
- Minerai retenu : `mineralAmount > 0` et extracteur à nous, opérationnel (`:25-32`) ; sans container voisin : ignoré (`:36`) ; **`room.isFullOnMinerals()` : aucune option** (`:37`).
- Un harvester par minerai (`:39-44`) ; un harvester compte s'il spawne ou si `ticksToLive > body.length x CREEP_SPAWN_TIME`.
- **Priorité 3, poids 0,2** (`:46-50`). Corps (`:68-75`) : `{CARRY: 1, WORK: 10}`, mouvement route, `carryContentLevel 0`, énergie `min(capacité, max(capacité x 0,9, énergie disponible))`. Boost WORK au-delà de 2000 de minerai (`:110-115`, non porté).
- Mémoire (`:88-95`) : rôle `harvester` avec `fixedMineralSource`.

### Rôle (`role/harvester.ts`)
- Stationnaire avec `fixedMineralSource` dès qu'il y a un transporter (`:86-88`, `:64-68`). Minerai épuisé : recyclage (`:136-147`).
- Position (`:98-109`, `:150-163`) : emplacement planifié `harvester.<minerai>` (portée 0), sinon portée 1 du minerai ; près du container s'il en est loin et presque plein (`:165-175`).
- `harvest` à chaque tick (`:177-178`), sans test du cooldown de l'extracteur.
- Dépôt (`:240-294`) : quand l'espace libre < `WORK x HARVEST_MINERAL_POWER`, dans le container voisin (sur le container : rien, le surplus y tombe).

**Chez nous** (`src/roles/mineralHarvester.ts`, spawn role `mineralHarvester` dans `spawnRoles.ts`) : un rôle à part ; pas de position planifiée (le container du minerai est la place) ; pas d'appel `harvest` pendant le cooldown de l'extracteur.

### « Plein » (`prototype/room.resources.ts`)
- `getStorageLimit` (`:109-125`) : capacité du storage + du terminal, 10 000 sans les deux.
- `getCurrentResourceAmount` (`:158-193`) : storage + terminal + cargaison des transporters.
- `getCurrentMineralAmount` (`:244-255`) : toutes les ressources sauf énergie et power.
- `isFullOnEnergy` > limite / 2, `isFullOnPower` > limite / 6, `isFullOnMinerals` > limite / 3 (`:287-324`).

## 4. Dispatcher, terminal et échanges entre rooms

### Sources
- **Container** (`dispatcher/resource-source/container.ts:87-133`) : avec un storage ou un terminal, chaque ressource non-énergie des containers ; le minerai attitré du container du minerai seulement à partir de `CONTAINER_CAPACITY / 2` ; **priorité 3**, poids `quantité / 20`, -2 par creep ayant déjà cet ordre.
- **Storage** (`resource-source/storage.ts:22-160`) : énergie (seulement si on demande de l'énergie) depuis `getBestStorageSource` (les non-transporters laissent 5000 dans le storage), priorité 2 ; autre ressource demandée : priorité 0 ; terminal plein à plus de 80 % (ou `libre + énergie < 5000`) : sa plus grosse ressource (pas l'énergie si le storage en a plus de 5 fois plus, pas `fillTerminal`, pas ce qui y retournerait), priorité 1 (+2 si `libre + énergie < 5000`).
- `getBestStorageSource` (`room.resources.ts:566-587`) : le terminal si la part de la ressource y est plus grande (rapport à la capacité) et que ce n'est pas `fillTerminal`, sinon le storage s'il en a.

### Destinations
- **Storage** (`resource-destination/storage.ts:30-49`) : priorité 0, poids `quantité / 100`, cible `getBestStorageTarget` ; les non-énergies attendent quand le terminal n'a plus la place de 5000 énergie.
- `getBestStorageTarget` (`room.resources.ts:513-555`) : un seul des deux : celui-là ; énergie et terminal < **7000** énergie : terminal ; sinon le storage si les deux ont la place et `storage[r] / libre storage < terminal[r] / libre terminal` ; sinon le terminal s'il a la place, sinon le storage, sinon rien.
- **Terminal** (`resource-destination/terminal.ts:20-97`, liste vide cachée 25 ticks) : énergie < **5000** (avec storage) : priorité 3, poids `1 - e / 5000`, quantité `5000 - e` ; `room.memory.fillTerminal` (préparation d'un envoi ou d'un deal) : seulement avec > 5000 énergie dans le terminal, cible `fillTerminalAmount || 10000`, arrêt si atteinte ou si la room n'en a pas assez, priorité 4, poids `manque / cible`. Ordres de vente du market (`:99-122`) : non porté.
- `prepareForTrading` (`room.resources.ts:348-352`) : quantité par défaut `min(10 000, stock)`, au plus 50 000.

Transporter (`role/transporter.ts:99-113`, `:305-391`) : reste en livraison tant qu'il porte autre chose que de l'énergie ; avec un storage, prend ce que la destination la plus importante demande. Pas de creep dédié au terminal (le helper ne sert qu'aux labs).

### Niveaux de ressources (`room/resource-level-manager.ts`)
- Seuils `[excessif, haut, moyen]`, sinon bas (`:15-21`) ; quantité = storage + terminal + factory (+ labs) (`room.resources.ts:436-500`).
- Énergie (`:68-92`) : ennemis >= NORMAL `[200k, 100k, 50k]` ; une room attaquée (> NORMAL) ailleurs `[50k, 20k, 15k]` ; room cible du funnel `[500k, 300k, 150k]` ; avec power spawn `[200k, 100k, 50k]` ; sinon `[200k, 50k, 20k]`. Autres ressources : `[50k, 0, 0]` (`:55-57`) ; power, ops, boosts, réactions : non portés.

### Funnel (`empire/funnel-manager.ts:19-79`, caché 500 ticks)
Rooms avec terminal. Une RCL 8 avec plus de 300k énergie : toutes les RCL 6 et 7. Sinon plus de 2 RCL 7 et au plus une RCL 8 : la meilleure RCL 7 ; sinon la meilleure RCL 6-7. Score `expansionScore / (énergie restante au niveau + 1)` ; pas de funnel si `10 / (GCL restante + 1)` fait mieux. Les mules (`manageTradeRoutes`, creeps porteurs vers les rooms < RCL 6) : non portées.

### Envois (`process/resources.ts`, toutes les 5 ticks, `main.ts:203-205` ; routes `empire/trade-route-manager.ts:27-109`)
- Source : terminal sans cooldown, pas de `fillTerminal` en cours (sauf terminal et storage pleins à 90 %), niveau haut ou excessif, énergie >= 10 000.
- Cible : terminal avec >= 5000 de libre ; niveau bas (énergie : aussi moyen avec des ennemis), ou moyen si la source est excessive.
- Le terminal source a `calcTransactionCost(5000) (+ 5000 pour l'énergie)` d'énergie. Priorité 3 (2 si la cible n'est pas basse), poids `(stock source - stock cible) / 100 000 - distance`.
- Exécution : volume `min(stock, 5000)` ; envoi si le terminal en a >= 90 % ; sinon `prepareForTrading` (si rien n'est en préparation et qu'il y a la place). Après un envoi, chaque room ne sert qu'une fois par passage ; après un échec, la paire (source, ressource) est retirée.

**Chez nous** : `src/core/resources.ts` (stocks, plein, storage ou terminal, niveaux, funnel), `src/dispatcher/{sources,destinations}.ts`, module `TerminalTransfers` (toutes les 5 ticks, rien sous 2 terminaux).

## 5. Market (`process/trade.ts`)

- Process toutes les 20 ticks, priorité basse (`main.ts:198-202`) ; rien sans terminal (`:46-56`). Ordres de plus de 100 000 ticks ou terminés annulés (`:683-693`). Crédits disponibles = crédits - 10 000 (`:16`, `:54`).
- Minerais de base (tier 1 : H, O, U, L, K, Z, X ; `getResourceTier` `:704-714`), seuils par room avec terminal (`:87-111`) : > 50k vente immédiate, > 20k ordre de vente, < 10k ordre d'achat, < 5k achat immédiat forcé (si crédits > 0).
- Composés (`:113-132`) : vendus (immédiat + ordre) au-delà de 5k par room quand la moyenne du marché dépasse leur valeur (`calculateWorth` `:820-836` : somme des réactifs x (1 + 0,001 x temps de réaction), caché 5000 ticks). Jamais achetés.
- Power (`:163-178`) : > 20k vente immédiate, > 10k ordre ; ops (`:180-195`) : > 10k / > 5k. Énergie : achat désactivé par défaut (`allowBuyingEnergy`, `:134-161`). Commodities, pixels : non portés.
- Terminal qui déborde (`:241-275`) : storage plein à 90 % et terminal à 95 % : vente immédiate de la ressource dont la meilleure offre rapporte le plus par rapport à sa valeur.
- Prix (`getPriceData` `:757-809`, caché 5000 ticks) : historique (si > 3 jours, sans les jours de moyenne min, max et d'écart-type max), pondéré par le volume, plus le carnet d'ordres ; `moyenne`, `écart` (le terme du carnet est ajouté non pondéré : bizarrerie conservée).
- Meilleur ordre (`:627-678`) : ordres d'au moins 100, score `1000 x prix -/+ 0,3 x coût du transfert de 1000`.
- Vente immédiate (`:323-374`) : prix >= moyenne + écart / 2 ; quantité `min(taille max, ordre, stock)` ; si le terminal n'a pas la quantité ou l'énergie du transfert : `prepareForTrading` et on réessaie plus tard.
- Achat immédiat (`:384-431`) : prix <= moyenne - min(écart / 5, 10 %) (sauf forcé : jusqu'à 10 000, réduit à l'énergie disponible).
- Ordre d'achat (`:443-504`) : un seul par ressource ; 1 % au-dessus du meilleur concurrent, au plus moyenne - min(écart / 2, 20 %), sinon moyenne - min(écart, 80 %), au moins 0,001 ; il faut les crédits pour tout l'ordre.
- Ordre de vente (`:514-563`) : un seul par ressource ; 1 % sous le concurrent, entre moyenne + écart / 2 et 1,5 x moyenne + 2 x écart ; sans crédits pour la taxe de 5 % : vente immédiate.
- Taille d'ordre (`:728-743`) : 10 000 / 1000 / 100 / 10 / 1 selon que le volume échangé dépasse 10 000 / 1000 / 100 / 10.

**Chez nous** (`src/modules/MarketManager.ts`) : mêmes règles. Ajouts : au plus 10 deals par tick, terminal en cooldown ou déjà utilisé dans le tick sauté, crédits dépensés retranchés du budget du passage, un achat immédiat ne dépense jamais plus que les crédits au-dessus de la réserve ; les composés ne cherchent leur prix que s'il y en a assez à vendre (même résultat, moins de CPU).
