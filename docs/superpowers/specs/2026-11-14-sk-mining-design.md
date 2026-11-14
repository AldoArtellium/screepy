---
slug: sk-mining
issue:
Validée :
---

# Minage des rooms source keeper et de la room centrale

## Besoin

Sur shard0 le CPU n'est plus la limite (~20 CPU utilisés sur 70, bucket plein depuis 430k ticks) mais
les remotes le sont : 6 sources, tout le reste est à d'autres joueurs, contesté ou en room source keeper
(W26N4-6, W25N4, W24N4...), exclues par `isKeeperRoom` (src/remote/remoteRooms.ts). Le GCL 8 (seul moyen
d'avoir une 8e room) est à ~10 jours, limité par l'énergie. Après : une base RCL 7+ mine les sources des
rooms SK voisines (4000 énergie par régénération, ~13 énergie/tick par source) protégée par un tueur de
keepers, et la room centrale du secteur (W25N5, 3 sources sans keeper) dès qu'un chemin passe par une room
SK tenue.

## Critères d'acceptation

1. Une room source keeper (nom ou intel `hasSourceKeepers`) devient candidate au remote mining d'une base
   d'au moins RCL 7 (énergie de spawn suffisante pour le tueur) à au plus 2 rooms, sauf si un stronghold
   invader y est actif (intel `coreLevel`/`collapse`) ; une room SK non tenue reste bloquée pour tous les
   autres chemins (règle actuelle conservée). Test hors ligne dans tests/remoteRooms/run.mjs.
2. Le score d'une source SK (src/remote/remoteIncome.ts) compte 4000 / 300 énergie par tick brute, les
   harvesters et haulers dimensionnés pour ce débit, pas de reserver, et la part du tueur de la room
   (corps / 1500 ticks partagé entre les sources mines de la room) ; une source SK non rentable
   (MIN_SOURCE_NET) n'est pas retenue. Test hors ligne dans tests/remoteIncome/run.mjs.
3. Nouveau rôle `keeperKiller` (src/roles/, enregistré dans CreepRunner) : corps ATTACK + HEAL + MOVE (cible
   Harabi ATTACK19 HEAL6 MOVE25, ajusté à l'énergie de la base), un par room SK minée, spawn par
   remoteSpawnRole avant les harvesters de cette room ; il se place au lair dont le keeper apparaît le
   plus tôt (`ticksToSpawn`), tue les keepers, se soigne, et remplace son successeur avant sa mort
   (temps de trajet). Logique de choix du lair pure (module à part dans src/remote/), testée hors ligne
   dans tests/remoteRooms/run.mjs.
4. Harvesters et haulers des rooms SK : pas de reserver ; ils fuient (s'écartent à portée > 3) un keeper
   vivant ou un lair à `ticksToSpawn` <= 10 tant que le tueur n'a pas nettoyé, puis reprennent ; le
   déplacement dans les rooms SK minées n'évite plus les tuiles de keeper (TrafficManager / cartographer)
   pour nos creeps de cette opération. Harvester dimensionné pour 4000 par 300 ticks.
5. La room centrale (coordonnées 5,5 du secteur) est candidate quand son chemin ne traverse que des rooms
   SK minées par la même base ; sources à 4000, pas de reserver, pas de tueur.
6. Compteurs : `keeper:killed`, `keeper:killerDied`, `keeper:flee` ; `live-inspect` montre les sources SK
   dans le bilan des remotes comme les autres.
7. Mesure mockup W7N3 (room SK W6N4 dans la fixture) `--preset rcl7`, 12000 ticks, avant/après avec
   `compare.sh` : points et énergie remote en hausse, CPU de la base < +6 CPU/tick, aucun
   `Memory.moduleErrors`, pertes de creeps notées. Si les keepers n'apparaissent pas dans le mockup
   (room inactive), corriger le mockup d'abord (sim.cjs) et le noter.
8. `docs/decisions/economy.md` : la section remote mining décrit la règle SK, l'écart Hivemind
   (« Not ported: source keepers » remplacé) et la mesure ; CLAUDE.md seulement si une commande change.

## Hors périmètre

- Minéraux des rooms SK et de la room centrale (lair minéral ignoré, le tueur ne le garde pas).
- Destruction des strongholds invader dans les rooms SK (la room est simplement sautée).
- Boosts du tueur, power creeps, portails de la room centrale.
- Déploiement sur shard0 et `setShardLimits` : faits par l'utilisateur après la revue.
- Partie militaire (`Memory.military.auto`, seizes, W26N7) : seconde session de l'utilisateur.

## Produit et version

Nouvelle fonctionnalité produit : non
Accord produit :
Type de version : feat
Rupture de compatibilité : non

## Grille Alemca

- Branche : `worktree-sk-mining` depuis `master` local 311a2a9 (dépôt GitHub sans `develop`, CLAUDE.md du projet).
- Comportement visible modifié : docs/decisions/economy.md.
- Cibles passerelle : sans objet.
- Données : sans objet.
- Sûreté passerelle : sans objet.
- Harnais Lua : sans objet.

## Vérification

```verify
npm run build
npx eslint --no-ignore --no-eslintrc -c .eslintrc.js src
node tests/remoteRooms/run.mjs
node tests/remoteIncome/run.mjs
node tests/remoteDefense/run.mjs
node tests/traffic/run.mjs
```

## Preuve manuelle

- [ ] Mockup `npm run test:mockup -- --room W7N3 --preset rcl7 --ticks 12000` avant/après, puis shard0 après déploiement par l'utilisateur.

## Décisions de cadrage

- Intégré au remote mining existant (sélection, chemins, containers, routes, bilan) plutôt qu'un module à part : tout le reste est déjà là ; coût si faux : refactor vers une opération dédiée.
- Un tueur non boosté par room SK (Harabi) : recette mesurée par un joueur du top ; coût si faux : pertes de creeps, à voir au mockup.
- RCL 7 minimum (5600 énergie, corps ~4270) : coût si faux : bases RCL 6 (W29N6) privées de SK.
- Portée 2 rooms : les rooms SK proches (W26N5/W26N6 voisines de W27N5/W27N6) ; coût si faux : moins de candidates.
- Minéraux hors périmètre : énergie d'abord (GCL) ; coût si faux : revenu minéral manqué.

## Décisions pendant le build

- Mockup : les keepers n'apparaissaient pas dans W6N4 (aucun en 3000 ticks rcl7) : le moteur ne traite qu'une
  room active (objet d'un joueur) et la fixture n'avait que les lairs. `sim.cjs` place un keeper par lair au
  départ et garde les rooms SK actives à chaque tick (comme le serveur officiel) ; ligne `Source keepers` et
  clé `keepers` dans le rapport.
- Tueur à distance au lieu d'ATTACK19 HEAL6 MOVE25 (critère 3) : dans le moteur, HEAL annule ATTACK le même
  tick et le keeper rend 300 par coup de mêlée ; le duel hors ligne donne la recette mêlée perdante en 9 ticks
  (keeper à 2870 PV), et au mockup un tueur mêlée de 36 parts est mort 3 fois pour 1 keeper tué. À portée 3 le
  keeper ne fait que 100/tick : RANGED12 HEAL5 MOVE17 (3900) gagne en 42 ticks, corps grandi avec l'énergie
  jusqu'à RANGED18 HEAL7 (`keepers.ts` `killerParts`). Mockup : 47 keepers tués, 0 tueur mort sur 8000 ticks.
- Seuil : RCL 7 et capacité ≥ 3900 (le corps minimal), pas seulement RCL 7 : la base du preset rcl7 plafonne
  à 4100 (35 extensions), un tueur réduit meurt.
- Coût du tueur imputé au bilan des sources de sa room (`history.ts`, comme un reserver).
- Relecture (alemca:typescript-reviewer, aucun CRITICAL/HIGH) : harvesters seulement une fois le tueur vivant
  ou en spawn ; le tueur garde toutes les sources de la room ; chemins à 4 tuiles du minéral (coût 50).
  Non corrigé, documenté : le chemin vers la room centrale peut attendre 500 ticks (échec en cache).
- Fuite élargie aux sources d'un lair qui spawne dans 10 ticks (W6N4:15:43 perdait 7 harvesters) et corps
  plaine pour les harvesters des rooms SK ; compteur `keeper:hit` ajouté pour le diagnostic.
- Critère 7 non atteint : au mockup W7N3 rcl7 12000 ticks, énergie remote et points plats (1,030 M / 0,985 M
  contre 0,989 M ; 5,709 M / 5,714 M contre 5,722 M), stockage plus bas, CPU +1,1 à +1,4, 0 erreur ; une source
  de W6N4 récolte 0,6 à 3,8 k sur 13,3 k par 1000 ticks pour 1,7 à 8,4 k de coût. À ne pas déployer en l'état :
  décision de l'utilisateur (2 tueurs par room, attente hors du chemin du keeper, ou retrait).

