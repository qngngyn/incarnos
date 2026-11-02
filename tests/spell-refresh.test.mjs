import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.foundry = { utils: { deepClone: value => structuredClone(value) } };
const { spellKey, spellUpdate } = await import("../module/helpers/spell-refresh.mjs");
const { itemSyncHash } = await import("../module/helpers/item-sync.mjs");

test("owned spells match their compendium entry by element and name, case-insensitive", () => {
  assert.equal(spellKey({ name: "Leaf wind", system: { element: "Plants" } }), spellKey({ name: "leaf Wind", system: { element: "plants" } }));
  assert.notEqual(spellKey({ name: "Leaf wind", system: { element: "Plants" } }), spellKey({ name: "Leaf wind", system: { element: "Air" } }));
});

test("legacy spellUpdate delegates to safe sync and records a baseline; a baselined copy is left alone", () => {
  const source = { _id: "source", name: "Leaf wind", img: "a.webp", system: { element: "Plants", effect: "new text" } };
  const flags = { incarnos: { sourceUuid: "Compendium.incarnos.spells.Item.source", syncHash: itemSyncHash(source), customized: false } };
  assert.deepEqual(spellUpdate({ _id: "x", name: "Leaf wind", img: "a.webp", system: { element: "Plants", effect: "old text" } }, source),
    { _id: "x", name: "Leaf wind", img: "a.webp", system: { element: "Plants", effect: "new text" }, flags });
  assert.equal(spellUpdate({ ...structuredClone(source), _id: "x", flags }, source), null);
  const edited = { ...structuredClone(source), flags, name: "My spell" };
  assert.equal(spellUpdate(edited, source).flags.incarnos.customized, true);
});
