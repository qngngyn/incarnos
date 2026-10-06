import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
const getProperty = (data, path) => path.split(".").reduce((value, key) => value?.[key], data);
const setProperty = (data, path, value) => {
  const parts = path.split(".");
  const key = parts.pop();
  const parent = parts.reduce((value, part) => value[part] ??= {}, data);
  parent[key] = value;
};
class ActorSheet {
  async _prepareContext() { return {}; }
  _prepareTabs() { return {}; }
  _processFormData(event, form, formData) { return structuredClone(formData.object); }
}
globalThis.Actor = class { getRollData() { return structuredClone(this.system); } };
globalThis.Item = class {};
globalThis.CONFIG = { INCARNOS: { abilities: {} } };
globalThis.game = { i18n: { localize: key => key } };
globalThis.foundry = {
  utils: { getProperty, setProperty, deepClone: structuredClone },
  applications: {
    api: { HandlebarsApplicationMixin: Base => Base },
    sheets: { ActorSheetV2: ActorSheet },
    ux: { TextEditor: { implementation: { enrichHTML: async text => text } } }
  }
};
const { IncarnosActor } = await import("../module/documents/actor.mjs");
const { IncarnosActorSheet } = await import("../module/sheets/actor-sheet.mjs");
const base = JSON.parse(readFileSync(new URL("../template.json", import.meta.url))).Actor.templates.base;
async function setup(type = "character") {
  const source = structuredClone(base);
  const actor = new IncarnosActor();
  Object.assign(actor, { type, effects: [], items: [], isOwner: true });
  actor.toObject = (stored = true) => ({ system: structuredClone(stored ? source : actor.system), flags: {}, items: [] });
  const sheet = new IncarnosActorSheet();
  Object.assign(sheet, { actor, options: { classes: [] }, isEditable: true });
  sheet._prepareItems = () => {};
  const prepare = async () => {
    actor.system = structuredClone(source);
    actor.prepareDerivedData();
    return sheet._prepareContext({});
  };
  await prepare();
  const save = async data => {
    const processed = sheet._processFormData(null, {}, { object: data });
    for (const [key, ability] of Object.entries(processed.system?.abilities ?? {})) {
      Object.assign(source.abilities[key], ability);
    }
    if (processed.system?.actionpoints) Object.assign(source.actionpoints, processed.system.actionpoints);
    if (processed.system?.health) Object.assign(source.health, processed.system.health);
    if (processed.system?.attributes?.parry) Object.assign(source.attributes.parry, processed.system.attributes.parry);
    await prepare();
    return processed;
  };
  return { actor, source, sheet, prepare, save };
}
const item = (stat, value) => ({ system: { passives: { bonus: { stat, value } } } });

test("items add to existing stats; unchanged sheet saves never bake in stacked bonuses", async () => {
  const { actor, source, prepare, save } = await setup();
  source.abilities.str.value = 10;
  source.abilities.str.bonus = 1;
  actor.items.push(item("abilities.str.value", 3), item("abilities.str.value", 2));
  const context = await prepare();
  assert.equal(context.system.abilities.str.value, 16);
  assert.equal(context.system.abilities.str.baseValue, undefined);
  for (let i = 0; i < 3; i++) {
    await save({ name: "New name", system: { abilities: { str: { value: 16 } }, health: { value: 8 } } });
    assert.equal(source.abilities.str.value, 10);
    assert.equal(actor.system.abilities.str.value, 16);
  }
  actor.items.pop();
  await prepare();
  assert.equal(actor.system.abilities.str.value, 14);
  actor.items = [];
  await prepare();
  assert.equal(actor.system.abilities.str.value, 11);
  assert.equal(source.abilities.str.value, 10);
});

test("editing the displayed total preserves the reversible bonus", async () => {
  const { actor, source, prepare, save } = await setup();
  actor.items.push(item("abilities.str.value", 3));
  await prepare();
  assert.equal(actor.system.abilities.str.value, 8);
  await save({ system: { abilities: { str: { value: 12 } } } });
  assert.equal(source.abilities.str.value, 9);
  assert.equal(actor.system.abilities.str.value, 12);
  actor.items = [];
  await prepare();
  assert.equal(actor.system.abilities.str.value, 9);
});

test("NPC derived values remain reversible after saving the sheet", async () => {
  const { actor, source, prepare, save } = await setup("npc");
  actor.items.push(item("health.max", 4), item("attributes.parry.value", -2));
  await prepare();
  await save({ system: { health: { max: 14 }, attributes: { parry: { value: 3 } } } });
  assert.equal(source.health.max, 10);
  assert.equal(source.attributes.parry.value, 5);
  actor.items = [];
  await prepare();
  assert.equal(actor.system.health.max, 10);
  assert.equal(actor.system.attributes.parry.value, 5);
});

test("Effects tab context follows item edits and removal without duplicating bonuses", async () => {
  const { actor, prepare } = await setup();
  const ring = item("abilities.str.value", 2);
  Object.assign(ring, { id: "ring", name: "Ring" });
  ring.system.passives.bonus.description = "A magical boost.";
  actor.items.push(ring);
  let context = await prepare();
  assert.equal(context.effects.passive.effects[0].description, "Adds 2 to Strength. A magical boost.");
  assert.equal(context.effects.passive.effects[0].name, "Ring");
  assert.equal(context.effects.passive.effects[0].sourceName, "Ring");
  assert.equal(actor.system.abilities.str.value, 7);
  assert.equal(actor.effects.length, 0);
  ring.system.passivesEnabled = false;
  context = await prepare();
  assert.equal(context.effects.passive.effects.length, 0);
  assert.equal(context.effects.inactive.effects[0].disabled, true);
  assert.equal(actor.system.abilities.str.value, 5);
  actor.items = [];
  context = await prepare();
  assert.deepEqual(context.effects.passive.effects, []);
  assert.deepEqual(context.effects.inactive.effects, []);
});

test("item passives share existing categories, keep item names and group descriptions per item", async () => {
  const { actor, prepare } = await setup();
  const existing = { id: "effect", name: "Existing passive", disabled: false, isTemporary: false };
  actor.effects.push(existing);
  actor.items.push({ id: "ring", name: "Ring", system: { passives: {
    a: { stat: "abilities.str.value", value: 2, description: "Stronger grip." },
    b: { stat: "attributes.parry.value", value: -1 }
  } } });
  actor.items.push({ id: "empty", name: "Empty Ring", system: { quantity: 0, passives: {
    a: { stat: "abilities.str.value", value: 1 }
  } } });
  const context = await prepare();
  assert.deepEqual(Object.keys(context.effects), ["temporary", "passive", "inactive"]);
  assert.equal(context.effects.passive.effects.length, 2);
  assert.equal(context.effects.passive.effects[0], existing);
  const ring = context.effects.passive.effects[1];
  assert.equal(ring.name, "Ring");
  assert.equal(ring.itemId, "ring");
  assert.equal(ring.duration.label, "Permanent");
  assert.equal(ring.description, "Adds 2 to Strength. Stronger grip.\nSubtracts 1 from Parry.");
  assert.equal(context.effects.inactive.effects[0].name, "Empty Ring");
  assert.equal(context.itemPassives, undefined);
});

test("legacy features become talents with Profile summaries while gear stays separate", async () => {
  globalThis.CONST = { DEFAULT_TOKEN: "default.webp" };
  const { sheet } = await setup();
  const context = { items: [
    { type: "feature", name: "Old talent", system: {} },
    { type: "feature", name: "Riposte", system: { description: "After parrying\nGain an advantage." } },
    { type: "feature", name: "Passive talent", system: { talentType: "passive", apCost: 4 } },
    { type: "weapon", name: "Sword", system: { modifier: 1 } }
  ] };
  IncarnosActorSheet.prototype._prepareItems.call(sheet, context);
  assert.equal(context.talents.length, 3);
  assert.equal(context.gear.length, 1);
  assert.equal(context.talents[0].talentSummary, "");
  assert.equal(context.talents[1].talentSummary, "After parrying\nGain an advantage.");
  assert.equal(context.talents[2].talentSummary, "");
});

test("creating a talent uses the new name and compatible stored type", async () => {
  const { actor, sheet } = await setup();
  let created;
  actor.createEmbeddedDocuments = async (type, data) => { created = { type, data }; };
  await IncarnosActorSheet.DEFAULT_OPTIONS.actions.itemCreate.call(sheet, { preventDefault() {} }, { dataset: { type: "feature" } });
  assert.equal(created.type, "Item");
  assert.equal(created.data[0].name, "New Talent");
  assert.equal(created.data[0].type, "feature");
});

test("attack and save Contest buttons select their own stat values without a type selector", async () => {
  const { actor, sheet } = await setup();
  actor.system.abilities.str.value = 8;
  actor.system.abilities.str.save = 12;
  for (const [contestType, expectedFormula, expectedFlavor] of [
    ["attack", "d12", "Attacker Strength Contest: 8"],
    ["save", "d8", "Defendant Strength Contest: 12"],
    ["attack", "d2", "Attacker Strength Contest: 25"],
    ["save", "d2", "Defendant Strength Contest: 25"]
  ]) {
    if (expectedFormula === "d2") { actor.system.abilities.str.value = 25; actor.system.abilities.str.save = 25; }
    const messages = [];
    const formulas = [];
    const updates = [];
    globalThis.ChatMessage = { getSpeaker: () => ({}), create: async message => {
      messages.push(message);
      return { update: async data => updates.push(data) };
    } };
    globalThis.Roll = class {
      constructor(formula) { this.formula = formula; formulas.push(formula); }
      async evaluate() { return this; }
      async render() { return `<div class="dice-roll">${this.formula}</div>`; }
      toJSON() { return { formula: this.formula, evaluated: true }; }
    };
    foundry.applications.api.DialogV2 = {
      prompt: async options => {
        if (options.window.title === "Ready to roll?") { assert.equal(contestType, "save"); assert.equal(options.ok.label, "Roll"); return options.ok.callback(); }
        assert.equal(options.ok.label, "Roll!");
        assert(!options.content.includes('name="type"'));
        assert(options.window.title.includes(contestType));
        return options.ok.callback(null, { form: { elements: { stat: { value: "Strength" } } } });
      },
      confirm: async () => true
    };
    await IncarnosActorSheet.DEFAULT_OPTIONS.actions.contestRoll.call(sheet, { preventDefault() {} }, { dataset: { contestType } });
    assert.deepEqual(formulas, [expectedFormula]);
    assert.equal(messages[0].flavor.replace(/<[^>]*>/g, ""), expectedFlavor);
    assert(!messages[0].flavor.includes("color:"));
    assert.equal(messages.length, 1);
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0].rolls, [{ formula: expectedFormula, evaluated: true }]);
    assert.equal(updates[0].content, `<div class="dice-roll">${expectedFormula}</div>`);
    assert.equal(updates[0].flavor, undefined);
  }
});

test("cancelling or rejecting an invalid contest updates the original message without rolling", async () => {
  const { actor, sheet } = await setup();
  for (const scenario of ["invalid", "dismiss-stat"]) {
    const messages = [];
    const updates = [];
    actor.system.abilities.str.value = scenario === "invalid" ? NaN : 8;
    globalThis.ChatMessage = {
      getSpeaker: () => ({}),
      create: async data => { messages.push(data); return { update: async update => updates.push(update) }; }
    };
    globalThis.Roll = class { constructor() { assert.fail("Unexpected roll"); } };
    foundry.applications.api.DialogV2 = {
      prompt: async options => options.window.title === "Ready to roll?" ? null : scenario === "dismiss-stat" ? null : options.ok.callback(null, { form: { elements: { stat: { value: "Strength" } } } }),
      confirm: async options => options.window.title === "No contest target selected" || scenario === "invalid"
    };
    await IncarnosActorSheet.DEFAULT_OPTIONS.actions.contestRoll.call(sheet, { preventDefault() {} }, { dataset: { contestType: "attack" } });
    assert.equal(messages.length, scenario === "dismiss-stat" ? 0 : 1);
    assert.equal(updates.length, scenario === "dismiss-stat" ? 0 : 1);
    if (scenario === "cancel") assert.equal(updates[0].content, "<p>Contest cancelled.</p>");
    if (scenario === "invalid") assert.match(updates[0].content, /Cannot roll this contest/);
  }
});

test("sheet attack requests the target player's assigned save; standalone saves send no request", async () => {
  const { actor, sheet } = await setup();
  actor.uuid = "Actor.attacker";
  actor.name = "Attacker";
  actor.testUserPermission = user => user.id === "attacker";
  actor.system.abilities.str.value = 8;
  actor.system.abilities.str.save = 12;
  const defender = { id: "defender", uuid: "Actor.defender", name: "Defender", testUserPermission: user => user.id === "defender" };
  const summon = { id: "summon", uuid: "Actor.summon", testUserPermission: defender.testUserPermission };
  const attackerUser = { id: "attacker", targets: new Set([{ actor: summon }]) };
  game.user = attackerUser;
  game.users = [attackerUser, { id: "defender", character: defender }, { id: "gm", isGM: true, active: true }];
  const messages = [];
  globalThis.ChatMessage = {
    getSpeaker: () => ({}),
    create: async data => { messages.push(data); return { id: "attack-card", update: async () => {} }; }
  };
  globalThis.Roll = class {
    async evaluate() { return this; }
    async render() { return "roll"; }
    toJSON() { return {}; }
  };
  foundry.applications.api.DialogV2 = {
    prompt: async options => {
      if (options.window.title === "Ready to roll?") {
        assert.equal(options.ok.label, "Roll");
        assert.equal(options.no, undefined);
        assert.equal(messages.length, messages.length === 2 ? 2 : 3);
        if (messages.length === 2) assert.equal(messages[1].flags.incarnos.contestRequest.status, "pending");
        return options.ok.callback();
      }
      return options.ok.callback(null, { form: { elements: { stat: { value: "Strength" } } } });
    }, confirm: async () => true
  };
  await IncarnosActorSheet.DEFAULT_OPTIONS.actions.contestRoll.call(sheet, { preventDefault() {} }, { dataset: { contestType: "attack" } });
  assert.equal(messages.length, 2);
  assert(messages[0].flavor.replace(/<[^>]*>/g, "").endsWith(`${actor.name} vs. Defender`));
  assert(messages[1].flavor.replace(/<[^>]*>/g, "").endsWith(`${actor.name} vs. Defender`));
  assert.equal(messages[1].flags.incarnos.contestRequest.defenderUuid, defender.uuid);
  assert.equal(messages[1].flags.incarnos.contestRequest.attackMessageId, "attack-card");
  assert.equal(messages[1].flags.incarnos.contestRequest.stat, "Strength");
  await IncarnosActorSheet.DEFAULT_OPTIONS.actions.contestRoll.call(sheet, { preventDefault() {} }, { dataset: { contestType: "save" } });
  assert.equal(messages.length, 3);
  assert.equal(messages[2].flags?.incarnos?.contestRequest, undefined);
});

test("untargeted attacks ask permission before rolling and can be cancelled without chat", async () => {
  const { actor, sheet } = await setup();
  actor.system.abilities.str.value = 8;
  game.user = { targets: new Set() };
  const messages = [];
  const confirmations = [];
  let promptCount = 0;
  let rollCount = 0;
  let proceedWithoutTarget = false;
  globalThis.ui = { notifications: { warn: () => assert.fail("No-target flow must not warn") } };
  globalThis.ChatMessage = { getSpeaker: () => ({}), create: async data => { messages.push(data); return { update: async () => {} }; } };
  globalThis.Roll = class {
    async evaluate() { rollCount++; return this; }
    async render() { return "roll"; }
    toJSON() { return {}; }
  };
  foundry.applications.api.DialogV2 = {
    confirm: async options => {
      confirmations.push(options);
      return options.window.title === "No contest target selected" ? proceedWithoutTarget : true;
    },
    prompt: async options => {
      if (options.window.title === "Ready to roll?") return options.ok.callback();
      promptCount++;
      return options.ok.callback(null, { form: { elements: { stat: { value: "Strength" } } } });
    }
  };
  const roll = () => IncarnosActorSheet.DEFAULT_OPTIONS.actions.contestRoll.call(sheet, { preventDefault() {} }, { dataset: { contestType: "attack" } });
  await roll();
  assert.equal(messages.length, 0);
  assert.equal(promptCount, 0);
  assert.match(confirmations[0].content, /target is required/);
  assert.equal(confirmations[0].yes.label, "Roll anyway");
  proceedWithoutTarget = true;
  await roll();
  assert.equal(rollCount, 1);
  assert.equal(messages.length, 1);
  assert.equal(promptCount, 1);
  assert.equal(messages[0].flags?.incarnos?.contestRequest, undefined);
});


test("editing maximum actions preserves item passive bonuses as reversible modifiers", async () => {
  const { actor, source, prepare, save } = await setup();
  actor.items.push(item("actionpoints.max", 3));
  await prepare();
  assert.equal(actor.system.actionpoints.max, 6);
  await save({ system: { actionpoints: { max: 6 } } });
  assert.equal(source.actionpoints.max, 3);
  await save({ system: { actionpoints: { max: 9 } } });
  assert.equal(source.actionpoints.max, 6);
  actor.items = [];
  await prepare();
  assert.equal(actor.system.actionpoints.max, 6);
});
