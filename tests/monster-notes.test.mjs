import assert from "node:assert/strict";
import { test } from "node:test";
import { monstersToDocuments, parseAttackLine, parseMonsterNote, speedMetres } from "../tools/monster-notes.mjs";

const note = [
  "```ad-note", "title:Level 2", "```",
  "````ad-warning", "title: ### Stats:", "", "Element: Shadow", "", "Weakness: Light", "", "HP: 14", "", "Parry: 12 (-2)", "",
  "Speed: 7 (10,5m)", "", "Token: tokens/monsters/lashtail-panther.webp", "", "Traits:", "Shadow Pelt: -2 in the dark.",
  "```ad-warning", "title: Attacks:", "Claws: Melee -1 1d6+2", "Lashtail: Melee -1 1d8+1, [[Reach]] (3m)",
  "- Feuerblitz: Ranged ST Dex 2d8 fire", "```",
  "```ad-warning", "title: Actions:", "```", "````", "",
  "| Str | Dex | Con | Wil | Prc | Spd | Int | Cha |", "| --- | --- | --- | --- | --- | --- | --- | --- |",
  "| 11  | 14  | 9   | 8   | 13  | 14  | 4   | 6   |", "",
  "```ad-check", "title: ### Beschreibung:", "Aussehen: Dunkel.", "", "Geruch: Asche.", "### ", "```",
  "```ad-example", "title: ### Volle Beschreibung:", "Jagt in der Dämmerung.", "```", ""
].join("\n");

test("speed in metres from squares or an explicit metre value", () => {
  assert.equal(speedMetres("7 (10,5m)"), 10.5);
  assert.equal(speedMetres("3m"), 3);
  assert.equal(speedMetres("4"), 6);
  assert.equal(speedMetres(""), 0);
});

test("Size is optional, positive whole squares and preserves URL-encoded Token paths", () => {
  for (const [line, expected] of [["", 1], ["Size: 1", 1], ["Size: 2", 2], ["Size: 3", 3], ["Size: 4", 4],
    ["Size: 0", 1], ["Size: -2", 1], ["Size: 1.5", 1], ["Size: big", 1]]) {
    const path = "pnp%20zeugs/tokens/Monster/Fire%20Elemental%20-%20Cold%20Chill.png";
    const { monster } = parseMonsterNote(note.replace("Token: tokens/monsters/lashtail-panther.webp", `${line}\nToken: ${path}`), "Elemental");
    const actor = monstersToDocuments([{ monster, type: "Elementals" }]).find(doc => doc.type === "npc");
    assert.equal(monster.size, expected);
    assert.equal(actor.prototypeToken.width, expected);
    assert.equal(actor.prototypeToken.height, expected);
    assert.equal(actor.prototypeToken.texture.src, path);
  }
});

test("attack lines become weapons with hitrate, damage, range and trait text", () => {
  assert.deepEqual(parseAttackLine("Claws: Melee -1 1d6+2"), { name: "Claws", attackMode: "melee", modifier: -1, damage: "1d6+2", range: "", traits: "" });
  assert.deepEqual(parseAttackLine("Splash: Melee-3 4d8, Prone"), { name: "Splash", attackMode: "melee", modifier: -3, damage: "4d8", range: "", traits: "Prone" });
  assert.equal(parseAttackLine("Bow: Ranged (12m) 2d4").range, "12m");
  assert.equal(parseAttackLine("Bare Fist: Melee 1d4+2").modifier, 0);
  const lash = parseAttackLine("Lashtail: Melee -1 1d8+1, [[Reach]] (3m)", { Reach: "This weapon can attack in melee within the named ranged." });
  assert.equal(lash.range, "3m");
  assert.equal(lash.traits, "Reach: 3m");
  assert.equal(parseAttackLine("Fire Breath: Ranged 4,5m Cone, ST Prc/Dex 3d6 fire dmg"), null);
});

test("a monster note gives stats, weapons, text abilities and the token", () => {
  const { monster, warnings } = parseMonsterNote(note, "Lashtail Panther", { traits: { Reach: "melee within the named range." } });
  assert.deepEqual(warnings, []);
  assert.equal(monster.level, 2);
  assert.equal(monster.hp, 14);
  assert.equal(monster.parry, 12);
  assert.equal(monster.movement, 10.5);
  assert.equal(monster.token, "tokens/monsters/lashtail-panther.webp");
  assert.deepEqual(monster.abilities, { str: 11, dex: 14, con: 9, wis: 8, prc: 13, spd: 14, int: 4, cha: 6 });
  assert.deepEqual(monster.weapons.map(w => w.name), ["Claws", "Lashtail"]);
  assert.equal(monster.special, "- Feuerblitz: Ranged ST Dex 2d8 fire", "a dashed line naming its own attack is not a note on the attack above");
  assert.equal(monster.actions, "", "an empty Actions block stays empty");
  assert.equal(monster.traits, "Shadow Pelt: -2 in the dark.");
  assert.match(parseMonsterNote(note.replace("HP: 14", "HP:"), "X").warnings[0], /incomplete/);
  assert.match(parseMonsterNote("# Monster Balancing", "Monster Balancing").warnings[0], /not a monster note/);
});

test("monsters become NPC actors with embedded weapons and talents, one folder per type", () => {
  const { monster } = parseMonsterNote(note, "Lashtail Panther");
  const docs = monstersToDocuments([{ monster, type: "Animals" }]);
  const folder = docs.find(doc => doc._key.startsWith("!folders!"));
  const actor = docs.find(doc => doc._key.startsWith("!actors!"));
  const items = docs.filter(doc => doc._key.startsWith(`!actors.items!${actor._id}.`));
  assert.equal(folder.name, "Animals");
  assert.equal(actor.type, "npc");
  assert.equal(actor.folder, folder._id);
  assert.equal(actor.img, "tokens/monsters/lashtail-panther.webp");
  assert.equal(actor.prototypeToken.texture.src, actor.img);
  assert.equal(actor.prototypeToken.disposition, -1);
  assert.equal(actor.system.attributes.parry.value, 12);
  assert.equal(actor.system.power.max, 0);
  assert.equal(actor.system.abilities.dex.value, 14);
  assert.deepEqual(actor.items, items.map(item => item._id));
  assert.deepEqual(items.map(item => `${item.type}:${item.name}`), ["weapon:Claws", "weapon:Lashtail", "feature:Traits", "feature:Special Attacks"]);
  assert.match(actor.system.biography, /Element: Shadow · Weakness: Light/);
  assert.equal(monstersToDocuments([{ monster, type: "Animals" }]).find(doc => doc.type === "npc")._id, actor._id, "IDs are stable");
});
