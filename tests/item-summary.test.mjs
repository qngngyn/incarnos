import assert from "node:assert/strict";
import { test } from "node:test";
import { itemSummaryParts, sortItems } from "../module/helpers/item-summary.mjs";

test("item lists follow the dragged order (sort); ties keep their order", () => {
  const items = [{ name: "Cee", sort: 200 }, { name: "Bee", sort: 100 }, { name: "Ay", sort: 200 }, { name: "Zed" }];
  assert.deepEqual(sortItems(items).map(item => item.name), ["Zed", "Bee", "Cee", "Ay"]);
});

test("summaries: spell card body, weapon facts and traits, talent bonus and description, item description", () => {
  const spell = itemSummaryParts({ type: "spell", system: { effect: "On hit: 1d6" } }, { spellContent: system => `<p>${system.effect}</p>` });
  assert.deepEqual(spell, { html: "<p>On hit: 1d6</p>", description: "" });
  const weapon = itemSummaryParts({ type: "weapon", system: { attackMode: "ranged", range: "18m", hands: 2, damage: "2d10",
    traits: "Deadly d10: When you crit, add <dice>.\nPlain line", description: "<p>Bow</p>" } });
  assert.equal(weapon.html, '<p class="item-summary-facts">Ranged (18m) · 2 hands · Damage 2d10</p><ul class="item-summary-traits">'
    + "<li><strong>Deadly d10:</strong> When you crit, add &lt;dice&gt;.</li><li>Plain line</li></ul>");
  assert.equal(weapon.description, "<p>Bow</p>");
  assert.match(itemSummaryParts({ type: "feature", system: { bonus: "+1 Parry", description: "<p>Text</p>" } }).description, /\+1 Parry.*<p>Text<\/p>/);
  assert.deepEqual(itemSummaryParts({ type: "item", system: { description: "<p>Rope</p>" } }), { html: "", description: "<p>Rope</p>" });
});
