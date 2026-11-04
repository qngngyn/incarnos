import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTraitNote, parseWeaponNote, weaponNotesToRows } from "../tools/weapon-notes.mjs";
import { parseWeaponRows } from "../tools/weapon-sheet.mjs";

const note = (title, fields) => `\`\`\`ad-note
title:### ${title}
\`\`\`
\`\`\`ad-check
title: ### Stat Beschreibung:
Typ: Waffe
${Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n")}
\`\`\`
`;

const traits = {
  Finesse: parseTraitNote("Finesse: Use Dex."),
  Reach: parseTraitNote("Reach (Distance): Attack within the named range."),
  Deadly: parseTraitNote("Deadly (dice, e.g. D4): When you crit, add the named dice."),
  Parry: parseTraitNote("Parry: +1 Parry"),
  Consuming: parseTraitNote("Consuming: Consumes the following item each use: (consumed item, e.g. arrows)"),
  "Shield Bash": parseTraitNote("(Once per Turn) Shield Bash: Knock prone.")
};

test("trait notes give the text after the name", () => {
  assert.equal(traits.Deadly, "When you crit, add the named dice.");
});

test("weapon notes become sheet rows with trait lines from the trait notes", () => {
  const { row, warnings } = parseWeaponNote(note("Whip", {
    Reichweite: "Melee", "Anzahl Hände": 1, Hitrate: "+1", Damage: "1d4",
    Traits: "[[Finesse]], [[Reach]] 4,5m, [[Deadly|deadly]] D8"
  }), "Whip", traits);
  assert.deepEqual(warnings, []);
  assert.deepEqual(row, ["Whip", "Melee", "1", "+1", "1d4",
    "Finesse: Use Dex.\nReach 4,5m: Attack within the named range.\nDeadly D8: When you crit, add the named dice.", "", ""]);
});

test("a trailing (…) fills the trait's placeholder or replaces its text; prefixes and plain text stay", () => {
  const { row } = parseWeaponNote(note("Shield", {
    Reichweite: "Melee", "Anzahl Hände": 1, Hitrate: "-", Damage: "-",
    Traits: "[[Parry]] (+2 Parry), (Once per Turn) [[Shield Bash]], [[Consuming]] (1x Bullet (any), 1x Powder), Spit on that thang."
  }), "Shield", traits);
  assert.equal(row[5], "Parry: +2 Parry\n(Once per Turn) Shield Bash: Knock prone.\n"
    + "Consuming: Consumes the following item each use: 1x Bullet (any), 1x Powder\nSpit on that thang.");
});

test("rows feed the weapon parser; non-weapon notes and missing traits warn", () => {
  const { rows, warnings } = weaponNotesToRows([
    { name: "Bow", markdown: note("Shortbow", { Reichweite: "Ranged (24m)", "Anzahl Hände": 2, Hitrate: "+0", Damage: "1d6", Traits: "[[Unknown]]" }) },
    { name: "Notes", markdown: "just text" }
  ], traits);
  assert.deepEqual(warnings, ['Shortbow: no trait note "Unknown"', 'Notes: not a weapon note (no "Typ: Waffe")']);
  const [bow] = parseWeaponRows(rows).weapons;
  assert.deepEqual({ ...bow }, { name: "Shortbow", attackMode: "ranged", range: "24m", hands: 2, modifier: 0, damage: "1d6", traits: "Unknown" });
});

test("legendary notes: bullet traits below the Traits line, bare range, conditional damage, picture and description", () => {
  const markdown = `\`\`\`ad-note
title: ### Supreme Favor
\`\`\`
\`\`\`ad-check
title: ### Stat Beschreibung:
Typ: Waffe
Icon: tokens/items/supreme-favor.webp
Reichweite: 18m
Anzahl Hände: 1
Damage: 2d8 + 1d8 vs Undead/Fiends
Traits:
- Bound weapon: Returns to your hand, whenever you will it.
[[Finesse]], [[Deadly]] D8
\`\`\`
\`\`\`ad-example
title: ### Beschreibung:
A blessed blade.

Second line.
### 
\`\`\`
`;
  const { row, warnings } = parseWeaponNote(markdown, "Eostre's Favor", traits);
  assert.deepEqual(warnings, []);
  assert.deepEqual(row, ["Supreme Favor", "Ranged (18m)", "1", "", "2d8",
    "Bound weapon: Returns to your hand, whenever you will it.\nFinesse: Use Dex.\nDeadly D8: When you crit, add the named dice.\n"
    + "Bonus Damage: +1d8 vs Undead/Fiends", "tokens/items/supreme-favor.webp", "A blessed blade.\n\nSecond line."]);
  assert.equal(parseWeaponNote(markdown.replace("Supreme Favor", ""), "Eostre's Favor", traits).row[0], "Eostre's Favor",
    "an empty heading falls back to the file name");
});
