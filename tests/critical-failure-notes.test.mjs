import assert from "node:assert/strict";
import { test } from "node:test";
import { criticalFailureMacroDocuments, criticalFailuresToDocuments, parseCriticalFailureNote } from "../tools/critical-failure-notes.mjs";
import { unpackCompendiumSource } from "../module/helpers/compendium-sync.mjs";

const note = `# Critical Failures
## Small mishap (60 %)
| Name | Weapon attack | Spell attack |
| --- | --- | --- |
| Wobble | You are *Hindered*. | Same. |
| Slip | Drop it. | Lose magic. |
## It hurts (30 %)
| Name | Weapon attack | Spell attack |
| :--- | ---: | :---: |
| Fall | Fall prone. | Same. |
## Disaster (10 %)
| Name | Weapon attack | Spell attack |
| --- | --- | --- |
| Break | Break it. | **Burnout:** lose IP. |
`;

test("parses headings, row text, Same. and independent spell text without changing markdown", () => {
  const tables = parseCriticalFailureNote(note.replace(/\n/g, "\r\n"));
  assert.deepEqual(tables.map(table => [table.name, table.chance, table.rows.length]), [
    ["Small mishap", 60, 2], ["It hurts", 30, 1], ["Disaster", 10, 1]
  ]);
  assert.deepEqual(tables[0].rows, [
    { name: "Wobble", weapon: "You are *Hindered*.", spell: "You are *Hindered*." },
    { name: "Slip", weapon: "Drop it.", spell: "Lose magic." }
  ]);
  assert.equal(tables[2].rows[0].spell, "**Burnout:** lose IP.");
});

test("added and reordered rows change only the matching table ranges/formula, keeping IDs and chances", () => {
  const original = criticalFailuresToDocuments(parseCriticalFailureNote(note));
  const expanded = note.replace("| Wobble", Array.from({ length: 31 }, (_, i) => `| New ${i} | Effect ${i}. | Same. |\n`).join("") + "| Wobble");
  const tables = parseCriticalFailureNote(expanded);
  assert.deepEqual(tables.map(table => table.chance), [60, 30, 10]);
  const docs = criticalFailuresToDocuments(tables);
  const { documents } = unpackCompendiumSource(docs, "RollTable");
  assert.equal(documents.length, 6);
  assert.deepEqual(documents.map(table => table.formula), ["1d33", "1d33", "1d1", "1d1", "1d1", "1d1"]);
  for (const table of documents) {
    assert.equal(table.replacement, true);
    table.results.forEach((result, index) => {
      assert.deepEqual(result.range, [index + 1, index + 1]);
      assert.equal(result.weight, 1);
      assert.equal(result.type, "text");
      assert.equal(result.drawn, false);
      assert.match(result.description, /^\*\*.+:\*\* /);
    });
  }
  for (const doc of original) assert.equal(docs.find(entry => entry._key === doc._key)?._id, doc._id);
  const reversed = parseCriticalFailureNote(note);
  reversed[0].rows.reverse();
  const reordered = criticalFailuresToDocuments(reversed);
  for (const doc of original) assert.ok(reordered.some(entry => entry._key === doc._key));
});

test("malformed, duplicate and missing tables fail instead of silently deleting imported content", () => {
  assert.throws(() => parseCriticalFailureNote(""), /Missing or empty/);
  assert.throws(() => parseCriticalFailureNote(note.replace("60 %", "50 %")), /expected 60/);
  assert.throws(() => parseCriticalFailureNote(note.replace("| Slip", "| Wobble")), /duplicate row/);
  assert.throws(() => parseCriticalFailureNote(note.replace("| Slip | Drop it. | Lose magic. |", "| bad | | |")), /invalid table row/);
  const escaped = parseCriticalFailureNote(note.replace("Drop it.", "Left \\| right."));
  assert.equal(escaped[0].rows[1].weapon, "Left | right.");
});

test("Macro source decodes as a stable manual script with no automatic roll", () => {
  const docs = criticalFailureMacroDocuments();
  assert.deepEqual(docs, criticalFailureMacroDocuments());
  const macro = unpackCompendiumSource(docs, "Macro").documents[0];
  assert.equal(macro.name, "Critical Failure");
  assert.equal(macro.type, "script");
  assert.equal(macro.command, "await game.incarnos.criticalFailure();");
});
