# Shard0 face aux autres bots (2026-10-23)

Relevé en lecture seule au tick 78 519 000 environ (3,65 s/tick). Nos chiffres viennent de l'historique du bot (`scripts/live-inspect.mjs`, moyenne de 20 snapshots, soit 20 000 ticks). Ceux des autres joueurs viennent de l'API publique (`scripts/shard0-neighbours.mjs` : map-stats, leaderboard, room-objects). Le CPU des autres joueurs n'est pas visible : toute comparaison de CPU reste une estimation à partir des corps des creeps.

## Où nous en sommes

| | Valeur |
|---|---|
| GCL | 4 (23,0 M) ; 4 salles = plafond GCL ; GCL 5 à 27,86 M |
| Salles | W29N7 RCL 6, W27N5 RCL 5, W28N7 RCL 5, W24N8 RCL 4 |
| Remotes | 7 salles (13 sources), plafonnées par le budget CPU (`Memory.remoteMining.maxRooms = 7`) ; W24N8 : 0, W28N7 : 1 |
| CPU | 17,5 / 20 en moyenne, bucket plein ; `cpuAvg` (EMA) 16,7 |
| Intents | 46,8 par tick (environ 9,4 CPU officiels), dont 25 `move`, 8,6 `harvest`, 5 `upgradeController`, 2,3 `repair`, 2 `reserveController` |
| Revenu | 163 énergie/tick (79 locale + 84 remote récoltée) |
| Dépenses | upgrade 67, spawn ~58, réparation 10, construction 3,6, stock +5,7 par tick |
| Vitesse GCL | 67 points de contrôle par tick (upgrade + builders qui upgradent) |

Le CPU se répartit ainsi : `CreepRunner` 10,4 et `TrafficManager` 5,2 (ce dernier correspond presque exactement aux 25 déplacements × 0,2), le reste fait moins de 1,6. Le code seul pèse donc environ 8 CPU pour ~60 creeps (0,13 par creep). Les intents pèsent plus que le code.

## Les autres joueurs

Joueurs à moins de 3 à 5 salles de nos salles. « Points / mois » = score du leaderboard world (points de contrôle gagnés dans la saison ; octobre est arrêté au 23).

| Joueur | GCL | Salles (shard0) | Points / mois récents | Remarques |
|---|---|---|---|---|
| **Aldo_Artellium** (nous) | 4 | 4 (RCL 4-6) | 2026-10 : 5,1 M (#715) | Refonte déployée en octobre : 67 points/tick aujourd'hui, soit ~1,6 M/jour |
| Blindfold | 8 | 7 (RCL 3-6) + 9 réservées | 04 : 21,4 M, 05 : 38,5 M, 10 : 12,7 M | Le comparable le plus proche ; nous enserre par le sud (W28N4 réservée, ancienne source à nous) |
| doorknobnob | 2 | 2 (RCL 3-4) + 3 réservées | 10 : 0,6 M | Nouveau joueur ; a pris W28N8 (ancienne remote de W28N7) et pille W27N7 avec un claimer sur place |
| Fieser-Sack | 5 | 1 (W27N7, RCL 3) | ~0 | Compte mort : W27N7 n'a plus aucune structure, controller en déclin |
| WitchDocter | 24 | 6 (RCL 2-6) | 1 à 6 M | Ancien joueur qui reconstruit à l'ouest de W24N8 |
| asdpof | 40 | 36 (RCL 8) | 69 à 117 M | Réserve W25N8 (voisine de W24N8) et la garde avec des creeps ATTACK + HEAL |
| volotsyouga | 31 | 21 (RCL 8) | 174 à 322 M | Référence haut de gamme : 5 creeps de 9 à 50 parts dans une RCL 8 |
| Robinlub_UG_NL | 26 | 14 (RCL 8) | 48 à 58 M | |

Observations sur les salles (room-objects) :

- **Blindfold** fait tourner 12 à 17 creeps par salle (nous : 6 à 11), avec beaucoup de petits creeps (fillers de 5 à 6 parts, harvesters de 10 à 13 parts, haulers de 26 à 36). Ses storages sont presque vides (2 à 39 k ; nous : 16 à 96 k, environ 225 k au total) et il a 5 à 15 chantiers ouverts par salle : il dépense tout et construit en continu. Avec 7 salles pour 9 remotes, il mise sur le nombre de salles plutôt que sur les remotes (1,3 remote par salle ; nous : 1,75).
- **volotsyouga** montre la cible RCL 8 : 2 miners de 9 parts (links), 1 house keeper et 2 haulers de 50 parts, soit 5 creeps et 168 parts. Une RCL 8 bien câblée en links demande très peu d'intents de déplacement.
- **Nos creeps sont gros** (harvesters de 18 parts, haulers de remote de 36 à 39) : c'est déjà la bonne pente pour le CPU par intent.
- **Énergie au sol dans nos remotes** : W29N5 2656, W27N6 1679, W29N8 1387 (`mining:wasted:remote` = 10 % de l'énergie disponible, livré / récolté entre 69 et 90 %).

## Points d'amélioration, par gain attendu

### 1. L'expansion est bloquée par le budget des remotes (gain fort, effort faible)

`mayExpand()` (`src/expansion/Expansion.ts:96-104`) exige `cpuAvg < 0,8 × limite`, soit 16 CPU sur 20, dès qu'on a plusieurs salles. Or le budget des remotes (`RemoteMining.ts` `updateBudget`) maintient le CPU entre 75 et 95 % de la limite et rajoute des salles tant que le bucket est plein : `cpuAvg` vaut 16,7 aujourd'hui. Au GCL 5, dans environ 4,85 M points (~72 000 ticks, ~3 jours), le bot ne lancera donc aucune expansion. Les deux règles se contredisent, et c'est la remote (environ 1,2 à 1,75 CPU pour 10 à 12 énergie/tick) qui l'emporte sur une salle (revenu local d'environ 20/tick à RCL 4, plus un upgrade qui fait monter le GCL, plus une capacité définitive).

Blindfold, à GCL 8, a 7 salles. La croissance du GCL vient du nombre de salles, et non des remotes.

Piste : quand l'expansion n'est bloquée que par le CPU, réserver une marge (par exemple 3 CPU) dans le budget des remotes pour qu'il libère des salles, ou faire compter au test de `mayExpand` le CPU que le budget peut rendre (`roomCpu` × salles minées). Test : mockup `--preset rcl5 --cpu-limit 13 --gcl 2` sur 10 000 ticks. Avant : aucune expansion attendue. Après : une squad `expand` partie, et le budget qui a rendu des salles.

### 2. Déployer master : correctif des murs de respawn (gain faible, effort nul)

`cleanup:constructedWall` vaut toujours 370 par 1 000 ticks sur shard0 : le commit 79e361a n'est pas déployé. Le bot envoie 37 intents `destroy` tous les 100 ticks pour rien, soit 7,4 CPU par passage (`RoomCleanup` avgCpu 8,7) et 0,074 CPU/tick en moyenne. Il suffit de `npm run push-main`.

### 3. Les déplacements coûtent 5 CPU par tick (gain moyen, effort moyen)

Les 25 intents `move` par tick représentent 29 % du CPU. Les seuls chiffres par rôle sont ceux du suivi des chemins de remote (`move:pathStep` ≈ 10/tick, haulers de remote surtout). Les 15 autres viennent des transporteurs (13,6 creeps, inactifs 18 % du temps : 2 479 ticks par 1 000), des builders, des upgraders et des harvesters.

- Mesure à ajouter d'abord : un compteur `intents:move:<role>` (`src/utils/intents.ts` ne compte que par méthode), pour viser le bon rôle.
- Pistes, à mesurer dans le mockup (`--preset rcl6`) :
  - moins de transporteurs une fois les links en place (W28N7 en RCL 5 : 944 ticks inoccupés sur ~4 transporteurs) ;
  - remplissage des extensions par un seul creep posé au centre (fillers des bunkers : Overmind, The International) au lieu de transporteurs qui tournent ;
  - haulers de remote : déjà au maximum de la capacité énergétique (voir CLAUDE.md), rien à gagner sans plus d'extensions.
- Chaque CPU gagné rend presque une salle de remote au budget (une salle ≈ 1,2 à 1,75 CPU).

### 4. Pertes dans les remotes (gain moyen, effort moyen)

L'énergie s'entasse au pied des containers pleins (1,4 à 2,7 k au sol dans 3 salles), et `mining:wasted:remote` vaut 10 % de l'énergie disponible. Il faut vérifier, sur le compteur de haulers par source (CARRY = 2 × trajet × énergie/tick / 50), si le trajet réel (`remote:travel` = 1,05 × `travelPath`) et les remplacements tardifs (`remote:late` 242 par 1 000 ticks) font sous-estimer les besoins. Test : mockup W7N3 `--preset rcl4`, 8 000 ticks, avec l'énergie au sol des remotes dans le rapport.

### 5. L'espace autour de nos salles se referme (décision à prendre)

- W27N7 (voisine de W28N7, compte mort, controller RCL 3 en déclin, environ 50 000 ticks avant qu'il redevienne libre) est déjà visée par doorknobnob, qui a un claimer sur place (probablement `attackController` pour accélérer le déclin). Notre expansion n'envisage que les salles sans propriétaire : elle ne la verra qu'une fois libre, sans doute trop tard.
- doorknobnob (GCL 2, 1 tour) a pris W28N8, ancienne remote de W28N7. Blindfold réserve W28N4, une ancienne source de W27N5.
- Les remotes possibles de W24N8 sont prises (W25N8 par asdpof, avec garde armée ; W23N8 par WitchDocter) ou exposées (W24N7, à côté de la stronghold W24N6 de niveau 2). W24N8 n'a donc que de mauvaises options de remote, ce qui renforce le point 1.

Choix possibles : ajouter aux cibles d'expansion les salles possédées sans spawn ni tour (claimer qui attaque le controller pour accélérer son déclin, puis claim) ; ou rien, et laisser W27N7 à doorknobnob. Attaquer un joueur reste hors du périmètre par défaut (`Memory.military.auto` est faux).

### 6. Petits coûts fixes (gain faible)

`RoomVisuals` 0,33 CPU/tick alors que le budget plafonne (seuls le panel et le spawn restent), `MarketManager` 0,064, `Labs` 0,11 avec 3 labs. Ensemble, environ 0,5 CPU, soit un tiers de salle de remote. À ne traiter qu'après les points 1 et 3.

## Prochaines étapes proposées

1. Déployer master (point 2).
2. Corriger le blocage de l'expansion (point 1) avec test mockup, puis déployer avant le GCL 5 (environ 3 jours).
3. Ajouter `intents:move:<role>`, déployer, relire après 5 000 ticks, puis choisir la piste du point 3.
4. Décider pour W27N7 (point 5).

## Refaire ce relevé

```bash
node scripts/live-inspect.mjs                                 # nos compteurs
node scripts/shard0-neighbours.mjs --radius 5                 # voisins, GCL, saisons
node scripts/shard0-neighbours.mjs --rooms W25N2,W26N1 --gcl-ticks 1000   # salles et points/tick
```
