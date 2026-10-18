# Hivemind — spécification de portage : LINKS (RCL 5+)

Source : `C:\Users\ruffa\AppData\Local\Temp\bots\hivemind\src` (MIT). Toutes les références `fichier:ligne` sont relatives à `src/`.
Périmètre : plan des links, ordre de construction, réseau (rôles in / out / neutre), transferts, dépôt des harvesters, retrait des upgraders, fournisseurs du dispatcher, effet sur le nombre de transporteurs.

Constantes : `LINK_CAPACITY=800`, `LINK_LOSS_RATIO=0.03`, `LINK_COOLDOWN=1` (par case de distance), `CONTROLLER_STRUCTURES.link = {5: 2, 6: 3, 7: 4, 8: 6}`.

---

## 1. Plan (`room/planner/`)

| Type | Où | Source |
|---|---|---|
| `link.controller` + `link` | à côté de la position `upgrader.0` (case constructible, routes exclues, sorties proches permises) : maximise le nombre de cases d'upgrade (3x3 autour du candidat, à portée 3 du contrôleur) - 1, +1,5 si la case est hors de portée 3 du contrôleur (ne bloque pas une case d'upgrade) ; protégé par le min-cut (`protectPosition(pos, 0)`) | `variation-builder.ts:205`, `:261-298` |
| `link.storage` + `link` | centre x-1, y (cœur) | `variation-builder.ts:355-356` |
| `link.source` + `link` | première case libre de la bay du harvester (avant les extensions) | `variation-builder-base.ts:79-105` |

Le contrôleur est placé juste après le container du contrôleur, avant le blocage de la case `upgrader.0` (`variation-builder.ts:197-219`).

## 2. Construction (`room/room-manager.ts`)

`manageLinks()` (`:549-568`), appelé après storage / terminal et les routes de marais (`:411`), avant le retour « RCL < 4 » :

```ts
limit = CONTROLLER_STRUCTURES.link[rcl]; count = 0
removeUnplannedStructures('link', STRUCTURE_LINK, 1)            // links hors plan détruits (1 à la fois)
if (!buildPlanned('link.controller')) return; if (++count >= limit) return
for (pos of link.source triés par distance au contrôleur décroissante) { if (!tryBuild(pos)) return; if (++count >= limit) return }
buildPlanned('link.source'); buildPlanned('link.storage'); if (++count >= limit) return
buildPlanned('link')
```

Conséquence avec 2 sources : RCL 5 = contrôleur + source la plus lointaine ; RCL 6 = + 2e source ; **le link du storage n'arrive qu'à RCL 7**. Avec 1 source : RCL 6.

## 3. Réseau (`link-network.ts`, `prototype/room.structures.ts:139-171`)

Généré chaque tick (`process/init.ts:80`) avec les links opérationnels :

- `memory.controllerLink` : link sur une position `link.controller` du plan, sinon à portée 3 du contrôleur (`prototype/room.intel.ts:289-310`, rafraîchi toutes les 10 ticks via `scan`, `:242-255`). `memory.storageLink` : même logique avec `link.storage` / portée 3 du storage (`:315-338`).
- Link d'une source : link le plus proche à portée 3 de la source (`manager.source.ts:177-198`, cache heap 1000 ticks).
- Rôles (`room.structures.ts:156-170`) : contrôleur = **out** (niveau voulu = capacité, 800) ; contrôleur et source à la fois = **in-out** (400) ; source = **in** (niveau voulu 0) ; autres = **neutre** (storage).
- `__addLink` (`link-network.ts:39-64`) : `energy`, `energyCapacity` ; `minEnergy` += niveau voulu ; `maxEnergy` += niveau voulu, ou capacité pour un neutre. `underfullLinks` (énergie < voulu, delta = manque), `overfullLinks` (énergie > voulu, delta = surplus).

## 4. Transferts (`process/rooms/owned/links.ts`)

Processus par room, `interval: 3`, priorité HIGH (`process/rooms/owned.ts:88-94`). `MIN_ENERGY_TRANSFER = LINK_CAPACITY / 4` = 200 (`:7`).

```ts
if (!overfull.length && !underfull.length) return
from = meilleur overfull sans cooldown (delta max) si delta >= 200, sinon neutre sans cooldown le plus plein (delta = son énergie), sinon overfull[0]   // :67-73, :83-93
to   = meilleur underfull (delta max) si delta >= 200, sinon neutre le plus vide (delta = place libre), sinon underfull[0]                         // :75-81, :95-105
if (!from || !to || from === to) return
amount = floor(min(from.delta, to.delta)); if (amount < 200) return
from.link.transferEnergy(to.link, amount)                        // :54-64
```

Un transfert par room et par exécution.

## 5. Harvesters (`role/harvester.ts`)

Dans `depositResources` (`:249-300`), quand le creep ne peut plus contenir une récolte complète : cible = container de la source s'il a de la place ; si la source a un link (`getNearbyLink`) avec de la place, **le link remplace le container** ; sinon un autre link à portée 3 de la source avec de la place (`:262-282`). Transfert sauf si la cible est le container sous le creep. En bay de harvester, `Bay.refillFrom` remplit aussi le link (ordre spawn, extension, tour, link, container ; `manager.bay.ts:18`, `:161-180`) quand le creep est plein.

## 6. Upgraders (`role/upgrader.ts`, `spawn-role/upgrader.ts`)

- En upgradant, quand l'énergie portée < 2 x WORK : retire du link du contrôleur (> 50 d'énergie, à portée 1), sinon du container du contrôleur (`:118-136`).
- Pour se recharger : link du contrôleur (> 50) d'abord, puis container (> 50), tas au sol, autres containers (`:146-170`). Sans link ni container : se sert comme un transporteur (`:209`).
- Corps « accès facile » (WORK x10, déplacement lent) si container **ou** link du contrôleur (`spawn-role/upgrader.ts:150`).

## 7. Dispatcher

- Source `link` (`dispatcher/resource-source/link.ts`) : links **neutres** non vides, priorité 5 (-1 si le creep est à plus de 10 cases, -2 par creep ayant déjà l'ordre), poids énergie / 100 ; valide seulement si `network.energy > network.maxEnergy` (trop d'énergie dans le réseau : vider le link du storage).
- Destination `link` (`dispatcher/resource-destination/link.ts`) : links **neutres** non pleins, priorité 5 (-1 au-delà de 10 cases), poids place libre / 100, quantité = place libre ; seulement si `network.energy < network.minEnergy` (le link du contrôleur manque d'énergie : le remplir depuis le storage).
- Le container du contrôleur reste une destination normale avec link (`dispatcher/resource-destination/container.ts`, inchangé).

## 8. Transporteurs (`spawn-role/transporter.ts`)

Base (avec storage) `2 + 2 x sources` ; avec un link de contrôleur : `- (1 + sources qui ont un link)` (`:131-134`). Le TODO `estimateNeededCarryParts` voulait exclure les sources à link des chemins à transporter (`:190`).

## 9. Hub / filler central

Hivemind n'a pas de creep fixe au storage : le link du storage est servi par les transporteurs via le dispatcher (§7, priorité 5 quand ils sont à moins de 10 cases). Overmind (`commandCenter` manager) et The International (`hubHauler`) en ont un.
