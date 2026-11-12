# AI Handoff

## 2026-11-12 — PC-built NPC monster importer

- Added optional Stats fields IP, Race, Talents, Spells and Disposition. Item names resolve case-insensitively from source JSON through readPackSource; wikilink labels are ignored, unknown names warn. Embedded copies preserve rules/images/effects, have stable actor item IDs and compendium UUID metadata (including the item-sync sourceUuid convention).
- Preserved actor IDs and existing top-level folder IDs; nested paths become folders up to depth four, with deeper notes placed in the fourth folder. Existing note output has a SHA-256 regression baseline proving byte-identical JSON without the new fields.
- Files: tools/monster-notes.mjs, tools/import-monsters.mjs, tests/monster-notes.test.mjs, CLAUDE.md, README.md and this handoff. sync-vault import order remains races/talents/spells before monsters.
- Validation: npm test passed all 430 tests (0 failures); git diff --check passed. Node preserve-symlinks flags were used to accommodate sandbox access to ancestor directories. Added coverage for independent linked item copies, unknown references, IP spending by imported NPC spells, nested folder depth and disposition.
- NPC sheet/casting review: actor-npc-sheet.html includes actor-spells.html; actor-sheet.mjs groups all spell items for NPCs and sends item rolls to IncarnosItem.roll; that routes spell items to castSpell. spell-cost.mjs checks and deducts system.power.value for NPCs without a character-only restriction. No missing NPC casting support found; no sheet refactor needed.
- Open points: no Foundry runtime smoke test performed. Any later runtime test must use a copied world. After the normal source update, reload Foundry clients (F5). No sync:vault, pack build, LevelDB/world changes, commits, vault writes or player data.
- Follow-up (Claude): embedded race/talent copies get `passivesEnabled: false`, because monster notes write final stats/HP/Parry/Speed (passives apply to NPCs too and would double-count). Test adjusted; 430/430 pass.
