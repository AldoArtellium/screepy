# Couche logistique : conception

Date : 2026-10-16. Statut : en attente de validation.

## Intention

Aujourd'hui, chaque creep qui a besoin d'énergie la cherche seul. Il prend la source d'énergie la plus proche, sans savoir ce que font les autres.
- Dans `TaskExecutor.acquireEnergy`, il prend le tas, le container, le stockage ou la source le plus proche.
- Les livraisons passent par des tâches `FILL_SPAWN`, `FILL_EXTENSION`, `FILL_TOWER`, `FILL_STORAGE`, `PICKUP_RESOURCE` et `WITHDRAW_CONTAINER`, générées tous les 5 ticks.

Conséquences mesurées sur le serveur local :
- **Creeps qui se gênent.** Plusieurs creeps visent les mêmes 50 d'énergie. Des creeps s'agglutinent sur une source aux cases limitées : environ 8 000 échecs de déplacement par partie dans W7N3, avant un correctif d'urgence. Des containers restent pleins pendant que le spawn manque d'énergie.
- **Économie très en retard.** Sur 8 000 ticks, Hivemind fait 107 085 points de contrôleur dans W7N3, contre 6 706 pour ce bot (×16). Dans W1N3, c'est 20 300 contre 3 934.

Les bots de référence (Overmind, Hivemind, The International) ont tous une couche qui relie « qui a de l'énergie à donner » à « qui en a besoin », et qui compte ce qui est déjà en route. Ce document décrit cette couche.

Elle est aussi le prérequis de deux chantiers à venir :
- le modèle mineurs fixes + transporteurs à haut RCL ;
- les labs et l'usine, qui ont besoin de transporter des minéraux.

## Objectifs

1. Une seule source de vérité par room pour l'énergie disponible (**offres**) et l'énergie demandée (**besoins**).
2. Des **réservations**. Un creep qui a choisi une offre ou un besoin y réserve une quantité, que les autres creeps voient immédiatement. Plus jamais trois creeps pour les mêmes 50 d'énergie.
3. Les livraisons au spawn, aux extensions, aux tours et au stockage passent par les besoins, plus par des tâches générées tous les 5 ticks.
4. Les workers (construction, réparation, upgrade) prennent leur énergie dans les mêmes offres que les transporteurs.
5. Mesurable : gain net sur le benchmark 3 rooms par rapport à l'état actuel (voir « Validation »).

## Hors périmètre (pour cette version)

- Minéraux, labs, usine, terminal (le modèle doit le permettre plus tard, voir « Extensions prévues »).
- Links.
- Logistique entre rooms : minage distant, aide aux nouvelles rooms. RemoteMiningManager garde ses propres rôles.
- Appariement optimal ou stable. Overmind l'a implémenté mais tourne en glouton en production.
- Réécrire le système de tâches pour la construction, l'upgrade, la réparation et la récolte : il reste en place.

## Anti-objectifs (échec même si « ça marche »)

- **CPU** : plus d'environ 1 CPU par tick ajouté avec 20 creeps.
- **Creeps inactifs alors qu'il reste des offres accessibles** : même résultat qu'aujourd'hui, en plus complexe.
- **Réservations orphelines** (creep mort, cible détruite) qui bloquent une offre ou un besoin pendant longtemps.
- **Mémoire qui grossit** avec le nombre de demandes. Les demandes vivent en heap, seule la réservation de chaque creep va en `Memory`.
- **Régression dans les rooms en marais** (W9N5), où ce bot fait aujourd'hui mieux que Hivemind.

## Contexte d'usage

Le bot est destiné au **serveur officiel, face à de vrais joueurs** (réponse de l'utilisateur). Trois conséquences :
- **CPU** : le budget de départ est de 20 CPU, donc l'anti-objectif CPU est une limite stricte.
- **Robustesse** : une erreur ne doit jamais bloquer le remplissage du spawn.
- **Défense** : en mode défense, le remplissage des tours passe avant les extensions.

## Contraintes

- TypeScript, lodash 3, architecture actuelle : `ModuleManager`, `TrafficManager` (cartographer), système de tâches, registre de rôles, `requestSpawn`.
- Les demandes sont reconstruites à partir de l'état du jeu : un reset global (perte de la heap) ne doit rien casser.
- Les déplacements passent par `trafficManager.requestMove`. Les creeps au travail réenregistrent chaque tick leur intention de rester à portée.
- Les modules à rôle (scout, minage distant, claimer) ne participent pas à la couche logistique.

## Conception

### Modèle de données (heap, reconstruit au plus une fois par tick et par room, à la première requête)

```ts
interface LogisticsRequest {
    id: string;                 // `${kind}:${targetId}:${resourceType}`
    kind: "offer" | "need";
    targetId: Id<AnyStoreStructure | Resource | Tombstone | Ruin | Creep>;
    pos: RoomPosition;
    resourceType: ResourceConstant;  // RESOURCE_ENERGY pour cette version
    amount: number;             // quantité restante, réservations déduites
    priority: number;           // plus bas = plus important
}
```

### Réservations

Elles sont stockées dans la mémoire du creep, pour survivre aux resets globaux :

```ts
creep.memory.logistics = { kind, targetId, resourceType, amount }
```

À la construction des demandes d'une room :
- on additionne les réservations de tous les creeps vivants par cible ;
- **offre effective** = stock − réservations de retrait ;
- **besoin effectif** = capacité libre − réservations de livraison.

Une demande dont la quantité effective est ≤ 0 n'est pas publiée. Quand un creep réserve, la demande en heap est diminuée immédiatement, pour que le creep suivant dans le même tick la voie déjà réduite.

La réservation est libérée :
- quand le creep a terminé son action (retrait ou transfert effectué) ;
- quand la cible n'existe plus ou n'a plus rien à offrir ou à recevoir ;
- après un délai sans progrès (même principe que le délai sans progrès des tâches).

Les creeps morts disparaissent de la somme d'eux-mêmes.

### Qui publie quoi

**Offres :**
- énergie au sol au-delà d'un seuil ;
- tombes et ruines ;
- containers de source ;
- stockage. Pour les non-transporteurs, l'offre du stockage n'est visible qu'au-dessus d'un plancher, sauf quand la room n'a pas encore de transporteurs.

**Besoins :**
- spawn et extensions (priorité maximale) ;
- tours, avec une priorité qui dépend de leur niveau, plus forte en mode défense ;
- container du contrôleur, s'il existe ;
- stockage, comme puits de dernier recours (priorité minimale).

Les workers ne publient pas de besoin : ils viennent se servir dans les offres. C'est le choix le plus simple, pris chez Hivemind.

### Appariement (glouton, seulement pour les creeps qui demandent)

- `claimOffer(creep)` : meilleure offre selon `priorité × K + distance`.
  - On écarte les offres trop petites par rapport à la capacité libre du creep, sauf si le creep est tout proche (règle `onlyFull` de The International).
  - Si aucune offre ne convient et que le creep a des WORK, il récolte à une source qui a encore une case libre (logique `harvestSlotsLeft` déjà en place).
- `claimNeed(creep)` : meilleur besoin selon le même score. Si aucun ne convient, le creep livre au stockage s'il existe, sinon il reste en attente près du spawn.
- `release(creep)` : libère la réservation.

### Intégration

- `TaskExecutor.acquireEnergy` passe par `claimOffer` et remplace la sélection actuelle (`findEnergySource`, `energySourceId`).
- Les tâches de livraison (`FILL_SPAWN`, `FILL_EXTENSION`, `FILL_TOWER`, `FILL_STORAGE`, `PICKUP_RESOURCE`, `WITHDRAW_CONTAINER`) ne sont plus générées. Elles sont remplacées par un comportement « transport » : se servir dans une offre, puis livrer à un besoin.
  - Ce comportement est exécuté par les creeps `TRANSPORT`.
  - Il est aussi exécuté par les workers **quand il existe un besoin de priorité spawn ou extension non couvert**. Sinon le spawn s'arrête au début de partie, faute de transporteurs, car les workers font tout.
- `DemandCalculator` ne change pas pour la demande de CARRY.
- `TrafficManager.getCreepPriority` s'appuie sur l'état logistique plutôt que sur le type de tâche `FILL_*`.

### Décisions précisées après relecture (choix de Claude, à vérifier)

1. **Bascule des workers vers le transport.**
   - Quand ils basculent : un worker ne quitte jamais une tâche en cours (construction, upgrade, réparation). Il ne bascule que s'il est libre (pas de tâche), ou au moment où il devrait aller chercher de l'énergie (état `acquiring`).
   - Combien : seulement le nombre nécessaire. `claimNeed` réserve la quantité, donc une fois le besoin du spawn et des extensions couvert, plus aucun worker ne bascule.
   - Ce que ça déclenche : la bascule passe par la couche logistique (`claimNeed`). Le worker garde sa tâche s'il en a une, et la reprend après la livraison.
2. **Container du contrôleur.**
   - C'est un besoin pour les transporteurs.
   - C'est une offre visible **uniquement** des creeps qui font une tâche d'upgrade, avec un bonus de priorité.
   - Le modèle de données accepte donc un filtre par catégorie de creep sur une offre, ce qui évite les allers-retours de transporteurs.
3. **Transporteurs (`BodyType.TRANSPORT`).**
   - Ils sortent du `TaskDispatcher`. Ils ne fonctionnent que par la couche logistique et n'ont pas de `currentTask`.
   - Ils ne deviennent **pas** un rôle : pas de `memory.role`, sinon `DemandCalculator` ne compterait plus leurs CARRY.
   - Définition d'**inactif** pour la validation : ni tâche, ni réservation logistique. La stat `idleCreeps` est adaptée en conséquence.
4. **Référence « avant » du benchmark.**
   - Le code de départ est l'état actuel, correctif d'urgence inclus (choix de source avec case libre). Il est commité avant de commencer.
   - L'outillage de mesure (nettoyage des rooms, `moveError`, échantillons) est le même pour l'avant et l'après.
5. **Mineurs fixes.**
   - Cette version vise le mode par défaut, sans mineurs (`Memory.config.staticMiners` désactivé).
   - Quand des mineurs existent, `harvestSlotsLeft` les compte déjà (tâches `HARVEST_SOURCE`).
   - Les workers ne récoltent eux-mêmes qu'en dernier recours, quand aucune offre ne convient. Une source équipée d'un container avec mineur n'est jamais choisie pour récolter : on prend dans le container.

### Extensions prévues (pas dans cette version)

- `resourceType` autre que l'énergie : besoins des labs et de l'usine, offres de l'extracteur, demandes « vider le mauvais minéral ».
- Trajets en deux étapes : retirer au stockage ou au terminal, puis livrer au lab. Équivalent de la `delivery` de The International.
- Ignorer pendant N ticks un type de demande qui revient vide (astuce de Hivemind).

## Validation

- Benchmark sur 3 rooms (W7N3, W9N5, W1N3), 8 000 ticks, rooms nettoyées, **2 parties par configuration**, avant et après.
- Métriques suivies :
  - points de contrôleur et nombre d'extensions ;
  - échecs de déplacement (`moveError`) et temps d'inactivité ;
  - CPU moyen (`Memory.stats`) ;
  - absence d'erreurs de module.
- Référence externe : Hivemind 3.0.0 sur les mêmes rooms (déjà mesuré : 107 085 / 20 300 / 189).
- Critère d'acceptation : gain net en W7N3 et W1N3, pas de régression en W9N5, CPU dans les anti-objectifs.

## Laissé au constructeur

- Les valeurs exactes des priorités, de K et des seuils (énergie au sol minimale, plancher du stockage, règle « trop petit pour se déplacer »).
- Le découpage en fichiers sous `src/logistics/`.
- L'ordre de migration, à condition que chaque étape passe le typecheck et un test serveur court.
