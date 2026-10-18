# Feuille de route : refonte sur le modèle Hivemind

Mise à jour : 2026-10-17 (J6 terminé). Le détail de chaque jalon terminé est dans `docs/superpowers/specs/2026-10-17-hivemind-economy-rework-design.md`. Les règles Hivemind extraites sont dans `docs/hivemind/*.md`. L'architecture et les écarts mesurés sont dans `CLAUDE.md`.

## Méthode (à garder pour chaque jalon)

1. **Mesurer d'abord.** Utiliser le mockup (`scripts/mockup/compare.sh`, 3 rooms, au moins 2 runs ; 3 runs pour W9N5, très bruitée). Le recensement des creeps par room est dans `world.creepsByRoom` du rapport. Hivemind 3.0.0 sert de référence : `test-results/refbots/hivemind/package/dist/main.js`.
2. **Extraire les règles Hivemind** du périmètre visé avec un agent, depuis le clone `/tmp/bots/hivemind` (lecture seule). La spec va dans `docs/hivemind/`.
3. **Porter à notre façon** : rôles, spawn-roles, dispatcher. Pas de prototypes. Citer l'origine (MIT) dans chaque fichier.
4. **Valider dans le mockup** contre la version précédente, puis confirmer sur le serveur privé (`scripts/pserver-test.mjs`, un run à la fois).
5. **Documenter** chaque écart volontaire avec son effet mesuré dans `CLAUDE.md`, puis committer et fusionner sur master.

## Terminés

| Jalon | Contenu | Résultat (J1 et J2 : serveur, 8 000 ticks) |
|---|---|---|
| J1 | Économie RCL 1-4 : rôles, spawn par options, dispatcher, planner simplifié, construction | W7N3 4,8k → 49,8k ; W1N3 7,1k → 24,5k ; W9N5 4,9k → 3,2k |
| J2 | Minage distant précoce : sélection des remotes, harvesters, haulers et reservers distants, scout dès RCL 1 | W7N3 101,1k (Hivemind 107,1k) ; W1N3 31,8k (Hivemind 20,3k) ; W9N5 4,4k (avant : 4,9k) |
| J3 | Ère du storage : builders distants (routes et container des remotes), routes d'opération dans la room d'origine, défense des remotes (invader cores, petits hostiles), force ennemie dans RoomIntel | Serveur, preset RCL 4, 6 000 ticks, W7N3 : 211,9k → 220,7k (+4 %). Mockup, 30 000 ticks, 3 runs : W7N3 902k → 918k, W1N3 344k → 338k (bruit), storage +10k sur les deux |
| J4 | CPU, premier passage : comptage des intents et estimation du CPU officiel, CPU par rôle, ralentissement par bucket des creeps et des modules (Hivemind), cache des chemins distants ; hotfix du scout (rooms d'un autre statut, cibles sans chemin) | Mockup, 20 000 ticks, 3 runs : CPU de code W7N3 13,8 → 12,9, W1N3 10,4 → 9,2 ; points dans le bruit (-2 %). Limite de 8 CPU : bucket stable à ~3000 au lieu de 0, plus aucun tick coupé. Live shard0 : 32 → ~12 CPU après le hotfix du scout |
| J5 | Planner complet et défense : ramparts par min-cut, zone sûre, tours placées selon leur couverture, routes vers les ramparts ; variantes (centre pondéré, grille 3x3, spawn dans les bays de source) notées par le scorer Hivemind ; force ennemie, tours (cible militaire, soin, réparation des ramparts), safe mode, guardians et builders d'urgence (RCL 4+) | Serveur, preset RCL 4, W7N3 : 229,6k → 244,9k. Mockup sans ennemi, 20 000 ticks : W7N3 -9 %, W1N3 -3 %, W9N5 +3 % (coût des ramparts). Raids d'invaders (mockup `--raid`) : repoussés, aucune perte. Planner : score +5 à +25 % selon la room |
| J6 | Expansion à la Hivemind : décision (RCL 4+, GCL, CPU), score des rooms, squad (claimer, pioneers, défenseur contre les hostiles), pioneers (`builder.remote`), fin à RCL 4 + storage, échecs mémorisés, soutien d'une expansion par les autres rooms, reclaim des rooms sans spawn ; l'ancien ExpansionManager est supprimé | Mockup W7N3, GCL 2, 40 000 ticks : expansion lancée au tick 23 851 (RCL 5), W7N2 claimée, spawn construit ~2 200 ticks après le claim, RCL 4 au tick 40 000 ; la room mère perd ~14 % de points pendant l'expansion. Aucune erreur |
| Outillage | Mockup en Node 24 dans Docker (~10 ms/tick, runs parallèles) ; projet passé sur Node 24 | — |

## Prochains jalons (ordre proposé)

1. **J7, l'attaque : notre propre stratégie.** Étape 1 faite (2026-10-18) : duo attaquant + soigneur, prévision de dégâts par case (sûr / sauvable / condamné), états avancer / reculer, drain des tours par va-et-vient, percée des ramparts les plus faibles ; mockup `--enemy`. Mockup : base RCL 3 (1 tour, anneau de ramparts 30k) détruite en ~2000 ticks, 2 creeps perdus. Suite : quad, cibles automatiques (ROI), boosts, défenseurs ennemis, bug du bodyBuilder avec TOUGH.
   Rappel de l'idée de départ : Les bots open source (Hivemind compris) laissent volontairement la partie offensive hors de leurs dépôts : rien à porter. Objectif : des squads de creeps qui agissent à l'unisson (déplacement en formation, cible commune, mouvements synchronisés). À concevoir avec l'utilisateur.
2. **Plus tard :** terminal et market, labs et boosts, factory, power. (Links : faits, voir les points ouverts.)

## Points ouverts

- **W9N5 (marais, sources éloignées)** : environ 4,4k, encore légèrement sous l'ancienne version (4,9k). Les résultats sont très variables d'un run à l'autre.
- **Pistes pour accélérer le serveur privé** (non appliquées, à tester sur une 2e stack compose) :
  - retirer les bots AliceBot et JackBot ;
  - un mod pour couper l'historique des rooms ;
  - 3 ou 4 processeurs ;
  - LokiJS à la place de Mongo.
- **Upgraders et storage** : la règle d'Hivemind (un upgrader de plus par tranche de 50k d'énergie stockée, jusqu'à 6) laisse le storage se stabiliser vers 150k sur W7N3. Le baisser ferait monter les points mais réduirait la réserve de défense : c'est à décider, à mesurer avant de changer.
- **CPU officiel** : ~19 CPU estimés pour une room RCL 4 et ses 5 remotes (limite du compte : 20). Pistes non faites : moins de creeps plus gros (intents move), reserveController seulement quand la réservation baisse, planner/rooms multiples à mesurer avec J6.
- **Coût des ramparts** : dans le mockup (aucun ennemi), J5 perd 3 à 9 % de points par rapport à J4 sur 20 000 ticks, car les ramparts sont construits dès RCL 3 et montés à 100 000 hits en RCL 4. Écart à envisager si l'économie en souffre : retarder les ramparts au storage, ou viser moins de hits avant RCL 5.
- ~~**Raid précoce (RCL 2)**~~ réglé (2026-10-18, lot A) : la règle Hivemind « pas de brawler pendant un safe mode > 500 » bloquait tout pendant les 20 000 ticks de safe mode de la première room. Mockup W7N3, smallMelee au tick 2500 : tué en 118 ticks au lieu de 1 500.
- **Budget CPU des remotes** (2026-10-18, piste du wiki screepspl.us) : plafond global de remotes selon le CPU réel (95 % / 75 % de la limite). Mockup à 13 CPU (~20 officiels) : W9N5 +29 %, W1N3 +5 %, W7N3 -7 % (un run chacun).
- **CPU à plusieurs rooms** : 2 rooms (RCL 5 + RCL 4 et leurs remotes) ≈ 20,5-21 CPU officiels estimés, au-dessus de la limite de 20 ; le ralentissement (J4) protège le bucket. Pistes : moins de remotes par room, creeps plus gros, coût de CreepRunner.
- **Expansion** : écarts mesurés à envisager : room d'origine RCL 4 + storage au lieu de RCL 5 (expansion plus tôt), aide énergétique par haulers avant les terminaux.
- **CPU et mémoire (lot C, 2026-10-18)** : chemins des remotes stockés une seule fois et compactés (1 caractère par pas, `utils/pathCodec.ts`) : `Memory.remoteMining` 13-14k → 2-2,6k caractères à 20 000 ticks ; index des creeps par duo / squad ; chemin storage → container du controller unifié (plus de longueur 1 cachée 5000 ticks avant le container) ; profiler, logCPU et options mortes du ModuleManager retirés. Mockup 20 000 ticks : points dans le bruit (W7N3 +1,8 %, W9N5 -2,8 %, W1N3 +0,1 %), CPU égal. Reste : `Memory.creeps` pèse 40-55k caractères (~80 % de la mémoire) avec ~20 creeps vivants.
- **Bot live** : il tourne sur shard0 (W29N7, zone de respawn), pas sur shard3 ; les 20 CPU du compte sont sur shard0.
- **Links (lot A, 2026-10-18)** : portage Hivemind (`docs/hivemind/hivemind-links.md`) : link du contrôleur planifié à côté de la case d'upgrade (ajouté aux plans existants au chargement, pas de replan ni de `PLAN_VERSION`), construction contrôleur > sources les plus lointaines > storage, transferts toutes les 3 ticks, harvesters vers le link de leur source, upgraders depuis le link du contrôleur, dispatcher pour le link du storage, moins de transporteurs. Mockup depuis un état sauvegardé passé à RCL 5 (`--load-state` + `--set-rcl 5`, 12 000 ticks, un run, machine saturée) : W7N3 points -0,3 %, storage +13k, 91k d'énergie passée par les links, CPU 15,5 → 15,1 ; W1N3 (économie pauvre) -5 % de points, storage +4,5k : les 2 links coûtent 10k d'énergie et retardent les upgraders. Pas de hub hauler : le link du storage n'arrive qu'à RCL 7 avec 2 sources ; à revoir avec le terminal. Piste : ne plus remplir le container du contrôleur quand le link suffit.
- **Mesure de l'ère du storage** : les runs depuis zéro n'atteignent le storage que vers 11k ticks sur W7N3 et 20k sur W1N3. Utiliser `TICKS=30000` dans le mockup, ou `--preset rcl4` sur le serveur.
