# Incarnos

Incarnos is a system for Pen and Paper: a genre of Tabletop Roleplaying Game (TTRPG).
Incarnos is built in Foundry VTT: a Virtual Table Top (VTT), that is used to play TTRPGs online.

## Full Documentation

Full Documentation will be found in the docs-folder.
The Table of Content is as followed:



# incarnos

## Item passives

Open an item, weapon, talent, or spell and select **Passives**. Click **Add passive**, choose a stat, and enter a signed modifier (for example, Strength +2 or Parry -1). Changes save automatically.

Enabled passives apply while the item is owned by an actor. Multiple items and modifiers stack. Each item applies once regardless of quantity; quantity zero or unchecking **Enable item passives** disables its modifiers. Removing the item removes its bonuses. Existing items need no migration.

Ability modifiers affect saving throws, rolls, and character-derived Health, Power, Parry, and Movement. Direct derived-stat modifiers apply after those calculations. Maximum Action Points can also be modified. NPCs retain their manually configured derived stats, with item modifiers added to them. Current Health and Power are unchanged.

Actor sheets show one effective value per stat, including item passives. Editing an effective value adjusts the underlying base while keeping item bonuses separate, so removing an item removes only its modifiers. Character ability bonuses now apply before all derived calculations, including saving throws.

Run passive regression checks with `node --test tests/*.test.mjs`.

The actor?s existing **Passive Effects** section lists one row per item, named after that item. Disabled item passives appear under **Inactive Effects**. Hover the row to read its modifiers and descriptions; use its edit icon to open the item. Add optional notes in each passive?s **Description** field on the item?s Passives tab. These entries reflect the items directly and do not apply a second copy of the bonus.

## Talents

Features are now called **Talents** in the interface. Existing feature items continue to work; their internal item type stays `feature` for compatibility.

The talent?s **Attributes** tab contains Passive/Active type, AP cost (active talents), Trigger / Requirement, and Duration. These details save automatically and appear as a compact summary beneath the talent name on character and NPC Profiles. AP spending and activation remain manual; automatic stat modifiers belong in **Passives**. Existing talents default to Passive with empty trigger/duration and zero AP cost.

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

## Actions on tokens

Actions belong to the system and are implemented in `module/helpers/action-tracker.mjs`, using the existing `system.actionpoints` resource. New actors start with 3 actions. On loading the world as GM, the former 4-action default is converted to 3 for existing characters/NPCs, including unlinked tokens. Custom pools such as 6 and 9 are preserved. Item passives modifying maximum actions continue to apply.

Green segments above visible tokens show remaining actions, in rows of three. Spent actions are dark. The action UI is shown only during a started, active combat and only for its participants. Participating owned characters show their segments continuously; other participants show them on hover. GMs see all visible tokens. Health and Power bars are unaffected. Pools above 9 use a numeric counter.

Right-click an owned token to use the Actions controls (spend, restore, reset), or use the same controls on its sheet. Spending is manual, so no action cost is assumed for contests, movement or attacks. Advancing combat refills the actor whose turn ended, including the round wrap; rewinding and initial combat start do not refill actors. A GM processes replenishment once, with an online owner of the outgoing actor as fallback when no GM is online. Replenishment uses the committed combatTurnChange event and its previous/current state, so forward turns, round wraps, solo encounters and direct turn updates work without preliminary hook metadata. Duplicate notifications cannot reset actions spent after replenishment. Token HUD and sheet action controls also hide outside combat. Unlinked NPC tokens keep separate resources.

Reload all Foundry clients after updating the system.

## Imported map scale

As GM, open the **Scenes** sidebar, right-click an imported scene, and choose **Convert to Incarnos scale**. Review the preview and click **Convert scene**. The tool converts standard 5-foot scenes to gridless, 1.5 m while keeping the imported pixel grid size. Distances use the game convention of 5 feet = 1.5 m (factor 0.3), preserving their radius on the map.

Core ambient light and sound ranges, token light/sight/detection ranges, measured template distances where supported, and core object/level/region elevations convert together. Pixel positions, wall coordinates, region shapes, images, and token sizes remain unchanged. Module-specific effect data and actor prototype tokens remain unchanged. A scene already using 1.5 m only switches to gridless. Other scales are rejected instead of guessed.

Conversion requires confirmation and marks the scene to prevent repeat conversion. Cancel leaves the scene unchanged. The tool never runs automatically during import. Run its checks with `node --test tests/scene-scale.test.mjs`.
