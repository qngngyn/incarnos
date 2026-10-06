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

The defender receives a private chat card with **Roll Contest**, shared with the attacker and GMs. The assigned player or a GM can answer by clicking **Roll Contest**. A saving-throw chooser defaults to the requested stat and allows another save to be selected. Closing the chooser leaves the request private and available to answer later. The result uses and labels the selected saving throw. Attack and defender cards identify the attacker vs. defender. A successful defender roll replaces the request on that same card and makes it public; unanswered requests remain private. Repeated clicks do not roll again. **Save: Contest** still rolls a standalone save without prompting another character.

A GM must be online to update requests answered by another player. Reload Foundry on all connected clients after installing this change.
Contest dice use `d(max(2, 20 - stat))`: d2 is the best possible die for attacks and saves, including defender responses.
