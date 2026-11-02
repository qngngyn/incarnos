import assert from "node:assert/strict";
import { test } from "node:test";
import { parseElementNote, parseSpellNote } from "../tools/spell-notes.mjs";
import { elementToDocuments } from "../tools/spell-sheet.mjs";

const note = [
  "```ad-note", "title:### Encore", "```",
  "```ad-check", "title: ### Stat Beschreibung:", "Typ: Spell", "Element: Shadow", "Category: Utility",
  "Cost: 2 Actions, 10 IP", "Range: 3m", "Target: Single Ally", "Check: No Check", "Duration: Instant",
  "Effect: On cast:", "Immediatly copy a spell", "X is the initial spell's actioncost", "```",
  "```ad-example", "title: ### Beschreibung:", "First paragraph.", "", "Second.", "```", ""
].join("\n");

test("spell notes give the card fields, a multi-line Effect and the parsed cost", () => {
  const { spell, warnings } = parseSpellNote(note, "Encore", "Shadow");
  assert.deepEqual(warnings, []);
  assert.equal(spell.name, "Encore");
  assert.equal(spell.element, "Shadow");
  assert.equal(spell.effect, "On cast:\nImmediatly copy a spell\nX is the initial spell's actioncost");
  assert.equal(spell.description, "First paragraph.\n\nSecond.");
  assert.equal(spell.mp, 10);
  assert.equal(spell.actions, 2);
  assert.equal(spell.target, "Single Ally");
});

test("the folder supplies a missing Element and a mismatch is reported", () => {
  assert.equal(parseSpellNote(note.replace("Element: Shadow\n", ""), "Encore", "Shadow").spell.element, "Shadow");
  assert.match(parseSpellNote(note, "Encore", "Fire").warnings[0], /in the Fire folder/);
  assert.match(parseSpellNote("Typ: Talent", "Odd").warnings[0], /not a spell note/);
});

test("element notes keep their affinity line as written", () => {
  const element = "```ad-note\ntitle:### Blood\n```\n```ad-check\ntitle: ### Stat Beschreibung:\nTyp: Element\nAffinity: Water Affinity: You have resistance to water dmg.\n```\n";
  assert.deepEqual(parseElementNote(element, "Blood"), { element: "Blood", affinity: "Water Affinity: You have resistance to water dmg." });
  assert.equal(parseElementNote(note, "Encore"), null);
});


test("vault IP costs reach imported spell data with the legacy mp key intact", () => {
  for (const [cost, expected] of [["12 IP", 12], ["2 Actions, 12 IP", 12], ["X * 8 IP", 0], ["3 IP times 4d4", 0], ["12 MP", 12], ["12 PP", 12]]) {
    const { spell, warnings } = parseSpellNote(note.replace("2 Actions, 10 IP", cost), "Encore", "Shadow");
    assert.deepEqual(warnings, []);
    assert.equal(spell.cost, cost);
    assert.equal(spell.mp, expected, cost);
    assert.equal(Object.hasOwn(spell, "ip"), false);
  }
});

test("Icon is image metadata and leaves every card field unchanged", () => {
  const icon = "icons/magic/perception/shadow-stealth-eyes-purple.webp";
  const original = parseSpellNote(note, "Encore", "Shadow").spell;
  // Also put Icon after the multiline Effect to verify it ends the previous field.
  for (const withIcon of [
    note.replace("Element: Shadow\n", "Element: Shadow\nIcon: " + icon + "\n"),
    note.replace("X is the initial spell's actioncost\n", "X is the initial spell's actioncost\nIcon: " + icon + "\n")
  ]) {
    const { spell, warnings } = parseSpellNote(withIcon, "Encore", "Shadow");
    assert.deepEqual(warnings, []);
    assert.deepEqual(spell, { ...original, icon });
    const [, item] = elementToDocuments({ element: "Shadow", spells: [spell] }, { img: "icons/svg/invisible.svg" });
    const [, legacy] = elementToDocuments({ element: "Shadow", spells: [original] }, { img: "icons/svg/invisible.svg" });
    assert.equal(item.img, icon);
    assert.deepEqual(item.system, legacy.system, "Icon must never enter rules or Google-sheet-style card text");
    assert.equal(Object.hasOwn(item.system, "icon"), false);
    assert.equal(legacy.img, "icons/svg/invisible.svg", "notes without Icon retain the element fallback");
    assert.equal(item._id, legacy._id, "pictures do not change spell identity");
  }
  const blank = parseSpellNote(note.replace("Element: Shadow\n", "Element: Shadow\nIcon: \n"), "Encore", "Shadow").spell;
  const [, item] = elementToDocuments({ element: "Shadow", spells: [blank] }, { img: "icons/svg/invisible.svg" });
  assert.equal(item.img, "icons/svg/invisible.svg", "a blank template Icon also falls back");
});
