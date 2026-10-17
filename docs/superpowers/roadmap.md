# Feuille de route : refonte sur le modèle Hivemind

Mise à jour : 2026-10-17 (J3 terminé). Le détail de chaque jalon terminé est dans `docs/superpowers/specs/2026-10-17-hivemind-economy-rework-design.md`. Les règles Hivemind extraites sont dans `docs/hivemind/*.md`. L'architecture et les écarts mesurés sont dans `CLAUDE.md`.

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
| Outillage | Mockup en Node 24 dans Docker (~10 ms/tick, runs parallèles) ; projet passé sur Node 24 | — |

## Prochains jalons (ordre proposé)

1. **J4, le CPU.**
   - Coût par creep : CreepRunner 6,7 CPU et TrafficManager 3,1 pour une quarantaine de creeps sur W7N3.
   - Throttling par priorité et par bucket, à la Hivemind (`hivemind.ts`, `utils/throttle.ts`).
   - Cible : moins de 20 CPU avec plusieurs rooms.
2. **J5, le planner complet et la défense.**
   - Variantes et scoring du planner.
   - Ramparts par min-cut et tours placées selon leur couverture.
   - Safe mode, guardians.
3. **J6, l'expansion.** Claim d'une 2e room à la Hivemind, puis aide entre rooms.
4. **Plus tard :** links, terminal et market, labs et boosts, factory, power.

## Points ouverts

- **W9N5 (marais, sources éloignées)** : environ 4,4k, encore légèrement sous l'ancienne version (4,9k). Les résultats sont très variables d'un run à l'autre.
- **Pistes pour accélérer le serveur privé** (non appliquées, à tester sur une 2e stack compose) :
  - retirer les bots AliceBot et JackBot ;
  - un mod pour couper l'historique des rooms ;
  - 3 ou 4 processeurs ;
  - LokiJS à la place de Mongo.
- **Upgraders et storage** : la règle d'Hivemind (un upgrader de plus par tranche de 50k d'énergie stockée, jusqu'à 6) laisse le storage se stabiliser vers 150k sur W7N3. Le baisser ferait monter les points mais réduirait la réserve de défense : c'est à décider, à mesurer avant de changer.
- **ExpansionManager (ancien)** : sur le serveur privé, il spawne des claimers sans chemin (13 en 6 000 ticks, `moveError:-2:claimer`). À reprendre avec J6.
- **Mesure de l'ère du storage** : les runs depuis zéro n'atteignent le storage que vers 11k ticks sur W7N3 et 20k sur W1N3. Utiliser `TICKS=30000` dans le mockup, ou `--preset rcl4` sur le serveur.
- **Scout dans le mockup** : il produit des erreurs, parce que le monde est limité à 9 rooms. C'est sans conséquence.
