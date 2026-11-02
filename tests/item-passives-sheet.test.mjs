import assert from "node:assert/strict";
import { test } from "node:test";

class ItemSheet {
  tabGroups = { primary: "description" };
  async _prepareContext() { return {}; }
  _getTabsConfig(group) { return this.constructor.TABS[group] ?? null; }
  _prepareTabs(group) {
    const { tabs, initial } = this._getTabsConfig(group);
    this.tabGroups[group] ??= initial;
    return Object.fromEntries(tabs.map(tab => [tab.id, { ...tab, active: this.tabGroups[group] === tab.id,
      cssClass: this.tabGroups[group] === tab.id ? "active" : "" }]));
  }
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

test("talents use the Description and have no Attributes tab", async () => {
  for (const source of [{ description: "Old talent" }, { description: "After parrying\nGain an advantage." }]) {
    const snapshot = structuredClone(source);
    const sheet = new IncarnosItemSheet();
    Object.assign(sheet, { isEditable: true, options: { classes: [] }, item: {
      type: "feature", isOwner: true, toObject: () => ({ system: structuredClone(source), flags: {} })
    } });
    const context = await sheet._prepareContext({});
    assert.equal(context.descriptionHTML, source.description);
    assert.equal(context.tabs.attributes, undefined);
    assert.deepEqual(source, snapshot);
  }
});

test("only spells use Spell, Flavour and Passives, defaulting to Spell and retaining the selected tab", async () => {
  for (const type of ["item", "weapon", "feature", "race", "spell"]) {
    const sheet = new IncarnosItemSheet();
    Object.assign(sheet, { isEditable: true, options: { classes: [] }, item: {
      type, isOwner: true, toObject: () => ({ system: { description: "<p>Lore</p>" }, flags: {} })
    } });
    const context = await sheet._prepareContext({});
    const ids = type === "spell" ? ["spell", "flavour", "passives"]
      : ["feature", "race"].includes(type) ? ["description", "passives"] : ["description", "attributes", "passives"];
    assert.deepEqual(Object.keys(context.tabs), ids);
    assert.equal(context.tabs[ids[0]].active, true);
    for (const id of ids) {
      sheet.tabGroups.primary = id;
      const updated = await sheet._prepareContext({});
      assert.equal(updated.tabs[id].active, true, `${type} keeps ${id} selected on rerender`);
      assert.equal(Object.values(updated.tabs).filter(tab => tab.active).length, 1);
    }
  }
  assert.equal(IncarnosItemSheet.TABS.primary.initial, "description", "shared defaults are unchanged");
});

test("linked sheet headers expose sync status and an owner reset action with confirmation", async () => {
  const { itemSyncHash } = await import("../module/helpers/item-sync.mjs");
  const source = { _id: "owned", type: "weapon", name: "Example", img: "example.webp", system: { description: "Rules" },
    _stats: { compendiumSource: "Compendium.incarnos.weapons.Item.source" }, flags: { incarnos: {} } };
  source.flags.incarnos.syncHash = itemSyncHash(source);
  globalThis.game = { user: { isGM: false }, i18n: { localize: key => key } };
  const sheet = new IncarnosItemSheet();
  Object.assign(sheet, { isEditable: true, options: { classes: [] }, item: {
    type: "weapon", isOwner: true, toObject: () => structuredClone(source), update: () => assert.fail("Cancelled reset wrote data")
  } });
  const synced = await sheet._prepareContext({});
  assert.equal(synced.itemSync.customized, false);
  assert.equal(synced.canResetCompendium, true);
  source.system.description = "Custom rules";
  assert.equal((await sheet._prepareContext({})).itemSync.customized, true);
  let confirmed = 0;
  foundry.applications.api.DialogV2 = { confirm: async () => { confirmed++; return false; } };
  assert.equal(await actions.resetCompendium.call(sheet, event), false);
  assert.equal(confirmed, 1);
  sheet.item.isOwner = false;
  assert.equal((await sheet._prepareContext({})).canResetCompendium, false);
  assert.equal(await actions.resetCompendium.call(sheet, event), false);
  assert.equal(confirmed, 1);
});
