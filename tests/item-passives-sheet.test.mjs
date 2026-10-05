import assert from "node:assert/strict";
import { test } from "node:test";

class ItemSheet {
  async _prepareContext() { return {}; }
  _prepareTabs() { return {}; }
}
globalThis.foundry = {
  utils: { randomID: () => "newPassive" },
  applications: {
    api: { HandlebarsApplicationMixin: Base => Base },
    sheets: { ItemSheetV2: ItemSheet },
    ux: { TextEditor: { implementation: { enrichHTML: async text => text } } }
  }
};
globalThis.CONFIG = { INCARNOS: {} };
const { IncarnosItemSheet } = await import("../module/sheets/item-sheet.mjs");
const actions = IncarnosItemSheet.DEFAULT_OPTIONS.actions;
const event = { preventDefault() {} };

test("adding and deleting passives updates only the selected entry", async () => {
  const updates = [];
  const sheet = { isEditable: true, item: {
    system: { passives: { existing: { stat: "health.max", value: 3 } } },
    update: async data => updates.push(data)
  } };
  await actions.passiveAdd.call(sheet, event);
  await actions.passiveDelete.call(sheet, event, { dataset: { passiveId: "existing" } });
  await actions.passiveDelete.call(sheet, event, { dataset: { passiveId: "missing" } });
  assert.deepEqual(updates, [
    { "system.passives.newPassive": { stat: "abilities.str.value", value: 0, description: "" } },
    { "system.passives.-=existing": null }
  ]);
});

test("read-only item sheets cannot add or remove passives", async () => {
  const sheet = { isEditable: false, item: { update() { assert.fail("Unexpected update"); } } };
  await actions.passiveAdd.call(sheet, event);
  await actions.passiveDelete.call(sheet, event, { dataset: { passiveId: "existing" } });
});

test("legacy items receive editor defaults without changing stored item data", async () => {
  for (const type of ["item", "weapon", "feature", "spell"]) {
    const source = { system: { description: "Example" }, flags: {} };
    const sheet = new IncarnosItemSheet();
    Object.assign(sheet, { isEditable: true, options: { classes: [] }, item: {
      type, isOwner: true, toObject: () => structuredClone(source)
    } });
    const context = await sheet._prepareContext({});
    assert.equal(context.system.passivesEnabled, true);
    assert.deepEqual(context.system.passives, {});
    assert.equal(context.passiveStats["abilities.str.value"], "Strength");
    assert.equal(source.system.passives, undefined);
  }
});
