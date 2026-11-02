import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { elementToDocuments, parseCost, parseCsv, parseElementSheet, stableId } from "../tools/spell-sheet.mjs";

/** Build a sheet grid with cards at the given column offsets, like the Elements List layout. */
function card(rows, r, c, cells) {
  for (const [dr, dc, value] of cells) {
    rows[r + dr] ??= [];
    rows[r + dr][c + dc] = value;
  }
}

function sampleGrid() {
  const rows = [[], ["", "Fire"], ["", "", "", "Fire Affinity: You have resistance to fire dmg."]];
  card(rows, 3, 1, [
    [0, 0, "Attack"], [0, 1, "Firelance"], [1, 11, "by someone"], [2, 1, "A lance of fire."],
    [3, 1, "2 Actions, 10 IP"], [4, 1, "12m"], [4, 9, "Single Enemy"],
    [5, 1, "Attack Int / Cha"], [5, 12, "Instant"], [6, 0, "On hit: Deals 6d6 + (lvl * 2) fire dmg"]
  ]);
  card(rows, 3, 20, [
    [0, 0, "Buff"], [0, 1, "Heataura"], [2, 1, "Hot energy."],
    [3, 1, "2 Reactions, 10 IP"], [4, 1, "Self"], [4, 9, "Self"],
    [5, 1, "No Check"], [5, 12, "2 turns"], [6, 0, "On enemy attack:\nMelee: 1d6 fire dmg"]
  ]);
  card(rows, 11, 1, [
    [0, 0, "Utility"], [0, 1, "Echo"], [2, 1, "Copies a spell."],
    [3, 1, "X Actions, Y+2 IP"], [4, 1, "3m"], [5, 1, "No Check"], [6, 0, "On cast: copy"]
  ]);
  card(rows, 11, 20, [[0, 0, "Utility"], [0, 1, "Broken Card"], [2, 1, "No cost line."]]);
  return rows.map(row => Array.from(row ?? [], cell => cell ?? ""));
}

test("CSV parser keeps quoted commas, quotes and newlines", () => {
  assert.deepEqual(parseCsv('a,"b, c","say ""hi""\nnext"\r\n,x\n'), [["a", "b, c", 'say "hi"\nnext'], ["", "x"]]);
});

test("cost lines parse into actions, action type and IP", () => {
  assert.deepEqual(parseCost("2 Actions, 10 IP"), { actions: 2, actionType: "action", mp: 10 });
  assert.deepEqual(parseCost("1 Reaction, 5 IP"), { actions: 1, actionType: "reaction", mp: 5 });
  assert.deepEqual(parseCost("0 Action (once per turn), 6 IP"), { actions: 0, actionType: "action", mp: 6 });
});

test("variable IP costs store 0 and leave the detail to the cost text", () => {
  for (const cost of ["X Actions, Y+2 IP", "X Actions, X * 8 IP", "1 Action, 3 IP times 4d4", "2 Actions, 2 IP per level of target", "1 Action, X HP"]) {
    assert.equal(parseCost(cost).mp, 0, cost);
  }
});

test("cards with an 'Everything' category are found and stray sheet text is reported", () => {
  const rows = sampleGrid();
  card(rows, 19, 1, [
    [0, 0, "Everything"], [0, 1, "Meat Augmentation"], [2, 1, "Regrow parts."], [3, 1, "2 Actions, 10 IP"],
    [4, 1, "6m"], [4, 9, "Single Ally"], [5, 1, "Caster Save Wil"], [5, 12, "varied"],
    [6, 0, "On cast: choose a part"], [7, 1, "-"], [7, 12, "3 turns"], [8, 0, "Extra arms: Parry +2"]
  ]);
  rows[2][45] = "Loose note"; // right of every card's columns
  const grid = rows.map(row => Array.from(row ?? [], cell => cell ?? ""));
  const { spells, warnings } = parseElementSheet(grid, "Flesh");
  const meat = spells.find(s => s.name === "Meat Augmentation");
  assert.equal(meat.category, "Everything");
  assert.equal(meat.effect, "On cast: choose a part\n- · 3 turns\nExtra arms: Parry +2");
  assert.ok(warnings.includes('Flesh: sheet text not in any spell: "Loose note"'));
});

test("element tabs parse every card, skip author lines and report incomplete cards", () => {
  const { affinity, spells, warnings } = parseElementSheet(sampleGrid(), "Fire");
  assert.equal(affinity, "Fire Affinity: You have resistance to fire dmg.");
  assert.deepEqual(spells.map(s => s.name), ["Firelance", "Heataura", "Echo"]);

  const [lance, aura] = spells;
  assert.deepEqual(lance, {
    element: "Fire", name: "Firelance", category: "Attack", description: "A lance of fire.",
    cost: "2 Actions, 10 IP", actions: 2, actionType: "action", mp: 10,
    range: "12m", target: "Single Enemy", check: "Attack Int / Cha", duration: "Instant",
    effect: "On hit: Deals 6d6 + (lvl * 2) fire dmg"
  });
  assert.equal(aura.actionType, "reaction");
  assert.equal(aura.effect, "On enemy attack:\nMelee: 1d6 fire dmg");
  assert.ok(!JSON.stringify(spells).includes("by someone"));
  assert.deepEqual(warnings, ['Fire: "Broken Card" has no cost line, skipped']);
});

test("documents get stable IDs, a folder per element and the system's spell fields", () => {
  const parsed = parseElementSheet(sampleGrid(), "Fire");
  const [folder, ...items] = elementToDocuments(parsed, { img: "icons/svg/fire.svg" });
  const again = elementToDocuments(parsed, { img: "icons/svg/fire.svg" });

  assert.equal(stableId("x"), stableId("x"));
  assert.match(folder._id, /^[A-Za-z0-9]{16}$/);
  assert.equal(folder._key, `!folders!${folder._id}`);
  assert.equal(folder.description, parsed.affinity);
  assert.deepEqual(again.map(d => d._id), [folder, ...items].map(d => d._id));
  assert.ok(items.every(item => item.folder === folder._id && item._key === `!items!${item._id}` && item.type === "spell"));
  assert.equal(items[0].system.description, "<p>A lance of fire.</p>");

  const inserted = { ...parsed, spells: [{ ...parsed.spells[1], name: "New Card" }, ...parsed.spells] };
  const shifted = elementToDocuments(inserted).slice(2);
  assert.deepEqual(shifted.map(d => d._id), items.map(d => d._id), "inserting a card keeps existing IDs");
  const twins = elementToDocuments({ ...parsed, spells: [parsed.spells[0], parsed.spells[0]] }).slice(1);
  assert.notEqual(twins[0]._id, twins[1]._id);

  const template = JSON.parse(readFileSync(new URL("../template.json", import.meta.url))).Item.spell;
  const expected = Object.keys(template).filter(key => key !== "templates").sort();
  const actual = Object.keys(items[0].system).filter(key => !["description", "passivesEnabled", "passives"].includes(key)).sort();
  assert.deepEqual(actual, expected);
});


test("IP and legacy MP/PP costs parse identically, with variable costs left for the caster", () => {
  for (const unit of ["IP", "MP", "PP", "ip", "mp", "pp"]) {
    assert.deepEqual(parseCost("12 " + unit), { actions: 0, actionType: "action", mp: 12 });
    assert.deepEqual(parseCost("2 Actions, 12 " + unit), { actions: 2, actionType: "action", mp: 12 });
    assert.deepEqual(parseCost("1 Reaction, 12 " + unit), { actions: 1, actionType: "reaction", mp: 12 });
    for (const cost of ["X * 8 " + unit, "3 " + unit + " times 4d4"]) {
      assert.equal(parseCost(cost).mp, 0, cost);
    }
  }
});
