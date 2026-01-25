---
title: Great Filters
description: The concept of a <a href="https://en.wikipedia.org/wiki/Great_Filter" target="_blank" rel="noopener noreferrer">Great Filter</a> is similar to stages of a user's bot development as, there are several steps most users go though in development that allow their bot to thrive on a server. Though you could think of these as 'goals' to complete, Screeps is ultimately a sandbox game, meaning you can do as much or as little, as you want. However, if your talking in terms of survival of a colony of creeps there are repeatable patterns that emerge in development that almost all bots follow or have some aspect of.
quicklink: true
categories:
  - Strategy
  - Game_Knowledge
---

## Creep Management - Roles, States & Tasks/Goals

The first step is to have one creep take an action, however, a user inputting multiple actions one a creep manually is not effective as a colony grows even a little. A user and subsequently their bot, needs to be able to have creeps do tasks automatically based on the conditions of their environment. There are several methods for this, and the ones listed here are by no means 'the only way'. It is up to the user, how to structure their bot.

### Roles

The tutorial for Screeps presents a solution in [roles](/Roles), where each creep is assigned a role and based on that role they have logic to do actions based on their environment. Roles can be made to fit almost any situation, but the creeps who do them often are 'locked' into their specific role unless logic specifies elsewise, meaning at base, if a creep has completed its task and there are no more tasks for it to do, unless the user specifics something more/new for it to do, it will sit until conditions change in that it can act again.

### Tasks/Goals

Another type of of creep management is [generic creeps](/Generic_Creeps), in where a creep's body is formatted to be useful for several tasks and the creep is assigned a task/goal based on a colony's needs, stresses or environmental conditions. In this way, an individual creep only needs to worry about the task/goal it was assigned and take actions accordingly, but can also when done be assigned a new task/goal. This does make creeps more dynamic, however, as their bodies are often suited for multiple tasks, the tend to be bigger/more energy expensive depending on user setup, then a specific role creep who does one thing.

## Automatic Spawning

As creeps only have a limited life-span, the next filter is making sure a colony is maintained with new creeps, when the old ones die of old age or other factors without direct user intervention. And if the worse happens and a colony is wiped out, the spawning system needs to be able to re-start itself.

### Headcount

The tutorial sets up a way to do this in the form of a 'headcount', every tick creeps are tallied up and check against hard-set values in a flowing else/if condition setup. If during the execution of the else/ifs a condition is met and/or fails (depending on setup) then the spawn is told to spawn a creep to replace the deficit. This can be evolved upon to be more dynamic as a user refactors their code.

### Part-Count Balancing

Part-Count Balancing is considering the number of parts required to complete tasks/goals in a colony instead of strictly the number of creeps. For example, when working on [remote harvesting](/Remote_Harvesting), transporting the energy back in a timely & efficient manner requires ideally different sized creeps for different distances between the source and the storage location. If you were to add up the demand of all remote harvesting locations, you would get a 'total' part count required (how many CARRY parts you'd need). At a low RCL, this part count may require lots of creeps due to the limited number of parts you can spawn per-creep (based on energy restrictions from extensions/spawns) while at later RCLs the same number of parts can be given to fewer creeps. From there, using the available energy in a room, its possible to determine the largest size creep spawnable, then determine the required number of creeps / spawn until you run out of or meet your part requirement.

### Spawn Queues

Another method of spawning creeps is with a queue, meaning that a user's code looks at conditions as they are in a colony and pushes an element to a 'queue' for the spawner to take care of in order of importance/receiving. Then, as it gets entries, the spawner handles the queue as needed.

### Cold-boot

Even with the best extension filling or spawning, an unexpected cost or cause can cause all your creeps to die necessitating in new ones to need to be spawned. Best-case, your queue/spawning system sends out a creep to handle getting energy to the extensions first but if this creep is not flexible enough it is quite possible for it to fail to spawn or fail to find/gain energy. If you come across a situation where your reserves are drained, or you can only spawn a small creep(s) it's best to have a handler to get some creeps out to start rebuilding/restarting the room so bigger/more specific creeps can take over.

## Automatic Room Defense

If it is a [invader](/Invader) or another user, at some point a colony will be attacked and need to defend itself. Invaders will show up eventually in almost every case for a room and will only get more frequent as a user gets more efficient at mining energy. While they do not kill spawns directly, they can easily break pre-set spawning code by killing off the total creeps of a colony. This makes defending from them in a timely matter not only a time-saver in respawning lost creeps, but vital for survival. Users will rarely stop at killing creeps however and, if your spawn is undefended and they go uncontested, it could easily end up in you needing to respawn. Invaders are the first stage to get you going on defense, but ultimately you will require more to keep other creep colonies from wiping you out.

You can read more about defense [here](https://docs.screeps.com/defense.html) in Screep's official docs.

### Tower Defense

The most common type of automatic room defense is the defensive structure, is a tower. Towers are available starting at RCL three, and you get more as you level up your RCL. They can reach any roomPosition/tile in the room they are constructed, but suffer a effectiveness fall-off after more than five roomPositions in distance capping a minimum at twenty or greater (See Engine Code for: Attack,Heal & Repair). Effective tower combat depends on balancing when to shoot, there are many times when more advanced creeps will be able to negate if not soak the damage done by a tower, making it a drain on energy to continue firing.

### Creep Based-defense

The other main type of room defense are creeps, if possible, spawning one or more counter creeps to out-damage and kill the attacking creep(s) is ideal, but this is not always possible.

#### Rampart-Defenders

As mentioned in [Screep's Docs](https://docs.screeps.com/defense.html#Active-defense-creeps), rampart defense creeps are a great option to supplement tower damage and/or repel invaders on their own. The main idea is to get as many/as much damage as you need from creeps being 'in range' of the attacking creeps while they are able to stay safely inside the ramparts.

#### Repair spam

Repair spam or simply repairing, is when you attempt to out-repair the incoming damage of the attacking creeps. This tends to be rather effective in slowing down of not countering enemy damage, but does require alot of stored energy and/or a income source of energy to maintain the defense.

#### Active-Counter

If possible, you could spawn a creep/a squad of creeps to actively hunt down and destroy attackers. This of course, requires that the creep(s) attacking are able to out-damage/heal the attacking creeps, but with tower-based support, it is quite a home-field advantage.

### SafeMode

You can read more about safe-modes in [Screep's docs](https://docs.screeps.com/defense.html#Safe-mode)

## Effectively Harvesting Energy & Remote Mining

The first step for any creep-based system almost always to harvest energy, and haul it somewhere (to fill spawn, to upgrade, to build) . However, opportune harvesting on individual creep needs does not normally enable the use all the energy that room(s) can output. A common tactic do this is to employ some form of [Static Harvesting](/Static_Harvesting) where dedicated creep(s) harvest energy before the regeneration cycle occurs. Once the main-room's energy has been harnessed, additional energy can be brought into the room by going to get it from adjacent or nearby rooms. This is known as or [Remote Harvesting](/Remote_Harvesting).

### Harvesting Types (Kardashev scale)

#### Type Zero

A 'Type Zero' room is normally one that uses role/generic creeps to harvest on-occasion that a creep needs energy, not taking into account the overall energy available to harvest. (See: [Energy](/Energy) for more details). Most bots start-out at this level.

#### Type One

A 'Type One' room is normally one that can harvest energy completely from sources in the room, meaning the 'maximum' amount of energy is harvested. This is a good level to get to, to enable your bot to do more with what it is given at low RCL.

#### Type Two

A 'Type Two' room is normally one that along with harvesting all the energy before a regeneration cycle in its own room, that it also does that with multiple adjacent rooms. This is commonly the next task folks do when needing more energy to upgrade faster & again, do more.

#### Type Three

A 'Type Three' room(s) is normally one that can harvest 'all' the energy of a [sector](/Map), this does normally require multiple rooms working in conjunction to do. While not very common, there are several bots that block-out sectors to do this, even if not harvesting every source (as not every source would be profitable for X given room)

#### Type Four?

A 'Type Four' room(s) would be a colony harvesting all energy from a [Shard](/Shard), effectively meaning your bot has free reign to harvest everything any anything. Theoretically if you were to consider an alliance as one 'entity' YP probably comes the closest to this on Shard 1 as of writing.

#### Type Five!?

A 'Type Five' room(s) would be a colony harvesting all energy from every existing set of connected shards.

### Harvesting Methods

See: [Energy](/Energy) for more details on Getting, Moving and Storing energy.

#### Harvesting

Getting a creep to their designated room, then to the source and mining the energy is the first step.

#### Hauling

Getting a creep to return with their harvested energy, or assigning creeps to bring that energy back is the next step.

#### Reserving

While not strictly required, reserving a room allows more energy to be harvested from the room and to keep other's from harvesting it. (applies to rooms that are not owned by the user)

## Claiming new rooms

Once a user hit's [GCL](/Global_Control_Level) two, they can claim another [room](/Map) to build a spawn and continue doing so for each GCL they gain thereafter. The easiest way to pick a room is of course, to let the user themselves evaluate the importance/need for a room then dispatch builders, however getting your bot to do it automatically can be a huge step towards a colony expanding on its own.

### Claiming

A creep with claim parts needs to travel to an adjacent [roomPosition](/Map#roomposition) to the target room's [controller](/StructureController) and execute a `claimController()` call. If the user has spare GCL, the room will be claimed, the controller will need energy to upgrade/stay claimed, and a spawn construction site can be placed. As a creep with claim parts only has 600 ticks-to-live, a room needs to be ~599 tiles (roomPositions) away from where it was spawned. As rooms are 50 by 50 tiles, you can claim a room ~10-12 rooms away from your spawn (depending on [terrain](/Terrain) generating more fatigue via swamps for the creep or blocking/longer paths around walls, obstacles like other players, ect).

### Building

Unlike a first-spawn room, when claimed subsequent rooms require a construction site to be placed to build the spawn. As such, the original room that sent the claimer needs to provide workers/builders to build up the construction site and maintain the controller before the room can be self sufficient. Even when the spawn is built, the original room can send larger sized creeps to build up the lower [RCL](/Room_Control_Level) room faster than it would be able to with its normal sized creeps for its level.

### Multi-Room Management

Two or more rooms comes with its own challenges. Many methods/code relied on to work for only one room, can fail without taking multiple rooms into account. Creeps need a way to distinguish which room is 'their home' to take tasks/goals/roles, use data for their given room, ect. As well, any room-level operations can be standardized so each 'owned' room can be iterated over and actions taken based on need instead of hard-coding solutions to the room's properties.

## Room Offense

A colony needs rooms to grow and harvest from, occasionally those rooms are occupied by other users' colonies. Mounting an offense to take/capture rooms from other users helps a colony expand further.

### Locating Targets

Either by manual user-means or though scouting/observer reports it is possible to 'scan/cache' a user's base and information to use in planning an offensive. Generally, you/your bot will want to find fights that you will win, as such you need to take into consideration.

- The enemy user's defensive setup (walls/towers/ect)
- The enemy user's Skill level (How often are towers filled/How do their towers target creeps/How their script handles stress)
- The placement of the Enemy user's structures (How are their spawns arranged, is anything easily accessible?
- The likely-hood of retaliation (Does this user have other rooms in range? Am I ready to respond to threats?

### Choosing an attack method

Once you/your bot has scouted the enemy you then need to determine a method of attack. Depending on your skill/the enemies skill level, this can widely vary. Some common tactics are:

- Tower draining - The action of using a creep or creeps to 'drain' the opponents tower(s) reducing damage that can be dealt to attacking creeps.
- Tanking - The action of using a creep or creeps to 'tank' damage from a tower(s) or creeps to allow other creeps to slip by or attack other targets to try and gain further access to a room
- Boosting - The act of boosting creeps to improve their performance to either 'out heal' or out damage their opponents defenses
- Co-operative creep actions - Duos, Quads or other formations, groups of creeps acting in unison can normally do more than one creep can alone and without proper response, easily overwhelm defenses.
- Swarming - normally an early RCL tactic, it is possible to swarm a smaller user's room with lots of attacking or cheap creeps, to overwhelm their tower's/creeps capacity to respond to the attack, thereby making it further in to attack/destroy objects in the room. This rarely works once a user has walls, however, as the walls will allow a delay/buffer for the enemy user to prepare a response.
- Nuking - At RCL8, and access to a nuker, if the enemy user is in range a nuke can easily destroy key structures or defenses before launching an attack, one thing to note, is that the nuke does take a long time to land and is shown to the enemy user where it will land, so it is quite possible for an active/skilled enemy user to account for the nuke ahead of time.
- Remote Mining harassing - Depending on the enemy user's skill, it is quite possible to easily harass a remote mining location in order to drain energy from their main base. If not dealt with effectively, the enemy user will continue to produce creeps/defensive creeps that can easily be draining while you spend minimal resources on this action.
- Intercepting - If the enemy user is sending creeps out for a particular action or room without defense or escort, it is quite possible to intercept them with a minimal force before they reach their intended target. Examples of this would be: Remote builders traveling to a newer room, scouts exiting a main base, long-haul creeps transporting resources.

### More automatic attacks

There are a few challenges when attacking fully automatically vs manually. Some things to consider are:

- How are my creeps going to determine a weak point/best path into a base?
- How are my creeps going to target a wall/rampart first before entering?
- How are my creeps going to heal / under what conditions should they move/heal/reorient their attack?
- How are my creeps going to determine what is a priority? (Ex: Do you go for the spawn, towers, creeps first?)
- What conditions should cause my creep to adjust its attack?
- Where can my creeps stand in the room and be 'relatively' safe from towers/enemy creeps.

## Scouting & Storing information

While a user can see everything and anything in the game and add it manually to their bot/memory a user's code can not due to [vision](/Vision). Scouting is the process of using a creep or observer to get information from a room, parse it, then store it for use by other parts of the bot.

### Creep Scouting

A creep grants vision in a [room](/Map) that it is in and of course, given it has at least one move part, can travel almost anywhere within its 1500 tick life-time. As such, creep scouts are cheap and need to do little more than move to new rooms while recording information. This information of course, can be anything from enemy colony locations, new sources of energy, strongholds, deposits, powerBanks ect. The main two components are 'how do I decide where to send this creep and when?' and 'how/what information do I store and for how long?'. Though you could store everything in memory, the larger memory gets, the more expensive it is to process each tick. Global lets you store more, but isn't persistent forever, and raw memory you need to parse yourself.

### Observation Scouting

An observer will let you scan up to 10 rooms away from it, or unlimited using a power creep's power (for the effects tick duration). An observer will only grant vision in the room targeted by `observeRoom()` for the next tick after it is called. As such, you need to have a queue or system set up to target a room and then on the next tick know that the room was scanned to gather the information. Observers are late-game structures but can help save [CPU](/CPU) as observing a room only takes one [intent](/Intent) while moving a creep to a room takes many move intents. They are great for rooms that do highway harvesting, as you can scan over a set of highway rooms for targets (like deposits & powerBanks) and when one is detected, save the information for your harvesting part of your bot to take care of. You could also 'lock' an observer to a room by constantly calling it to observe a room every tick granting you vision every tick, however it is a rare use case as most of the time you can get all the info you need on one tick.

### Storing Information

Storing the information effectively and in a consistent scheme is important so that multiple parts of your script can access and use it without causing conflicts or redundant information leading to increased costs. For example, if you have a scout store information in memory in one large dump, but then take that memory and store it locally for a spawning system off a spawn structure or in a creep's memory, that duplicate information comes at a cost when the memory gets parse/stringified each tick. Similarly if you have information that is named/sorted one way, but break it down/use different systems for other parts of your script alot of conversion has to happen to get it to work vs just using one consistent method/scheme.

## Market

Using the Screep's [market](/Market) enables players to not only sell excess resources they have acquired, but purchase from other users as well. This enables more energy to be brought into a colony in a very short time, or resources that help boost other things that a colony may not be able to make/farm on its own, such as [power](/Power), deposits, or boosts. Making this automatic, is a great step in being able to bring in more items to help the colony thrive.

### Getting First Credits

Before many actions can be taken, a user first needs credits to use in the market. Users are not provided with credits on-start, so they must fulfill buy-orders of other users or NPCs in order to gain credits. This is commonly done with Energy, as it is abundant to most users but at the same time, highly in-use by others. Pixels or other account resources can also be easily sold.

### Buying/Selling

Either by automatic means or manual setting, A user can use the market to place orders to buy/sell various resources.

### Converting to Steam

By gaining credits, it is possible to purchase [account-level resources](/Account-level_Resource) that can then be sent to the user's associated Steam account. As such, these resources can then be put on the Steam marketplace for sale. These include decorations, AccessKeys, CPU Unlocks, ect.

## Lab logic & Boosts

Another filter that tends to happen late in a colony's development is the implementation of [labs](/StructureLab) to create compounds and boosts, and then in turn use those boosts to enhance creep's abilities. While not strictly 'required', another user can easily overpower a user's creeps / defense using boost and the only real counter is to use boosts in-turn to make up the gap in power. Lab logic can get complex/expensive and, boost logic can be challenging, but automating and/or mostly automating the process goes a long way in boosting a colony's defensive/offensive/harvesting power.

### Mining/buying minerals

Before you can create boosts, you first need minerals. These minerals can be mined in a user's room at RCL 6 and later after building an extractor, they can also be mined from Source-keeper rooms which have extractors already set up, or they can be purchased from the market once a user has a terminal.

### Determining what to make

What boost you want to make is of course up to the user's desire/needs. Generally once you have a steady flow of minerals you need to set priorities, levels, and requirements for what boosts you want made. You then need a creep(s) to transport these minerals to the labs, a runner to run the production of the labs and, creep(s) to withdraw the result.

### Boosting creeps

Further more when you have the boosts, you have to dedicate a lab to contain the desired boost and energy, then maneuver the creep that needs the boost adjacent to the lab that needs it. Ideally, this needs to be ready for whatever creep as soon as possible on-spawn so it can have the most use of the boost for its ticks-to-live, but not too long as to tie up the lab when it could otherwise be producing boosts.

## Highway Harvesting

While this can be some-what circumvented with the use of the [market](/Market), being able to find and then subsequently harvest valuable resources on the highways such as [power](/Power) and [deposits](/StructureFactory) helps a colony gain power and credits.

### Detecting

If you have active-scouting reports from creeps, you can store highway information, ticks to decay, and location of highway objects then just scan the list (object) for opportunities to harvest in the highway, at RCL 8, once you get an observer you can use the observer to scan highway rooms at w/e interval you desire to generate a mission/set a target/ect to harvest

### Harvesting

For powerBanks or deposits generally you have creeps work in a 'team' to harvest from them. You need to spawn the creeps, get them to their mission location and co-ordinate the harvesting/attacking of the object.

### Hauling

Once a powerbank is destroyed or a deposit harvested, you need to haul these resources back to your closest room. In the case of powerbanks, it makes little sense to actually spawn these haulers until they are needed (it takes some time to work down a powerbank) and deposits, depending on how you configure them, the creeps themselves can haul back resources, or need to take resources from the miners to haul back.

## Source-Keeper Harvesting

Source-keepers guard very valuable rooms that can help boost a colony's energy and mineral input. There are several tasks to overcome when Source Keeper Mining, such as dealing with the source-keepers and the powerful raid invasions that happen when an invasion is triggered.

### Suppressing the Keepers

Source-keepers will move within 1 tile of their closest resource (source/mineral) to their lair when spawned (and a creep is in the room, elsewise they stay near the lair) and not move until killed or dying from old-age. They will attack anything that comes into range, but not chase. Once below a % of their maximum hits or when death occurs from old age, their associated lair will start spawning a new keeper. Generally, using one or more creeps to patrol around the lairs and kill off the keepers is the preferred method. There will be a time while the keeper is respawning that the source/mineral will be accessible.

### Harvesting & hauling the resources

Generally harvesting and hauling is done while the current keeper of the source/mineral is dead, when they are about to respawn or respawned the associated miner/gather to the resource can move out of range of the keeper, as it will not chase they can stay nearby waiting for them to be dealt with

### Invaders & raids

Source-keeper rooms still have [invader](/Invader) attacks every ~100,000 energy mined, however they will always be raids (larger groups of normally boosted creeps). Depending on your setup, you either have to deal with these invaders, or wait for them to despawn. The choice is yours.

## Power Creeps

Power Creeps are powerful units created from processing [power](/Power), they enable a room and colony to do many things ranging from increasing energy/mineral gains to more offensive/defense power for a room. Getting enough power processed to create one, and the logic for it is a big step for most users.

### Getting the power

Before you can have power creeps, you need GPL(Global Power Level)s. You spend these levels to create or upgrade power creeps. Power naturally spawns in 'power banks' along highways (see highway harvesting above). Once returned to the base a user needs to process it with a powerSpawn to add the power to their account and progress towards their next level.

### Creating the PowerCreeps

Once you have power levels, you need to use either the GUI or code to create them. Once created they are assigned/stored in your account and need to be spawned onto the map from a powerSpawn that you own. If they die, they will maintained on the account, but with a cooldown before they can spawn again.

### Using the powers

Depending on your setup, really depends on how you want to use the powerCreep. Mainly, you need to have conditions set up for the power creep to react to to use its powers (much like any creep) and 'rebuff' the structures/objects when desired. A power creep for economy for example, needs to know when and where to use its powers, how often to refresh and when to renew (via powerSpawn or powerbank) to keep itself alive. Important to note, is you do have to also 'activate' power in the room using the powerCreep. Also, that regardless of their 'spawned' status in the world, they will show up in `Game.powerCreeps` meaning you must make sure not to run code for a creep that does not 'exist' in the world.

## Automatic Factories

Using a [factory](/StructureFactory) it is possible to create many different kinds of commodities, which are useful for selling on the [market](/Market) for credits which allows a user to gain credits much quicker than selling raw minerals alone. This allows for more input of resources into a colony via buy orders on the market. It does require powerCreeps to work.

### Gathering Resources & Power Creeps

A level 0 (non-powerCreep enabled factory, or not currently empowered) can produce compressed commodities and some basic commodities, this allows a user to sell these to the market and/or save space from storing them. [Minerals](/Mineral_Mining) & [Energy](/Energy) you gather though traditional means, deposits are gathered though Highway Harvesting (see above) to start making more advanced/profitable commodities. PowerCreeps require power, which you need to again, highway harvest/market & process the power, to get GPL (Global Power Levels) and spawn power creeps.

### Production

A factory needs to call `produce()` on a `RESOURCE_*` constant (where * is a resource) that is is intent on making. You need to insure that the required amount of resource(s) & energy is in the factory at the time of the call, and there is no current cooldown from a previous production, if successful, the resource will be produced and the factory will enter a cool-down phase dependent on the item that was produced. To do this more automatically, you need a creep to balance resources in the factory or on-demand place the req resources inside, then you need a system to check against what is in the factory, or what you want to / can produce. This can be done using the `COMMODITIES` constant to determine what resources are available against what the requirements are, but a user is welcome to configure it however they want. Once produced, the item can either stay in the factory to help enable further production, or be withdrawn to be stored/sold. Generally maintaining a balance inside the factory allows for more rapid production, but as different level factories are required to make more advanced commodities and you can only have one factory per-room set to only one level, it is required to send these produced resources down the chain.

### Balancing / Logistics

Once you have factories producing, you generally need some sort of balancing between the rooms doing the production and/or requesting resources as needed for the next production target. This is normally done between terminal structures, but there is no reason a creep could not transport resources beyond considering the distances needed.

## Inter-sharding (when shards exist)

[Intersharding](/Shard) can be a big step in enabling multi-shard buying/selling of resources, and allows for a user's colony to find more rooms available to them if they run into neighbors they can't/do not want to remove.

### Insuring a Memory backup

The first challenge to overcome when intersharding is when a creep moves to a new shard, they only keep their `ticksToLive` and `name` their ID is changed, and their memory is set to blank when they are down traveling to the new shard. They will also emerge out into an area around the portal (meaning you don't choose where they come out, it will be the same room, but its an area). You need to determine a method of getting these creeps memory, either hard-coded based on context of the creep, or more dynamically with inter-shard memory. Important to note as well, that if a creep travels to a shard where there is a creep already with its exact name, the creep will instantly die on reaching the new shard.

### Claiming in range

Much like [claiming](/Claiming_new_room) a room on the same shard, you need to get a creep with claim parts to a controller and have available GCL. Once claimed, you need to send creeps to build a spawn and then get the room up and running.

### Code runs on all shards

The users (your) code will run on every shard you have a owned object on. As such, if you have dependencies in your code that will not be accessible / will cause errors on this new shard, you need to prepare for that. You can use `Game.shard.name` to determine what shard is running the code, and when logging to the console, the console will have a pre-fix of which shard is sending the message.

## Strongholds

A [stronghold](/Invader#strongholds--stronghold-invaders) automatically spawns in a [sector](/Map#sector) in one of the [Source-Keeper rooms](/Map#room) routinely, with lots of loot in the form of resources. Being able to attack and eventually, automatically attack and loot these fortresses is a large task, but if you have some combat code set up already it can be easier.

### Detection

Strongholds will always spawn in a source-keeper room towards the center of a sector, and will have a 'deploying' phase before they are active. They can be detected during this phase so you know when they are arriving to adjust your logic accordingly.

### Attacking

Small strongholds can normally be tanked with boosted creeps and their invaderCore destroyed at-range. Larger strongholds however, require much more coordination between multiple attacking creeps. And while nukes can be effective against these strongholds, they can also destroy the valuable loot inside.

## Better Pathing & Caching Paths

`moveTo()` is a powerful method and with opts provided will work for many if not most circumstances when it comes to getting a creep from point A to point B. However, as you get more creeps, that need do more, the CPU cost of pathing can start adding up fast.

### Optimizing MoveTo

By employing the `opts` available to moveTo you can bring down CPU useage a fair bit, however each has its own advantages and drawbacks.

#### reusePath

The `reusePath` opt enables moveTo to store a found path for however many ticks it is assigned and only re-path to the same goal if that number of ticks have passed. By Default, this is five, however setting this higher means you do not have to have a creep going a further distance repath as often, saving CPU. The downside is this means slower reaction time to obstacles in the path, mainly other creeps. As it does not take into account 'what' is going to be on the path in however many ticks, only that there is nothing there now.

#### ignoreCreeps

The `ignoreCreeps` opt enables moveTo to not consider creeps when forming a path. By default it is false, meaning the creep calling moveTo will attempt to path 'around' creeps as they are in-locations that tick. This can lead to more complex/longer paths than needed as likely these other creeps are moving, and the 'shortest' distance is normally though the other creeps in the way. The drawback however, is that if a creep is not moving along this path, the moveTo will never try to path around it, normally this requires the user making a traffic manager, and/or detection for a creep when it is 'blocked' in its pathing and to resolve the issue.

#### range

The `range` opt enables moveTo to move within a 'range' of the target instead of the target itself. As its 'closer' to the creep, less pathfinding is required and some creep actions do not require the creep to be 'on/at' the target only 'within' a certain range. Similarly, if your traveling to far-off rooms and only need to be 'in' the room, you don't have to path to the 'center' or even the exit, just within a range from the center.

### Using PathFinder.search()

Pathfinder is ultimately what moveTo currently uses to determine pathing, with some opts thrown in depending on what the user decides / what is default. By implementing your own useage of pathFinder, you can be more selective with what and how you want to path.

#### CostMatricies

A [costMatrix](https://docs.screeps.com/api/#PathFinder-CostMatrix) is used by the pathfinder when searching for a path. In essence, each roomPosition/tile is designated a value between 0 and 255 (any greater than 255, is considered 255) where the 'weight' of the path means 0 is most preferred while 255 is 'impassable'. A costmatric generated, if the value(s) are left at 0, the terrain data will set the 'value' of the roomPosition/tile, (by default values, or values specified by you, walls ofc are 255). The pahtfinder will then use this information to find a path to the goal(s) provided. This can be used in many, many ways from avoiding obstacles/damage in a room, or locating the 'best' path though an enemies/your walls, providing a 'possibly pathable' position for multiple creeps/squads and much much more. It is up to the user on how best to deploy and use a costmatrix for their given situation.

### Caching & Reusing paths

Once a path is found, if creeps are reliably going to re-use the path either constantly or to an 'approximate' area, then storing the path and calling it when-needed greatly helps reduce CPU useage as your creeps do not have to constantly re-calculate it. Generally unless you wish to write your own, [moveByPath()](https://docs.screeps.com/api/#Creep.moveByPath) is employed. It can take either an array of [RoomPositions](/Map#roomposition) or a string as formatted by [findPath](https://docs.screeps.com/api/#Room.findPath) or a string that was formatted in the findPath style that is then compressed using [serialize path](https://docs.screeps.com/api/#Room.serializePath). It is important to note, that for using moveTo it MUST be one of these formats, and a valid format. Using an array of objects that contain roomPosition data, but are not roomPositions themselves does not work, and either does a user's custom string compression UNLESS it is converting back to a format that moveByPath understands. It is quite possible to convert roomPositions from pathFinder.search() into the format that findPath uses if desired.

## Automated Room Planning & Building

While not strictly 'necessary', Automatic planning and building of rooms (and subsequently the structures' placements there in aka a 'base' as an overall unit) goes a long way to insuring timely automated continuation of a bot's expansion without needing to await user input. You can read more at the [Automatic Base Building](/Automatic_base_building) article.

### Locating Potential Rooms

The first step is to locate potential bases that your bot will need to evaluate. Most commonly this is done from scouting reports, where scout creeps collect data on various rooms and store them in a scheme that the planner can evaluate. Rating these rooms is largely up to the user's discretion on what is 'important' for their bot, some things to consider are:

- Does the room have two sources?
- What is the Mineral in the room?
- How many sources are 'in range' to [remote harvest](/Remote_Harvesting)?
- Is this room adj or too close to another bot?
- Is this room already reserved and/or claimed?
- Terrain, are there too many swamps? Is there not enough area or open area for my planner to bother looking at?

### Building a Plan / Searching for a Location

Once a room has been chosen as a valid candidate, you need to then execute a planner to see if your desired 'base' can be placed/constructed in the room. Generally this is done a few ways (see more detail in the automatic base building article).

#### Bunker

A pre-determined 'bunker' can be placed in the room provided there is enough space, for bunkers, you only need to know how much 'open area' (non wall terrain) a given roomPosition has around it to confirm the bunker can fit. This is by far the easiest, but can mean that smaller or odd-shaped rooms that would otherwise be acceptable would be discounted from the planning

#### Stamp/Tile

A set of 'tiles' or 'stamps' can be made by the user for the planner to execute, these are normally made up of various groupings of structures such as labs together, towers together, extension field groupings, ect (there are way more and varied examples, but its up to the user how to structure their tiles). This is more difficult than a bunker as the planner needs to take into account not only 'open space' for any given tile/stamp, but its relation to other tile/stamps that have been, or will be placed. It would make little sense, for example, for a lab array tile to be placed on the other side of a massive wall from the main storage tile, even if the planner found valid space for it to occupy there. A user must set their criteria for their planner on what is 'acceptable' distance, placement and positioning of the stamps/tiles.

#### Dynamic Pattern Generation

Another way of placing structures is with more 'dynamic' pattern generation, but which a simple set of rules is given to the planner, such as X structure must have Y open spaces around it and can not be near Z structure or outside of a given area, and then fed the room terrain to try and 'grow' a base. Most commonly used (as far as I know) for extension structures, as they can be 'filled' into an area, without expressly needing to be form fitted as long as they are reachable within a reasonable range and do not block desired routes it matters little unless a user has different plans.

### Caching & Executing the Plan

Once a plan has been created, it needs to be stored (most likely in Memory) for use by a system to execute it. This system needs to do a few things:

- Detect current RCL (Room Control Level) & RCL change in order to know when to place certain buildings
- Know what buildings to place construction sites for and in what order.
- If an exception occurred to attempt to replace the construction site. (EX: A enemy creep stomps & destroys a construction site you own while its building, or a building is destroyed/deleted)
- Prioritize placements or cancel when needed (EX: you can only have 100 construction sites on a shard, if roads that are low-priority are taken up spots for a tower or storage you need to build right now, canceling the roads)

## (Seasonal World) Score/Symbol Gathering & Depositing

Season One required players to gather score from various rooms across the map and deposit it in highways, while Season Two has proposed a similar task with Symbols but depositing these in user-controlled rooms. Similar to how highway-harvesting works, you need to find, then retrieve/transport these resources to their designated deposit site to 'score' for points.

### Locating

In season one, the containers spawned in all rooms at random intervals. Pre-RCL 8, it is easy enough to add these objects to scouting reports to know how much score and how long the object was going to exist.

### Hauling

Once located, large-size haulers can plan routes to gather these resources, and in what priority.

### Scoring

Once 'gathered' by score creep or returned to a user's storage, then score can then be transported to a scoring deposit location to gain points.