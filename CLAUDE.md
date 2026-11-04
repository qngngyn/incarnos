# Incarnos — Foundry VTT system

Homebrew TTRPG system by hyuroki. This folder is the **live install** Foundry loads
(`C:\Redo\Data\systems\incarnos`, remote `github.com/hyuroki/incarnos`). Rules, lore and design
notes live in the Obsidian vault at `C:\Users\mfgan\IncarnosPnp` (see its `CLAUDE.md`); the
current action list is `System Files/Listen/Actionlists/Incarnos_Actionlist_Veteran_v10.md`.

## Stack

- Foundry **v14** (`system.json` compatibility min 14, verified 14.364). Plain ES modules, no bundler.
- Sheets use **ApplicationV2**: `HandlebarsApplicationMixin(ActorSheetV2 / ItemSheetV2)`.
  Don't introduce legacy `ActorSheet`/`FormApplication` APIs.
- Data schema is still `template.json` (no TypeDataModels yet). Spell fields there must match `tools/spell-sheet.mjs` (a test checks this).
- Foundry is installed at `D:/Programme/Foundry Virtual Tabletop`. For a live check: `node resources/app/main.mjs --dataPath=C:/Redo --port=30003 --world=incarnos`, then join as Gamemaster. Use unsaved test documents; never change world data.
- Styles: edit `scss/`, compile to `css/incarnos.css` with `npm run compile` (gulp + sass).

## Layout

- `module/incarnos.mjs` — entry point: registers hooks, document classes, sheets, initiative
  (`@abilities.prc.value + @abilities.spd.value + 1d20`).
- `module/documents/` — `IncarnosActor` (derived stats: Health, Incarna, Parry, Movement),
  `IncarnosItem` (rolls, weapon attacks).
- `module/sheets/` — actor and item sheets; templates in `templates/`.
- `module/helpers/` — `contest-requests.mjs` (attacker/defender contest flow over chat: one visible board per round,
  `flags.incarnos.contestBoard`; hidden request/response messages carry rolls and GM validation; one writer per board;
  resume on `ready` within 12 h; Roll/Cancel buttons on the board),
  `action-tracker.mjs` (AP segments on tokens during combat), `passives.mjs` (item stat modifiers),
  `scene-scale.mjs` (5 ft → 1.5 m scene conversion), `config.mjs`, `effects.mjs`.
- `lang/en.json` — all UI strings go here, referenced via `game.i18n`.
- `module/helpers/spells.mjs` — spell summary line, grouping by element, chat card, and the pure spell rules (text → automation parser read live at cast time, no stored automation fields; attack threshold `stat + 10 − Parry`, save/damage/health math).
- `module/helpers/spell-cast.mjs` — casting flow: cost (IP; AP in combat), area placement via `canvas.regions.placeRegion` (v14 Regions replace measured templates), attack/save/damage rolls, GM-only Apply buttons.
- `module/helpers/roll-card.mjs` — shared chat card layout for every roll (spells, weapon attacks, items, checks, saves, Parry, contests); `spell-card.mjs` builds the spell card on it. Cards post with "Rolling…" and are updated once Dice So Nice finishes (styles in `scss/global/_spell-card.scss`; `css/incarnos.css` is edited by hand to match, as no Sass compiler is installed).
- `tools/` — `import-spells.mjs` + `spell-notes.mjs` (vault `Listen/Spells/<Element>/*.md`, `Typ: Spell`, plus an `<Element>.md` note with `Typ: Element` and its Affinity → `packs/_source/spells`; the Elements List Google Sheet is retired as a source), `pack.mjs` (source JSON → LevelDB pack using Foundry's bundled `classic-level`; builds aside and refuses to replace a pack Foundry has open), `import-talents.mjs` + `talent-notes.mjs` (vault `Listen/Talents` → `packs/_source/talents`; flat stat lines in Bonus become passives, the rest is read live by `module/helpers/talents.mjs`: save advantage, Nightvision darkvision on the token, Impressive Spectacle), `import-races.mjs` (vault `Listen/Races`, same note layout with `Typ: Race` → `packs/_source/races`, item type `race`; `talents.mjs` also reads race rules: save bonuses, movement multipliers, Abomination's HP-for-IP, applied in `IncarnosActor.prepareDerivedData`; one race per actor), `sync-vault.mjs` (`npm run sync:vault`: all vault-sourced packs, rebuilds only changed ones; add new vault importers to its `PACKS` list), `import-monsters.mjs` + `monster-notes.mjs` (vault `Custom Monsters/<Type>/**` → `packs/_source/monsters`, NPC actors with embedded weapon/feature items under `!actors.items!<actor>.<item>` keys; `Token:` = path in `<Data>/tokens`, images are never committed), `import-conditions.mjs` + `condition-notes.mjs` (vault `Listen/Conditions` → generated `module/data/conditions.mjs`, the status effect list; `module/helpers/conditions.mjs` replaces `CONFIG.statusEffects` and automates tokens at turn start, Bleed/Asleep on HP changes, Hidden/Hindered/Prone advantage, Grappled movement), `key-files.mjs` (sync-vault warns when a full-path `[[link]]` in the vault's `CLAUDE.md` no longer resolves), `backup.mjs` + `xlsx.mjs` (sync-vault ends with a backup: vault text copy, `packs/_source`, `Incarnos Lists.xlsx`, in `C:/Users/mfgan/IncarnosBackups`; keeps 2 newest + week + month, see `keepBackups`), `obsidian-plugin/` (Obsidian button that runs `sync-vault.mjs`; installed copy lives in the vault's `.obsidian/plugins/incarnos-foundry-sync`), `spell-sheet.mjs` (old sheet card parser; still provides `parseCost`, `stableId`, `elementToDocuments`); `import-weapons.mjs` + `weapon-notes.mjs` + `weapon-sheet.mjs` (vault notes `System Files/Listen/Weapons` + `Weapon Traits`, and legendary weapons from `Welten/Incarnos/Custom Items/Weapons` into a Legendary folder with `Icon:` picture and description → `packs/_source/weapons`; the vault is the rules source of truth). Weapon traits are parsed live by `module/helpers/weapons.mjs` (Finesse, Throwable, Critical Strike, Deadly, Fatal, Two-Hand, Poor Precision, Sweep are automated in attacks).
- `packs/` — `_source/` is committed; compiled packs are gitignored and rebuilt with `npm run pack:spells`.
- `tests/*.test.mjs` — Node test runner with Foundry globals stubbed.

## Domain rules encoded here

- Rules source of truth: the vault note `System Files/Rules/Incarnos Rules.md`.
- **Modifiers are written from the players' side** (negative = bad for players, everywhere). `module/helpers/modifiers.mjs`
  (`modifierForRoller`) turns them into the roller's own modifier: player characters use them as written, NPC/monster
  actors with the opposite sign (monster weapon modifiers, spell attack and save modifiers).

- Roll-under d20; contests roll `d(max(2, 20 - stat))`, lower total wins, ties reroll.
- Item types: `item`, `weapon`, `feature` (shown as **Talents** in the UI — keep the internal
  type `feature`), `race`, `spell`. Actor types: `character`, `npc` (+ unused `vehicle`, `monster`).
- Incarna (IP, Incarna Points) keeps the legacy `system.power.value/max` actor paths and `system.mp` spell cost; never rename these stored keys. Cost parsers also accept older MP/PP text.
- Actions use `system.actionpoints`, default 3.
- Grid: gridless, 1.5 m units.

## Working here

- Run tests: `node --test tests/*.test.mjs` (all must pass before you call a change done).
  Add tests for new logic in the same style.
- Logic that needs a GM (document updates for other users' actors) goes through the existing
  socket/GM-delegation pattern in `contest-requests.mjs` / `action-tracker.mjs`.
- Keep existing worlds working: new fields need sane defaults or a migration on GM `ready`.
- The README documents every player-facing feature — update it with each new feature.
- Bump `system.json` `version` only when asked. Commit only when asked; don't push.
- After changes, Foundry clients must reload (F5) — say so; there is no hot reload for JS.
- The `.codex/` folder is from a previous assistant setup and is gitignored; leave it alone.
