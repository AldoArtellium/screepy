# Hivemind — spécification de portage : LABS, RÉACTIONS ET BOOSTS

Source : `C:\Users\ruffa\AppData\Local\Temp\bots\hivemind\src` (MIT). Références `fichier:ligne` relatives à `src/`.
Comparaison : The International (`/tmp/bots/The-International-Open-Source/src`, `room/commune/labs.ts`).
Conventions : `getBestOption` (priorité la plus haute, puis poids) ; les dispatchers interrogent les providers par priorité décroissante.

Hors périmètre : évacuation (vidage des labs, `resource-source/lab.ts:127-155`), boosts des power creeps, boosts WORK des mineurs, mules et dismantlers, réglage `MOVE` boosté du body builder (`creep/body-builder.ts:203-212`).

---

## 1. Disposition des labs (`process/rooms/owned/labs.position.ts`)

- Process toutes les **3000** ticks (`labs.ts:40-44`) ; `canPerformReactions = false` d'abord (`labs.position.ts:32`).
- Labs opérationnels ; moins de 3 : rien (`:34-35`).
- Pour chaque lab `lab`, les labs à portée 2 (`closeLabs`, au moins 2) ; pour chaque `lab2` de `closeLabs`, les réacteurs = les autres labs de `closeLabs` aussi à portée 2 de `lab2` ; on garde la paire avec le plus de réacteurs (`:43-65`).
- Résultat : `room.memory.labs = {source1, source2, reactor[]}`, `canPerformReactions = true` (`:67-70`).

## 2. Choix de la réaction (Hivemind)

- Process toutes les **1500** ticks (`labs.ts:48-52`, `labs.reactions.ts:31-44`) ; rien en évacuation.
- `LabManager.getReactionFor` (`empire/lab-manager.ts:2-31`) : sur les ressources totales de la room (storage + terminal + factory + labs, `prototype/room.resources.ts:436-500`), pour chaque paire de réactifs présents, `maxProduction = min(r1, r2) - produit` ; on ne produit pas un **T1** (nom de 2 lettres) au-delà de **10 000** (`:17`) ; la paire au plus grand `maxProduction` gagne (`:23-26`). Réaction gloutonne : on produit ce qu'on a en plus grande quantité, sans but.
- `room.memory.currentReaction = [r1, r2]` (`labs.reactions.ts:40`).

## 3. Réactions (`process/rooms/owned/labs.ts`)

- À chaque tick (process `PRIORITY_ALWAYS`, `process/rooms/owned.ts:96-101`), si `canPerformReactions` (`labs.ts:46`).
- Les deux labs sources doivent contenir exactement `currentReaction[0]` et `[1]` (`:86-89`), sinon « waiting ».
- Chaque réacteur non réservé aux boosts (`:100`) et sans cooldown : `runReaction(source1, source2)` (`:106`).
- Statistiques `labUsage` (busy / idle / waiting, divisées par 2 tous les 10 000 ticks, `:64-111`).

## 4. Transport des minerais (dispatcher, transporters)

### Source `lab` (`dispatcher/resource-source/lab.ts`, priorité max 3, liste vide cachée 25 ticks)
- Réacteurs (`:40-89`) : tout minerai d'un réacteur (sauf le composé de boost attendu dans un lab de boost) : priorité 0, +1 au-delà de 80 %, 90 % et 95 % de `LAB_MINERAL_CAPACITY` ; un produit qui n'est pas celui de la réaction en cours : priorité 3, poids 0 ; poids `quantité / capacité` ; -2 par creep ayant cet ordre ; seulement si priorité > 0.
- Sans réaction : vider les deux labs sources et les réacteurs (`:91-100`, priorité 3, poids 0).
- Avec réaction : vider un lab source qui contient un autre minerai que le sien (`:103-125`).
- `isValid` (`:157-166`) : le lab a la ressource, le creep a de la place. Exécution : `withdraw` à portée 1 (`:168-184`).

### Destination `lab` (`dispatcher/resource-destination/lab.ts`, priorité max 3)
- Seulement avec une réaction (`:22`). Pour chaque lab source et son réactif (`:28-29`) : rien s'il contient un autre minerai ; rien s'il est plein à plus de 80 % (`:41-42`).
- Priorité `3 + 1` si le lab est vide ou a moins de `LAB_REACTION_AMOUNT`, sinon 3 ; -1 s'il est plein à plus de 20 % ; poids `1 - rempli`, quantité = place libre (`:44-58`).
- Le transporter, avec storage, va chercher ce que la destination la plus importante demande (`role/transporter.ts`) : les réactifs viennent du storage / terminal par la source `storage` (priorité 0 pour une ressource demandée).

## 5. Boosts (`boost-manager.ts`)

- Un `BoostManager` par room possédée, à chaque tick (`process/init.ts:77-79`) ; mémoire globale `Memory.boost = {creeps: {nom: {composé: parties}}, labs: {id: composé}}` (`boost-manager.ts:22-25`, `:39`).
- `canSpawnBoostedCreeps` : au moins un lab opérationnel (`:46-50`).
- **Spawn** (`spawn-manager.ts:259-272`) : après un `spawnCreep` réussi, `role.getCreepBoosts(room, option, body)` donne `{partie: composé}` ; on compte les parties de chaque type → `markForBoosting(nom, {composé: nombre de parties})` (`boost-manager.ts:82-84`).
- **Boost disponible** (`getAvailableBoosts` `:142-179`, caché 1 tick) : rien si storage + terminal ont moins de **2500** énergie ; pour chaque composé de `BOOSTS` présent au storage ou au terminal : `effect` et `available = floor(quantité de la room / LAB_BOOST_MINERAL) - parties déjà demandées`.
- **Meilleur boost** (`spawn-role/spawn-role.ts:92-123`) : composés avec `available >= parties`, tier (longueur du nom) `<= maxTier` si donné ; meilleur effet (le plus petit pour `damage` : bogue, la branche `else` reprend le plus grand effet).
- **Labs de boost** (`manageBoostLabs` → `ensureBoostsHaveLabAssigned` `:302-330`) : pour chaque composé demandé (par les creeps présents dans la room, `:263-274`) sans lab : un lab hors labs sources et hors labs déjà réservés, score `(1 - autre minerai / capacité) + énergie / capacité` ; `Memory.boost.labs[id] = composé`. Le lab n'est plus un réacteur (`labs.ts:100`).
- **Creep à booster** (`overrideCreepLogic` `:100-122`, appelé dans `Role.preRun`, `role/role.ts:38-46`) : si le creep est dans `Memory.boost.creeps` : abandon quand `ticksToLive < 0.7 x CREEP_LIFE_TIME` (`:104-108`, ~450 ticks après le spawn) ; sinon le lab le mieux préparé (`getMostPreparedLab` `:282-300` : `min(énergie / 20 / parties, 1) + 3 x min(composé / 30 / parties, 1)`) ; pas de lab : attendre à portée 5 du controller (`:113-117`) ; sinon à portée 1 du lab, `boostCreep` quand le lab a le composé et l'énergie pour toutes les parties, un boost par lab et par tick (`:186-214`) ; après un boost, le composé est retiré de la demande et le lab libéré s'il ne sert plus à aucun creep présent (`:216-221`).
- Nettoyage tous les 758 ticks : creeps morts, labs détruits ou plus demandés (`:226-246`).

### Qui demande des boosts (`getCreepBoosts`)
- Squads (`spawn-role/squad.ts:223-240`) : healer `HEAL` / heal, attaquant `ATTACK` / attack, blinky boosté `RANGED_ATTACK`, `HEAL`, `TOUGH` (damage) et `MOVE` (fatigue).
- Défense (`spawn-role/room-defense.ts:228-259`) : builders d'urgence `WORK` / repair, guardians `ATTACK` / attack ou `RANGED_ATTACK` / rangedAttack, tier au plus celui des boosts ennemis (`getMaxEnemyBoostLevel` : 0 = sans limite quand les ennemis sont NORMAL ou moins).
- Builders (`spawn-role/builder.ts:204-209`) : `WORK` / repair au-delà de NORMAL. Upgraders (`upgrader.ts:192-198`) : RCL 8 et 50k d'énergie. Mineurs de minerai (`harvester.minerals.ts:110-115`) : `WORK` / harvest au-delà de 2000.

## 6. Helper (`role/helper.ts`, `spawn-role/helper.ts`)

- Spawn : **1** helper quand la room a au moins un lab de boost (`spawn-role/helper.ts:15-24`), **priorité 5, poids 1,1** ; corps CARRY (au plus 12) avec mouvement route, énergie `min(capacité, max(0,9 x capacité, disponible))` (`:41-52`).
- Rôle (`role/helper.ts:29-52`) : livre quand plein, ramasse quand vide ; nettoyage d'abord : un lab de boost contenant un autre minerai est vidé vers le storage (ou le terminal) (`:92-123`).
- Ramassage (`:195-259`) : pour chaque lab de boost, le composé manquant (`parties x 30 - lab - porté`) depuis `getBestStorageSource`, borné par la place du lab ; puis l'énergie manquante (`parties x 20`) ; rien à faire : livrer ce qu'il porte, sinon se garer sur `helper_parking` (`:60-69`).
- Livraison (`:131-187`) : composé puis énergie dans les labs de boost jusqu'au besoin ; le reste au storage / terminal (`getBestStorageTarget`).

## 7. Niveaux de ressources et market

- `resource-level-manager.ts:46-52` : les niveaux appliqués sont le max des seuils applicables. Boosts (`:132-156`) : `[15k, 7,5k, 2,5k]` pour les composés d'upgrade à RCL 8 et, face à des ennemis > NORMAL, pour attaque, distance et réparation ; `[1, 0, 0]` sinon sous attaque ; `[15k, 0, 0]` par défaut. Réactifs de la réaction en cours (`:158-173`) : `[30k, 20k, 10k]` (`[1, 0, 0]` sous attaque). Ils pilotent les envois entre terminaux.
- Market (`process/trade.ts:74-111`) : **achète** les minerais de base (tier 1) sous 10k par room (ordre) et 5k (achat immédiat forcé) ; vend les composés au-delà de 5k quand le marché paie plus que leurs réactifs. Déjà porté (`MarketManager`).

## 8. The International : ciblage par chaîne inverse (`room/commune/labs.ts`)

- `targetCompounds` (`:124-135`) : quantités voulues par composé (KH 15k, G 10k, et les T3 à 10k).
- `deficits` (`:466-486`) : `-stock` pour chaque composé, puis `chainDecompose(cible, quantité)` (`:450-459`) ajoute la quantité au déficit de la cible et descend dans ses réactifs avec `min(quantité, déficit)`.
- `findNextReaction` (`:589-606`) : cibles en déficit, triées par déficit décroissant ; `chainFindNextReaction(cible, déficit)` (`:559-587`) : réactifs « manquants » = stock `< déficit x (0,25 + 0,05 x réacteurs)` ; aucun : on produit la cible ; sinon on descend dans les réactifs fabricables (les minerais de base ne le sont pas) et on produit le premier qui peut l'être.
- `setCurrentReaction` (`:518-544`) : objectif `stock + min(5000, quantité)` ; réaction finie (`:546-557`) quand un réactif tombe sous `LAB_REACTION_AMOUNT` ou que l'objectif est atteint ; replanification au plus tard après 3000 ticks ; rien à produire : nouvel essai dans 30 ticks.

## Choix pour Screepy

**Ciblage : la chaîne inverse de TI**, avec nos cibles. La règle gloutonne d'Hivemind produit ce dont on a le plus (souvent des T1 inutiles, plafonnés à 10k, puis vendus) et n'atteint les T3 que par hasard ; la chaîne de TI part du composé voulu et fabrique d'abord ses intermédiaires, ce qui sert directement nos boosts. Écart avec TI : les cibles sont parcourues **dans l'ordre de priorité militaire** (TI : par déficit), parce que l'attaque passe avant le reste :
1. `XLHO2` (HEAL : ce qui manque le plus face aux tours), `XGHO2` (TOUGH), `XUH2O` (ATTACK), `XKHO2` (RANGED_ATTACK), `XZHO2` (MOVE) ;
2. `XLH2O` (WORK repair, builders d'urgence).

Cibles de 3000 par composé (TI : 10 000 ; une room seule n'a pas le débit pour plus), objectif par cycle `stock + déficit`, borné entre 1000 et 3000 (TI : au plus 5000, sans minimum ; quelques parties boostées laissaient des lots de 100 à 200, surtout du transport). Sans X, la chaîne s'arrête aux T2 (`GHO2`, `LHO2`...), qui boostent aussi.

Le reste suit Hivemind : disposition des labs, réactions, transport par le dispatcher (source et destination `lab`), BoostManager, helper, `getCreepBoosts` au spawn, niveaux de ressources. Achat des minerais de base : déjà fait par le `MarketManager`.
