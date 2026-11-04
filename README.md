# Incarnos

Incarnos is a system for Pen and Paper: a genre of Tabletop Roleplaying Game (TTRPG).
Incarnos is built in Foundry VTT: a Virtual Table Top (VTT), that is used to play TTRPGs online.

## Full Documentation

Full Documentation will be found in the docs-folder.
The Table of Content is as followed:



# incarnos

## Summoning spells

Effect text `Spawn a/an <creature> at …` summons the matching actor from **Incarnos Monsters**. A tier chooser shows Base and the spell's `Empower:` lines (`- +20 IP: …`), including total IP. Empowered versions use actors named `<Creature> +20 IP`, etc.; missing versions fall back to the base creature with a warning on the card. **Death fire elemental** offers 20/40/60/80 total IP, sizes 1/2/3/4, and 10 turns. Monster notes accept optional `Size: N` (whole squares, default 1); their `Token:` paths are preserved.

An active GM and a caster token on the scene are required. Click to place the grid-snapped square preview; right-click or Esc cancels free of charge. Placement uses the spell's range from the caster token's centre to the preview origin, like placed rectangle spells. Players cannot confirm out-of-range placements; GMs can choose **Place anyway?** The GM validates the hidden request, pays IP (HP for Abomination) and combat AP, reuses/imports the version in the **Summons** world actor folder, adds the caster's player owners, and creates a friendly, unlinked token. The private monster compendium remains GM-only.

In a started combat, the summon joins immediately after its caster at the same initiative. `Duration: N turns` counts down at the end of each caster turn; at zero, its token and combatant disappear and chat announces it fading. Outside combat, remove summons manually. Cards show the version, size, duration and a corpse reminder when appropriate; choosing the corpse remains a table call. Reload every client with **F5** after updating.

## Item passives

Open an item, weapon, talent, or spell and select **Passives**. Click **Add passive**, choose a stat, and enter a signed modifier (for example, Strength +2 or Parry -1). Changes save automatically.

Enabled passives apply while the item is owned by an actor. Multiple items and modifiers stack. Each item applies once regardless of quantity; quantity zero or unchecking **Enable item passives** disables its modifiers. Removing the item removes its bonuses. Existing items need no migration.

Ability modifiers affect saving throws, rolls, and character-derived Health, Incarna, Parry, and Movement. Direct derived-stat modifiers apply after those calculations. Maximum Action Points can also be modified. NPCs retain their manually configured derived stats, with item modifiers added to them. Current Health and Incarna are unchanged.

Actor sheets show one effective value per stat, including item passives. Editing an effective value adjusts the underlying base while keeping item bonuses separate, so removing an item removes only its modifiers. Character ability bonuses now apply before all derived calculations, including saving throws.

Run passive regression checks with `node --test tests/*.test.mjs`.

The actor?s existing **Passive Effects** section lists one row per item, named after that item. Disabled item passives appear under **Inactive Effects**. Hover the row to read its modifiers and descriptions; use its edit icon to open the item. Add optional notes in each passive?s **Description** field on the item?s Passives tab. These entries reflect the items directly and do not apply a second copy of the bonus.

## Talents

Features are now called **Talents** in the interface. Existing feature items continue to work; their internal item type stays `feature` for compatibility.

The talent?s **Attributes** tab contains Passive/Active type, AP cost (active talents), Trigger / Requirement, and Duration. These details save automatically and appear as a compact summary beneath the talent name on character and NPC Profiles. AP spending and activation remain manual; automatic stat modifiers belong in **Passives**. Existing talents default to Passive with empty trigger/duration and zero AP cost.

Each talent has a **Bonus** field (its rules text, shown first on the Profile) above the description, with an **In play:** line saying what is automated:

- **Stat bonuses** — whole lines like `+1 Parry`, `+2 Strength`, `-1 Charisma` or `You gain +2m movement` are imported as **Passives**, so the owner's stats change while the talent is owned. Check bonuses (`+4 in Repairing Checks`) stay text; apply them at the table.
- **Advantage on X/Y Saving Throws** (Cold-Hearted) — those saves roll 2d20 and keep the lower, both from the sheet's Save buttons and when the target saves against a spell. The card shows *Advantage · Cold-Hearted*.
- **Vision up to Xm in Darkness** (Nightvision) — the owner's token gets darkvision X m. Removing the talent restores the token's previous sight.
- **Impressive Spectacle** — a one-handed weapon attack (not used two-handed) whose d20 is at least 10 under the number it needed doubles its damage (gold ×2 chip).

### Talents compendium

The **Incarnos Talents** compendium holds the talents from the Obsidian vault (`System Files/Listen/Talents`, template `TTalents`). Refresh it with the Obsidian **Update Foundry from vault** button, or `npm run import:talents` and `npm run pack:talents` with the world closed. Re-imports keep each talent's ID (it comes from the name). Talents already on characters are copies and don't change on re-import.

Talent and race notes use an `Icon: icons/?` line immediately after `Typ:` in the `ad-check` block to set their Foundry picture. Use a distinct core icon for each talent and each race. Missing or blank icons keep the default talent/race picture; icon metadata stays out of Bonus, passives and description.

## Races

A **Race** is its own item type with the same Bonus field, **In play:** line and Passives tab as a talent. It is listed first under **Race & Talents** on the Profile. An actor has one race: dropping a new race on it replaces the old one. Race Bonus texts use the talent rules above (stat lines become Passives, *Advantage on X Saving Throws* works), plus:

- **+N on X, Y Saving Throws** (Dwarf) — those saves are N higher (shown on the sheet), on the Save buttons and against spells. The card names it, e.g. *+2 · Dwarf*.
- **Nx movementspeed** (Carayalos 1.5×, Centaur 2×, Rambystouma 2×) — Movement is multiplied before flat movement passives. Centaur's action penalty and Rambystouma's difficult terrain stay text.
- **No IP, spells use HP** (Abomination) — Max IP is added to Max HP and IP becomes 0; casting takes the spell's IP cost from HP (the card shows *3 HP*).
- **+1 Stat Bonus** (Harpy) — a +1 passive with no stat; pick the stat once on the race's Passives tab.

Everything else (flying, gliding, shadows, check bonuses, Automata's weapon range) is text to apply at the table.

The **Incarnos Races** compendium holds the races from the vault (`System Files/Listen/Races`, template `TRaces`, `Typ: Race`), refreshed by the same Obsidian button or `npm run import:races` and `npm run pack:races`.

## Defender contest requests

Target one defender token, then roll **Contest** on the attacking character's Profile. The target identifies the defending player; the save uses that player's assigned character in **User Configuration**. Targets without player owners use the targeted NPC. Ambiguous player ownership or a missing assigned character produces a warning.

The assigned defender receives an automatic popup with a saving-throw chooser. For NPCs, one active GM receives the popup. The chooser defaults to the requested stat and allows another save to be selected. Pending requests are stored as hidden private chat documents; successful rolls make the result public. Closing the chooser leaves the request pending, but reconnecting or reloading does not reopen historical requests. Only new contest requests open popups automatically. The result uses and labels the selected saving throw. Attack and defender cards identify the attacker vs. defender. A successful defender roll replaces the request on that same card and makes it public; unanswered requests remain private. Repeated clicks do not roll again. **Save: Contest** still rolls a standalone save without prompting another character.

A GM must be online to update requests answered by another player. Reload Foundry on all connected clients after installing this change.
Contest dice use `d(max(2, 20 - stat))`: d2 is the best possible die for attacks and saves, including defender responses.

When both contestants roll the same total, the active GM posts **TIE!** in a separate public chat message and sends new popup requests to both contestants. Attack rerolls use ability values; defender rerolls use saves. After the dice animations finish (when Dice So Nice is available), each reroll popup has only a **Roll!** button and reuses the contestant's previous stat. Repeated ties start another round, and the original results remain in chat.

The initial attack stat chooser uses **Roll!** and immediately rolls; there is no additional Ready to roll confirmation.

Completed contests announce the winner in a separate public chat message after the dice animations finish. The original roll cards retain their roll results. The lower total wins. Attacker names and victories are red; defender names and victories are green. Ties keep their reroll flow.

Contest windows are queued per client, including attack choosers, defender prompts, and tie rerolls. A new request waits for the current window to finish. Each dialog has its own ID; queued requests already completed elsewhere are skipped. Closing or failing a dialog releases the queue for the next request.

Contest result messages are authored by the actual roller, preserving Dice So Nice player appearance and visibility preferences. The original requester is stored separately for permission checks.

## Combat action buttons

Character and NPC **Profile** tabs have an **Actions** block beside the generic Contest controls. **Contest** offers Shove, Grapple, Escape, Find, Intimidate, Taunt and Scale; **Misc** offers Dodge, Hinder, Hide and Insight. Hover a button for its action-list Play Cheat and AP cost. Each action automatically spends **1 AP** when the acting character or NPC participates in a started combat. Reload every connected client with **F5** after installing.

Target exactly one defender for a contest action. The attacker stat is preset (Scale asks for Speed or Dexterity); the defender chooses only an allowed save, with the first preselected. The shared contest board names the action, retains it through tie rerolls, and reports the effect applied once by the elected active GM. Defender wins apply nothing. Shove lets the attacker's owner or GM choose **Knock Prone** or **Pushed 2 m**; move pushed tokens by hand. Scale's size restriction stays manual. Intimidate and Taunt end at the end of the target's next turn; HUD-applied conditions remain untimed. An active GM is required for contest actions and Hinder.

**Dodge** adds a visible temporary effect: +1 Parry advantage, combined with Hidden and Prone, consumed by the next Parry or removed at the start of your next turn. **Hinder** asks the GM to put Hindered on the targeted token; its next attack consumes it. **Hide** rolls under Dexterity and grants Hidden on success. **Insight** requires a targeted enemy and rolls under Intelligence plus `4 − 2 × enemy level` (level 1: +2, level 6: −8, continuing above 6); a success offers the GM-information prompt. Hide and Insight use the usual natural-1 success/natural-20 failure rules. Sight, source-specific condition restrictions and narrative choices remain GM calls.

## Actions on tokens

Actions belong to the system and are implemented in `module/helpers/action-tracker.mjs`, using the existing `system.actionpoints` resource. New actors start with 3 actions. On loading the world as GM, the former 4-action default is converted to 3 for existing characters/NPCs, including unlinked tokens. Custom pools such as 6 and 9 are preserved. Item passives modifying maximum actions continue to apply.

Green segments above visible tokens show remaining actions, in rows of three. Spent actions are dark. The action UI is shown only during a started, active combat and only for its participants. Participating owned characters show their segments continuously; other participants show them on hover. GMs see all visible tokens. Health and Incarna bars are unaffected. Pools above 9 use a numeric counter.

**Automatic AP spending:** weapon attacks (all modes, including Weave and NPC attacks), the acting side of generic **Contest**, and Shove, Grapple, Escape Grapple, Find, Intimidate, Taunt, Scale, Dodge, Hinder, Hide and Combat Insight each spend **1 AP**. Cleave spends once for the whole attack action, regardless of target count. Spells spend their configured AP cost once per cast. AP is charged only when the actor participates in any started combat; outside combat these actions cost no AP. Attacks pay after the attack dialog is confirmed, immediately before rolling; other actions pay when they start, after required target/stat choices. Weapon and spell cards show the AP actually paid.

**Free rolls and manual spending:** defender contest saves, standalone Save: Contest, tie rerolls, Parry and plain sheet ability checks/saves spend no AP. Movement and other activities without automated buttons still use the manual controls. Cancelling an attack/stat dialog before starting spends nothing; cancelling a started contest does not refund AP. Use the token or sheet **−/+** controls to correct the balance, or reset to the maximum.

Players with too few AP receive a warning and cannot start the action. GMs instead get **Use anyway?**; accepting spends any remaining AP down to zero and proceeds. Automatic payments, manual corrections and turn resets share a write queue so rapid clicks cannot overwrite each other.

Right-click an owned token to use the Actions controls (spend, restore, reset), or use the same controls on its sheet. Advancing combat refills the actor whose turn ended, including the round wrap; rewinding and initial combat start do not refill actors. A GM processes replenishment once, with an online owner of the outgoing actor as fallback when no GM is online. Replenishment uses the committed combatTurnChange event and its previous/current state, so forward turns, round wraps, solo encounters and direct turn updates work without preliminary hook metadata. Duplicate notifications cannot reset actions spent after replenishment. Token HUD and sheet action controls also hide outside combat. Unlinked NPC tokens keep separate resources.

Reload all Foundry clients after updating the system.

## Chat cards

Every roll posts the same kind of card: spells, weapon attacks, other items, stat checks, saves, Parry and contests. A header (item icon or a symbol, name, a small subtitle and a blue chip such as the cost, attack stat, `≤ 12` or the contest die), an optional facts line, then one row per roller or target with a coloured outcome chip and a big number. Chips show *rolled/needed* (e.g. `Hit 7/11`); hover a chip for the full explanation. Results stay hidden behind *Rolling…* until the dice animation (Dice So Nice) finishes.

- **Weapon attacks** — subtitle shows the attack action and mode, the chip the attack stat, the facts line the weapon modifier and advantage. Each attack roll is one row with Hit/Miss (the needed number already includes the attack modifier you entered) and the damage. Target tokens before rolling (one per attack roll) to name the rows and get the GM's **Apply** buttons.
- **Stat checks and saves** — Success/Fail against the value; the d20 is the big number.
- **Parry** — shows the roll against your Parry with a reminder to apply the attack modifier the GM announces (it isn't known to the sheet).
- **Contests** — one card per round shows both sides and updates in place: *Waiting* → *Rolling…* → total, then **Winner** / **Lost** (hover the header or chips for the rule: d(20 − stat), lower total wins). A tie marks the card **Tie!** and a new card, *Round 2*, opens for the reroll.
  - **Disconnects:** a side that hasn't rolled shows a **Roll** button on the card for its owner (or the GM), so a player who dropped out or closed the popup can continue there. Popups don't reopen on reload. The GM has **Cancel contest** to end a stuck contest; late responses are then rejected. When a GM reconnects, responses and results left unprocessed in the last 12 hours are finished automatically. Player responses still need a GM online, as before.
  - Only one client writes each card (the active GM, or the card's author when no GM is online), from the current data, so simultaneous updates can't overwrite each other.

### Critical failures

On a natural 20 weapon or spell attack, the card offers a small **Critical failure** button. It never rolls automatically. You can also import **Critical Failure** from **Incarnos Macros** to your hotbar, or call `game.incarnos.criticalFailure({ kind: "weapon", actor })` (`"spell"` for spell attacks). The dialog uses the selected token's actor, or offers owned player characters, and lets you choose Weapon attack or Spell attack. Attack-card buttons preset the attacking actor and kind; Weave uses Spell.

When a GM confirms for an actor with an online player owner, that player receives a whispered **Roll severity** card and a dialog. The actor's assigned player is preferred; otherwise the first online non-GM owner by user ID is chosen. Closing the dialog leaves the whisper button usable, including after F5. The player rolls the d10 and posts the public severity card; the first active GM marks the whisper **Rolled**, including after a GM reload. Existing severity cards prevent the same prompt from rolling again. Players starting their own critical failure, and GMs without an online player owner, roll directly.

The visible d10 gives 1–6 **Small mishap (60 %)**, 7–9 **It hurts (30 %)**, 10 **Disaster (10 %)**, each in its own colour. The actor's owners or a GM may click **Roll on the table**. The matching Weapon/Spell table result appears on that same card and the button is disabled. State is saved on the message, including a reservation before the draw, so reloads and simultaneous clicks cannot draw twice. The first active GM validates player requests and writes the result; without a GM, the card's author can resolve their own card. Effects are descriptive for the table to apply manually.

The six RollTables in **Incarnos Critical Failures** come from the vault note `Critical Failures.md` (found by name anywhere in `System Files/`, currently `System Files/Listen/Tables/`). Add any number of rows (Name | Weapon attack | Spell attack); `Same.` copies the weapon text. Each row is equally likely within its table (`1dN`, with replacement); severity always remains 60/30/10. **Update Foundry from vault** rebuilds these tables and the macro with stable IDs from names. GM reload sync also updates embedded results. Backups include both packs under `foundry/packs-source/critical-failures` and `macros`.

**The first installation of these new packs in system.json requires a world relaunch, not just F5.** Later content updates use GM F5 as usual. Reload all clients after installing the code.

## Imported map scale

As GM, open the **Scenes** sidebar, right-click an imported scene, and choose **Convert to Incarnos scale**. Review the preview and click **Convert scene**. The tool converts standard 5-foot scenes to gridless, 1.5 m while keeping the imported pixel grid size. Distances use the game convention of 5 feet = 1.5 m (factor 0.3), preserving their radius on the map.

Core ambient light and sound ranges, token light/sight/detection ranges, measured template distances where supported, and core object/level/region elevations convert together. Pixel positions, wall coordinates, region shapes, images, and token sizes remain unchanged. Module-specific effect data and actor prototype tokens remain unchanged. A scene already using 1.5 m only switches to gridless. Other scales are rejected instead of guessed.

Conversion requires confirmation and marks the scene to prevent repeat conversion. Cancel leaves the scene unchanged. The tool never runs automatically during import. Run its checks with `node --test tests/scene-scale.test.mjs`.

## Weapons compendium

The **Incarnos Weapons** compendium holds the 30 weapons from the Obsidian vault (`System Files/Listen/Weapons`, with trait texts from `Listen/Weapon Traits`), in a Melee and a Ranged folder, plus a **Legendary** folder with the unique weapons from `Welten/Incarnos/Custom Items/Weapons` (not on the Google Sheet; a note that only repeats a regular weapon's name is skipped). Legendary notes may list traits as `- Name: text` bullets below `Traits:`, write a bare range (`Reichweite: 18m` = ranged), put conditional damage after the roll (`2d8 + 1d8 vs Undead` → damage 2d8 and a *Bonus Damage* trait line), set a picture with `Icon: tokens/items/<name>.webp` (a path in Foundry's data folder, never committed) and fill the Beschreibung block, which becomes the description. Each weapon has Attack Mode, Hitrate, Damage, Hands, Range (ranged weapons, or Reach for melee) and its Traits, one per line with the text of its trait note. Drag a weapon onto a character and click its icon to attack.

Traits are read live from the Traits field (the weapon sheet shows an **In attacks:** line with what was read):

- **Finesse** — melee attacks use the better of Str and Dex.
- **Throwable Xm** — the weapon can also attack as ranged (choose *Ranged* in the attack dialog).
- **Critical Strike a–b** — crits on that range instead of only a natural 1 (shown as a gold *Hit · crit* chip).
- **Every critical hit** (weapon attacks, monster attacks and spell attacks) maxes the damage dice, after Deadly/Fatal have changed them. The weapon card marks it *crit, max dice*; on a spell card the crit target gets a *Max dmg* chip and its own "Crit damage (dice maxed)" line.
- **Deadly Dx** — a crit adds 1dx damage. **Fatal Dx** — a crit uses dx as the damage die.
- **Two-Hand Dx** — the attack dialog offers *Two-handed*: −2 hitrate and dx damage.
- **Poor Precision** — hits when the attack roll fails and misses when it succeeds.
- **Sweep** — Attack: Cleave deals full damage.
- **Parry +N** — imported as an item passive, so the owner's Parry rises while the weapon's passives are on.

Other traits (Agile, Reach, Trip, Disarm, Forceful, Spikey, Barbed, Consuming, …) depend on the situation and are listed under **Traits** on the attack card. A weapon without damage (Shield, Grease cannon) posts its card without an attack.

To refresh: close the world, run `npm run import:weapons` (reads the vault notes, never changes them) and `npm run pack:weapons` — or use the Obsidian button below.

### Update Foundry from Obsidian

`npm run sync:vault` re-imports every vault-sourced compendium (Weapons, Talents, Races, Spells, Monsters, Critical Failures, plus the Macros pack) and rebuilds only the packs that changed. The **Incarnos Foundry Sync** Obsidian plugin (`tools/obsidian-plugin`, installed by copying `main.js` and `manifest.json` to `<vault>/.obsidian/plugins/incarnos-foundry-sync/`) runs it from a ribbon button (circular arrows) or the command *Update Foundry from vault*. **The world can stay open:** if Foundry holds a pack's database lock, the source JSON is still updated and the button reports success with a reminder to reload Foundry (F5) as the GM. Genuine import/build failures still report an error. The plugin's settings hold the system folder and the path to `node.exe`. In a weapon note, a trailing `(…)` after a trait fills the trait note's placeholder or replaces its text, e.g. `[[Consuming]] (1x Bullet)` or `[[Parry]] (+1 Parry)`. Re-imports keep each weapon's ID (it comes from the name).

On world launch or reload, the first active GM (lowest user ID) reads each system pack's source JSON and updates its compendium through Foundry's live document API. Changed entries and folders update in place, missing entries are created with their original IDs, and entries removed from the source are deleted. Monster attacks and talents are synced as embedded items too; RollTable results and system Macros also sync. Pack locks are temporarily lifted and restored. One notification summarizes changed documents and folders; an unchanged reload makes no writes or notification. Linked weapons, talents, races and spells sync **after** this step in the same ready pass (see below). Monster actors remain copies. Reload all connected clients with F5 after installing system code changes.

### Items synced by compendium ID

Weapons, talents (internal type `feature`), races and spells on world actors, unlinked token actors and in the world Items directory follow their matching Incarnos compendium entry. After **Update Foundry from vault**, reload as the first active GM (F5) to receive changes without dragging items onto characters again. Writes are batched per actor and one item-sync notification summarizes updated items and customized copies left alone; unchanged reloads stay silent.

Foundry's `_stats.compendiumSource` links dropped items by ID, so later changes to the compendium entry's name still reach linked copies. Old items without a link match by type and name, plus element for spells, in the matching system pack; this stores `flags.incarnos.sourceUuid` for future runs. Ambiguous names and missing linked IDs are left alone. The vault importers currently derive IDs from names (element + name for spells): renaming a vault note can create a **new ID**, which does not relink existing copies automatically.

Each linked copy records a content fingerprint in `flags.incarnos.syncHash`. Changes to name, image or rules content mark it **Customized – not synced** (`flags.incarnos.customized`); it then stays opted out, even if its text later happens to match again. The item sheet shows the status and a **Reset to compendium** button for the GM or an owner. Confirming replaces the content, clears customization and resumes syncing. A pencil beside customized weapons, spells, talents and races on actor sheets opens no dialog; its tooltip identifies the status. Fresh compendium drops receive a baseline immediately; manual edits update the status without waiting for a GM reload.

Play state is excluded from the fingerprint and preserved on sync and reset. The complete policy is `ITEM_SYNC_PLAY_STATE` in `module/helpers/item-sync.mjs`: system `quantity`, `weight`, `passivesEnabled`, `equipped`, `prepared`, `attuned`, `identified`, `uses`, `charges`; document `sort`, `folder`, `ownership`, unrelated flags, effects and metadata also stay with the character. `attackMode`, `versatile`, damage, traits, passives, bonuses and all spell rules are content; editing these opts the item out.

On the first run, copies without a baseline that already match the compendium simply gain one. Differing old spells receive one final refresh because earlier versions always force-refreshed spells. Differing old weapons, talents and races are conservatively marked customized and left intact; one GM-only whisper lists them with instructions to use **Reset to compendium**. Subsequent runs do not repeat that list. Tests: `npm test` (including `tests/item-sync.test.mjs`).

The update also checks the full-path links (`[[Folder/Note]]`) in the vault's `CLAUDE.md` and shows a warning for every one that no longer exists, so a moved or renamed key note gets noticed.

### Conditions

The token HUD's status effects are the Incarnos conditions from the vault (`System Files/Listen/Conditions`, one note per condition, `Name: effect`), Foundry's default list is replaced. The HUD shows the Incarnos conditions first (alphabetically), then *Defeated* (for the combat tracker) and three spare statuses *Custom 1–3* for conditions that don't exist yet (rename the effect on the actor when you use one). When the world first starts with this version, the GM's client removes leftover status effects from Foundry's old list (Stunned, Burning, …) from all actors and unlinked tokens, once; other active effects stay. Each condition has a core icon (Prone: falling, Grappled: net, Hidden: invisible, Hindered: downgrade, Intimidated: terror, Taunted: target, Asleep: sleep, Mounted: pawprint, Burn: fire, Poisoned: poison, Bleed: blood); a line `Icon: icons/svg/…` in the note picks another. The Obsidian button imports the notes into `module/data/conditions.mjs`; reload Foundry (F5) afterwards.

- **Burn, Poisoned, Bleed, Asleep, Regenerating** count tokens; **Immobilized** optionally counts turns. The tokens are the stack counter of the **Status Icon Counters** module (`statuscounter`): left click on the status in the token HUD adds a token, right click removes one, and the number shows on the token's icon. No dialog opens for any status. Without the module the system stores token counts on the effect; a status without a stored count defaults to 1.
- **Start of turn** (in combat): token conditions count down, and what they do to HP comes as a **private chat prompt** (only the actor's owners and the GMs see it) with a description and an Apply button per line: Burn, Poisoned and Bleed deal 1 damage per token; **Regenerating** heals the amount its source fixed (Leaf wind: 1d6 + the caster's level), or 1d6 + the actor's own level when it was set by hand in the token HUD. The owner applies it themselves; nothing changes HP until someone clicks. The same prompt lists every other active condition with its token count and short description, so the start-of-turn effects are in one place. Elites and bosses with several combatants tick on each of their turns.
- **Applying results yourself:** on spell and attack cards, a target's owner can click Apply on their own line (damage or healing); the GM can still apply any line or all of them. Each line is applied once, whoever clicks first.
- **Asleep:** every action point the creature spends removes 1 sleep token; **damage** halves them (min. 2). **Healing** removes Bleed.
- **Hidden:** advantage on weapon and spell attacks and on Parry. **Hindered:** the attack dialog preselects disadvantage, and Hindered ends after the attack (also after a spell attack). **Prone:** a Parry roll shows both cases at once, *vs melee* (disadvantage) and *vs ranged* (advantage), without asking. The cards name the source, e.g. *Disadvantage · Hindered*.
- **Grappled:** players can't move the token; the GM can.
- **Immobilized** (net icon): no movement actions (Dash, Crawl, Disengage, etc.); players can't move the token, while the GM can. Spend **1 AP** to break free; some sources require a roll first (Crystal Trap). Handle that action/roll and remove the condition when successful. A spell or attack with a duration sets `flags.incarnos.timed = true` on the effect: remove **1 token at the end of each of that combatant's turns**, and remove the condition at 0. Only that actor's single writer does this (first active GM, otherwise an active owner). A hand-applied Immobilized stays until removed, even if its HUD counter shows 1 or is increased by hand; a counter alone never starts a countdown. Timed sources add their turns together. An indefinite source or an existing hand-applied effect keeps Immobilized indefinite when sources overlap.
- **Immobilized sources:** an attack trait `Immobilized` is indefinite; `Immobilized 2` supplies two timed turns. Spells read an explicit `Immobilized N` first, then `Duration: N turns`, otherwise apply it indefinitely. **Ivy vines** applies two timed tokens on a hit. **Crystal Trap** applies indefinite Immobilized only on a hit with a failed Strength save (+2 as written for players). The start-of-turn prompt lists Immobilized as a reminder, without consuming its turns.
- **Conditions from attacks:** a weapon trait line that is only a condition (`Burn D4`, `Poisoned d4`, `Prone`) is applied on a hit. The tokens are rolled with the attack and shown as a chip (*Burn 3*); the GM's **Apply** puts the damage and then the condition on the target. In a monster note, write it in the attack line: `Bite: Melee -1 1d6, Poisoned D4`. Trait lines with a description (`Name: text`) never apply a condition.
- **Spells on actors stay current:** after syncing the compendiums from vault source JSON, the first active GM updates linked, unmodified copies by ID, preserving play state. Customized spells stay opted out until **Reset to compendium** is confirmed on their item sheet (see Items synced by compendium ID above).
- **Conditions from spells:** clear effect lines in a spell put their condition on the targets: "Target is knocked prone (none when save succeeded)", "making them fall prone", "Apply 4d4 + (lvl * 2) sleep tokens", "Burn D4", "Target gains Regenerating 2: heals 1d6 + (lvl * 1) at the beginning of the target's turn" (2 turns; the healing is fixed with the caster's level). They need a hit and, when the line says so, a failed save; tokens are rolled per target and listed on the card (e.g. *Asleep tokens 11 + 2 = 13*). Once the dice have landed, the GM's client puts the conditions on the targets automatically; damage still waits for **Apply**, and the damage of the spell that just put a target to sleep doesn't halve those sleep tokens. Conditional lines ("If …", "On beginning of …", "After 1 turn …") and effects the parsers cannot resolve stay as text. Cast choices are resolved first; clear conditions in the chosen effect then use the same automation. The spell sheet's *In play* line lists the conditions.
- Intimidated, Taunted and Mounted show their text but aren't automated, since they depend on the other creature.

### Monsters compendium

The **Incarnos Monsters** compendium (GM only) holds an NPC for every monster note in the vault's `Welten/Incarnos/Custom Monsters/<Type>/` (template `TMonster`), one folder per type. HP, Parry, Speed (squares, or the metres in brackets), Level and the stat table become the NPC's values. Attack lines `Name: Melee|Ranged [(range)] <modifier> <damage>[, traits]` become weapons: the modifier is written for the heroes (`Melee -2` = heroes parry at −2) and stored as the weapon's *Modifier (for heroes)*; when the monster rolls the attack itself it uses the opposite sign, `[[Reach]] (3m)` and other trait links get their trait text. Traits, Actions and attacks that are not a plain weapon roll (cones, saves) become talents named *Traits*, *Actions* and *Special Attacks*. Element, Weakness and the description go to the Notes tab. A `Token:` line (a path in Foundry's data folder, e.g. `tokens/monsters/lashtail-panther.webp`) sets the portrait and token image. Notes without HP or a stat table are skipped and listed when you press the button. See the vault note *Monster Balancing* for benchmarks per level.

### Incarnos Handbook journal

**Update Foundry from vault** also builds the **Incarnos Handbook** journal compendium from the vault's `System Files` pages, after importing items so weapon, talent, race and spell links open the current compendium entries. One journal contains the handbook, rules, list overviews, Recruit/Veteran action lists and Critical Failures, with a nested sidebar. Page order and nesting live in `tools/handbook-pages.mjs`; missing notes are skipped with a warning. Markdown tables and callouts are preserved, condition/weapon-trait lists show their rules inline, and callouts titled **GM only** become Foundry secrets hidden from players.

Relaunch the world once to register the new pack. Later vault edits arrive when the first active GM reloads Foundry (F5), like item changes. Open the journal from the compendium to read the latest version; an independently imported world copy is not refreshed. For a manual build, run `node tools/import-handbook.mjs` after the item importers, then `node tools/pack.mjs handbook`. Vault notes are only read.

### Backups

Every update (also when a pack was locked) saves a backup to the plugin's **Backup folder** (default `C:\Users\mfgan\IncarnosBackups`, outside the vault and this repo so nothing is pushed to GitHub; `$INCARNOS_BACKUP_DIR` for `npm run sync:vault`). Each backup is a folder named by date and time with a text copy of the whole vault (without `.git`, `.obsidian`, `.trash`), the compendium sources (`packs/_source`, including the six Critical Failure tables with embedded results and the Critical Failure macro), the token images (`<Data>/tokens`), `Incarnos Lists.xlsx` (weapons, weapon traits, talents, races, spells, monsters) and a `README.txt` on how to restore. Afterwards old backups are deleted so 3–4 remain: the 2 newest, one at least a week old and one 30–60 days old (the oldest backup under 30 days is kept so it can grow into the month slot). `node tools/backup.mjs` makes a backup on its own.

## Spells compendium

The **Incarnos Spells** compendium holds every spell from the Obsidian vault (`System Files/Listen/Spells`, one folder per element, template `TSpells`), one compendium folder per element. Each element folder has an `<Element>.md` note (`Typ: Element`) whose Affinity becomes the compendium folder's description. A new spell from the template can stay in `Spells/` itself; its `Element:` field decides its folder in Foundry. Refresh with the Obsidian button, or `npm run import:spells` and `npm run pack:spells` with the world closed. Re-imports keep each spell's ID (it comes from element + name). Drag spells onto a character or NPC; they appear on the restored **Spells** tab, grouped by element, with cost, range, target, check and duration on one line.

Each spell note has an `Icon: icons/…` line directly after `Element:` in its `ad-check` block. This path supplies the spell’s picture in Foundry; choose a different core icon for every spell within an element. A missing or blank Icon uses the element’s default picture. Icon paths stay out of the rules and card text.

Incarna (IP, Incarna Points) retains the internal actor resource `system.power.value/max` and spell cost `system.mp`, so existing worlds need no migration. Cost parsing also accepts legacy MP/PP text; spell overviews display those units as IP.

Spell sheets open on **Spell**, with a prominent **Effect** rules textarea above Element, Category, Cost (as written in the note), Actions, Action Type (Action/Reaction), IP, Range, Target, Check, Duration and Spell Level, followed by the **When cast:** automation summary. **Flavour** holds the description editor; **Passives** is unchanged. Hover a spell's name or summary on the actor's Spells tab to read its effect. Variable costs ("X Actions", "X * 8 IP", "3 IP times 4d4") store 0 in Actions/IP; the Cost text is what the spell list and chat card show, so edit it too when changing a spell's cost.

### Casting spells

Spells with cast choices first open **Choose how to cast <spell>** on every cast. Each choice shows its range, target, check, duration and rules; closing this dialog or cancelling area placement spends no IP/AP. Choices share the spell's cost and inherit its fields unless their card block overrides them. The chosen name and effect appear on the chat card. The spell sheet lists the options as separate blocks and in **When cast:**; expand **Edit option text** to edit the original rules.

Supported card layouts include named range/target blocks (Crystal Shower, Darkness Manifestation), inline `Name: effect` choices (Shadow Play), unnamed area/save blocks (Transmuting Strike) and duration/body-part blocks (Meat Augmentation). Crystal Shower's Needles places a 4.5 m square; Darkness Manifestation has caster-line, placed 12 m transverse line and single-target forms. Transmuting Strike uses each option's 3 m circle and Constitution/Willpower save. Shadow Play uses Perception saves, with 4d4 fire damage only for Flower Bouquet. Unparsed effects remain visible rules: difficult terrain, source-dependent buffs/conditions, beginning-of-turn effects and Meat Augmentation's upkeep saves. Extra arms' inner **OR** stays text, and Chaotic Fleshball stays inside Pulsating ulcer. Greatsword of Death's per-attack shapes and Discharge's hit-quality tiers do not open a cast-choice dialog.

Clicking a spell's icon casts it:

1. **Cost** — IP is deducted; AP only while the caster is in a started combat. Casting stops with a warning if IP runs short or a player has too few AP; a GM can confirm **Use anyway?** for an AP shortfall. Variable costs open a small dialog to enter the actual Actions and IP.
2. **Targets** — area spells let you place the area on the scene (left-click places, right-click cancels). Areas *from the caster* stay on the caster's token, and lines turn toward the mouse. Every token whose centre is inside is affected; the caster is left out unless the spell only heals or uses a placed rectangle. The area stays on the scene as a Region (delete it when the effect ends). Other spells use your targeted tokens; *Self* spells and pure heals fall back to the caster.
3. **Rolls** — per target: the spell attack is a d20 under the caster's stat + (10 − target's Parry) + attack modifier; the target save is a d20 under the target's save value + save modifier. Nat 1 always succeeds, nat 20 always fails. Damage and healing are rolled once (`@lvl` is the caster's level) and halved or dropped for targets that saved, as the spell says.
4. **Chat card** — header with the spell's icon, element · category and the cost paid; one line with range · target · check · duration; an always-visible **Effect** block; then one row per target with its portrait, an outcome chip (Hit / Miss / Saved / Failed save, gold on a nat 1, with rolled/needed numbers — hover for the full explanation) and the damage or healing as a big number with an element icon. The GM gets a small **Apply** button per row (it turns into a green check once applied) and **Apply all** when several targets are affected; players see the results only. The damage roll is a small line underneath. Optional flavour appears in muted italics under **Flavour**, closed by default even for spells with nothing to roll; spells without a description have no flavour fold. HP stays between its minimum and maximum.

**Rectangle areas:** `Range: 12m (3m x 1,5m)` (also `12 m (3 m x 1.5 m)`) lets the caster place a **3 m × 1.5 m rectangle** with its origin within **12 m** of their token. Move it with the mouse, rotate with the mouse wheel, and left-click to confirm; right-click cancels without paying the cost. Everyone whose token centre is inside is a target, including the caster if inside. The spell sheet's **When cast:** line shows `Rectangle 3 m × 1.5 m (placed)`. Like the existing circles and caster lines, this uses Foundry v14's Region placement API (a rectangular `line` shape, equivalent to the former MeasuredTemplate `ray`); players can use the preview even when they cannot save a Region. With no caster token on the scene, placement remains available but range is checked manually.

An attack count after the spell's attack stat (`Attack Int / Cha (3x)`, `(3 x)` or `3x`) rolls that many attacks against each target's Parry. Each hit rolls its own damage; a natural 1 maximises only that hit's dice. The card lists each attack's roll, hit or miss and damage, then a total per target; **Apply** applies that total. Conditions apply once per target if any attack hits, and IP/AP are paid once per cast. The sheet's **In play** line shows the count as `×3`. Without a count, spells keep their usual single attack and shared damage roll.

Every cast reads its automation **live from the spell's own fields** (Check, Range, Target, Effect), so editing the text changes what the spell does and spells already on actors work without any setup. It recognises clear patterns; conditional, tiered and buff effects post their card without rolls. The Spell tab shows a **When cast:** line with what was read — to change what a spell rolls, edit its text.

To refresh the compendium after editing spell notes in the vault, use **Update Foundry from vault**, then reload Foundry (F5) as the first active GM. For a manual offline rebuild:

1. Close the world in Foundry (an open pack is locked).
2. `npm run import:spells` — reads the vault spell notes and writes `packs/_source/spells/<element>.json`. Notes it can't read are listed as warnings.
3. `npm run pack:spells` — rebuilds `packs/spells` with the LevelDB module bundled with Foundry (`FOUNDRY_APP` overrides the default install path `D:/Programme/Foundry Virtual Tabletop/resources/app`).

Re-imports keep each spell's ID (it comes from element + name, so adding cards doesn't shift others; renaming a spell gives it a new ID), so actors' copies of a spell can be compared with the compendium version. The compiled `packs/spells` folder is not committed; `packs/_source` is. Run the checks with `node --test tests/spell-sheet.test.mjs tests/spells.test.mjs`.
