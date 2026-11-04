import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { parseWeaponRows, weaponsToDocuments } from "../tools/weapon-sheet.mjs";

const rows = [
  ["Name ", "Weapon Type ", "Hands ", "Hitrate ", "Damage ", "Traits "],
  ["Whip", "Melee", "1", "+1", "1d4", "Finesse: Dex.\nReach 4,5m: Reach.\n"],
  ["Shield", "Melee", "1", "-", "-", "Parry: +1 Parry\n(Once per Turn) Shield Bash: Bash."],
  ["Longbow", "Ranged (36m)", "2", "-2", "1d10", "Deadly D10: Crits."],
  ["", "", "", "", "", ""],
  ["Oddity", "Thrown", "x", "two", "1d6", ""]
];

test("weapon rows become weapons with mode, range, hands, hitrate, damage and traits", () => {
  const { weapons, warnings } = parseWeaponRows(rows);
  assert.deepEqual(weapons.map(w => w.name), ["Whip", "Shield", "Longbow", "Oddity"]);
  assert.deepEqual(weapons[0], { name: "Whip", attackMode: "melee", range: "4,5m", hands: 1, modifier: 1, damage: "1d4", traits: "Finesse: Dex.\nReach 4,5m: Reach." });
  assert.deepEqual([weapons[1].modifier, weapons[1].damage, weapons[1].range], [0, "", ""], "dashes mean no hitrate bonus and no damage");
  assert.deepEqual([weapons[2].attackMode, weapons[2].range, weapons[2].hands, weapons[2].modifier], ["ranged", "36m", 2, -2]);
  assert.deepEqual(warnings, ['Oddity: unknown weapon type "Thrown", treated as melee', 'Oddity: hitrate "two" is not a number, using 0']);
  assert.throws(() => parseWeaponRows([["Name", "Damage"]]), /Unexpected header/);
});

test("documents get stable IDs, Melee/Ranged folders, icons, Parry passives and the system's weapon fields", () => {
  const { weapons } = parseWeaponRows(rows.slice(0, 4));
  const docs = weaponsToDocuments(weapons, { icon: weapon => (weapon.name === "Whip" ? "icons/whip.webp" : null) });
  const [melee, ranged, legendary, whip, shield, bow] = docs;
  assert.deepEqual([melee.name, ranged.name, legendary.name], ["Melee", "Ranged", "Legendary"]);
  assert.deepEqual([whip.folder, shield.folder, bow.folder], [melee._id, melee._id, ranged._id]);
  assert.deepEqual(weaponsToDocuments(weapons).map(doc => doc._id), docs.map(doc => doc._id), "IDs are stable");
  assert.equal(whip.img, "icons/whip.webp");
  assert.equal(bow.img, "icons/weapons/bows/bow-simple-small.webp");
  assert.deepEqual(shield.system.passives, { parry: { stat: "attributes.parry.value", value: 1, description: "Parry trait" } });
  assert.deepEqual(whip.system.passives, {});
  const template = JSON.parse(readFileSync(new URL("../template.json", import.meta.url))).Item.weapon;
  const expected = Object.keys(template).filter(key => key !== "templates").sort();
  const actual = Object.keys(whip.system).filter(key => !["description", "passivesEnabled", "passives"].includes(key)).sort();
  assert.deepEqual(actual, expected);
});

test("legendary weapons go into the Legendary folder with their own picture, description and ID", () => {
  const header = ["Name", "Weapon Type", "Hands", "Hitrate", "Damage", "Traits", "Icon", "Description"];
  const { weapons } = parseWeaponRows([header,
    ["Coronacht", "Ranged (18m)", "2", "", "2d10", "", "tokens/items/coronacht.webp", "A <bow>.\n\nSecond part."],
    ["Coronacht", "Ranged (18m)", "2", "", "2d10", "", "", ""]]);
  weapons[0].legendary = true;
  const docs = weaponsToDocuments(weapons);
  const [legendaryFolder, special, plain] = [docs[2], docs[3], docs[4]];
  assert.equal(special.folder, legendaryFolder._id);
  assert.equal(plain.folder, docs[1]._id);
  assert.notEqual(special._id, plain._id, "a legendary weapon never shares the ID of a regular one");
  assert.equal(special.img, "tokens/items/coronacht.webp");
  assert.equal(special.system.description, "<p>A &lt;bow&gt;.</p><p>Second part.</p>");
  assert.deepEqual(special.flags, { incarnos: { legendary: true } });
  assert.equal("img" in special.system || "legendary" in special.system, false);
});
