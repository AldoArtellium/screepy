# Feuille de route : refonte sur le modèle Hivemind

Mise à jour : 2026-10-17. Le détail de chaque jalon terminé est dans `docs/superpowers/specs/2026-10-17-hivemind-economy-rework-design.md`. Les règles Hivemind extraites sont dans `docs/hivemind/*.md`. L'architecture et les écarts mesurés sont dans `CLAUDE.md`.

## Méthode (à garder pour chaque jalon)

1. **Mesurer d'abord.** Utiliser le mockup (`scripts/mockup/compare.sh`, 3 rooms, au moins 2 runs ; 3 runs pour W9N5, très bruitée). Le recensement des creeps par room est dans `world.creepsByRoom` du rapport. Hivemind 3.0.0 sert de référence : `test-results/refbots/hivemind/package/dist/main.js`.
2. **Extraire les règles Hivemind** du périmètre visé avec un agent, depuis le clone `/tmp/bots/hivemind` (lecture seule). La spec va dans `docs/hivemind/`.
3. **Porter à notre façon** : rôles, spawn-roles, dispatcher. Pas de prototypes. Citer l'origine (MIT) dans chaque fichier.
4. **Valider dans le mockup** contre la version précédente, puis confirmer sur le serveur privé (`scripts/pserver-test.mjs`, un run à la fois).
5. **Documenter** chaque écart volontaire avec son effet mesuré dans `CLAUDE.md`, puis committer et fusionner sur master.

## Terminés

| Jalon | Contenu | Résultat (serveur, 8 000 ticks) |
|---|---|---|
| J1 | Économie RCL 1-4 : rôles, spawn par options, dispatcher, planner simplifié, construction | W7N3 4,8k → 49,8k ; W1N3 7,1k → 24,5k ; W9N5 4,9k → 3,2k |
| J2 | Minage distant précoce : sélection des remotes, harvesters, haulers et reservers distants, scout dès RCL 1 | W7N3 101,1k (Hivemind 107,1k) ; W1N3 31,8k (Hivemind 20,3k) ; W9N5 4,4k (avant : 4,9k) |
| Outillage | Mockup en Node 24 dans Docker (~10 ms/tick, runs parallèles) ; projet passé sur Node 24 | — |

## Prochains jalons (ordre proposé)

1. **J3, l'ère du storage (RCL 4+).**
   - Builders et routes distantes (`builder.mines`).
   - Routes d'opération dans la room d'origine.
   - Défense des remotes : ATTACKER contre les invader cores, défense au-delà de 5 000 d'énergie.
   - Upgraders indexés sur le storage, déjà portés : à vérifier.

   Les runs de 8 000 ticks atteignent à peine RCL 3. Il faut mesurer avec `--preset rcl4` (serveur) ou des runs plus longs (mockup `--ticks 20000`).
2. **J4, le CPU.**
   - Coût par creep : CreepRunner 6,7 CPU et TrafficManager 3,1 pour une quarantaine de creeps sur W7N3.
   - Throttling par priorité et par bucket, à la Hivemind (`hivemind.ts`, `utils/throttle.ts`).
   - Cible : moins de 20 CPU avec plusieurs rooms.
3. **J5, le planner complet et la défense.**
   - Variantes et scoring du planner.
   - Ramparts par min-cut et tours placées selon leur couverture.
   - Safe mode, guardians.
4. **J6, l'expansion.** Claim d'une 2e room à la Hivemind, puis aide entre rooms.
5. **Plus tard :** links, terminal et market, labs et boosts, factory, power.

## Points ouverts

- **W9N5 (marais, sources éloignées)** : environ 4,4k, encore légèrement sous l'ancienne version (4,9k). Les résultats sont très variables d'un run à l'autre.
- **Pistes pour accélérer le serveur privé** (non appliquées, à tester sur une 2e stack compose) :
  - retirer les bots AliceBot et JackBot ;
  - un mod pour couper l'historique des rooms ;
  - 3 ou 4 processeurs ;
  - LokiJS à la place de Mongo.
- **Scout dans le mockup** : il produit des erreurs, parce que le monde est limité à 9 rooms. C'est sans conséquence.
