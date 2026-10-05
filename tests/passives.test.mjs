import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { getItemPassiveModifiers, getItemPassiveEntries } from "../module/helpers/passives.mjs";

globalThis.Actor = class {
  getRollData() { return structuredClone(this.system); }
};
globalThis.foundry = { utils: { deepClone: structuredClone } };
const { IncarnosActor } = await import("../module/documents/actor.mjs");
const base = JSON.parse(readFileSync(new URL("../template.json", import.meta.url))).Actor.templates.base;
const item = (passives, extra = {}) => ({ system: { passives, ...extra } });
const passive = (stat, value) => ({ stat, value });
function actor(type, items = [], source = base) {
  const actor = new IncarnosActor();
  Object.assign(actor, { type, items, system: structuredClone(source) });
  actor.prepareDerivedData();
  return actor;
}

test("signed modifiers stack once per item and skip inactive or invalid entries", () => {
  const items = [
    item({ a: passive("abilities.str.value", 3) }, { quantity: 20 }),
    item({ a: passive("abilities.str.value", -1), b: passive("attributes.movement.value", 1.5) }),
    item({ a: passive("abilities.str.value", 50) }, { passivesEnabled: false }),
    item({ a: passive("abilities.str.value", 50) }, { quantity: 0 }),
    item({ a: passive("abilities.str.value", "invalid"), b: passive("health.value", 100), c: null }),
    { system: {} }
  ];
  const snapshot = structuredClone(items);
  assert.deepEqual(getItemPassiveModifiers(items), { "abilities.str.value": 2, "attributes.movement.value": 1.5 });
  assert.deepEqual(items, snapshot);
});

test("base modifiers feed derived stats, saves and rolls; direct derived modifiers apply last", () => {
  const source = structuredClone(base);
  source.abilities.con.bonus = 1;
  const items = [item({
    a: passive("abilities.str.value", 2), b: passive("abilities.con.value", 3),
    c: passive("abilities.wis.value", 2), d: passive("abilities.prc.value", 3),
    e: passive("abilities.spd.value", 2), f: passive("health.max", -4),
    g: passive("power.max", 1), h: passive("attributes.parry.value", -1),
    i: passive("attributes.movement.value", 1.5), j: passive("actionpoints.max", 2)
  })];
  const result = actor("character", items, source);
  assert.equal(result.system.abilities.str.value, 7);
  assert.equal(result.system.abilities.con.value, 9);
  assert.equal(result.system.abilities.str.save, 7);
  assert.equal(result.system.health.max, 21);
  assert.equal(result.system.power.max, 20);
  assert.equal(result.system.attributes.parry.value, 6);
  assert.equal(result.system.attributes.movement.value, 6.75);
  assert.equal(result.system.actionpoints.max, 6);
  assert.equal(result.system.health.value, source.health.value);
  assert.equal(result.getRollData().str.value, 7);
  assert.equal(source.abilities.str.value, 5);
});

test("repreparation, disabling, editing and removing items leave base stats intact", () => {
  const owned = item({ a: passive("abilities.str.value", 2) });
  const result = actor("character", [owned]);
  for (let i = 0; i < 3; i++) {
    result.system = structuredClone(base);
    result.prepareDerivedData();
    assert.equal(result.system.abilities.str.value, 7);
  }
  owned.system.passives.a.value = -2;
  result.system = structuredClone(base);
  result.prepareDerivedData();
  assert.equal(result.system.abilities.str.value, 3);
  owned.system.passivesEnabled = false;
  result.system = structuredClone(base);
  result.prepareDerivedData();
  assert.equal(result.system.abilities.str.value, 5);
  result.items = [];
  result.system = structuredClone(base);
  result.prepareDerivedData();
  assert.equal(result.system.abilities.str.value, 5);
  assert.equal(result.system.health.max, 15);
});

test("NPC passives preserve manually configured derived values", () => {
  const result = actor("npc", [item({ a: passive("abilities.con.value", 3), b: passive("health.max", 4), c: passive("attributes.parry.value", -2) })]);
  assert.equal(result.system.abilities.con.value, 8);
  assert.equal(result.system.abilities.str.save, 6);
  assert.equal(result.system.health.max, 14);
  assert.equal(result.system.attributes.parry.value, 3);
});

test("Effects entries describe modifiers and retain inactive sources without applying their bonuses", () => {
  const items = [
    { id: "ring", name: "Ring of Strength", img: "ring.webp", system: { passives: { strength: { stat: "abilities.str.value", value: 2, description: "Ancient magic strengthens the wearer." } } } },
    { id: "armor", name: "Heavy Armor", system: { passivesEnabled: false, passives: { penalty: { stat: "attributes.movement.value", value: -1.5 } } } },
    { id: "empty", name: "Empty Item", system: { quantity: 0, passives: { parry: { stat: "attributes.parry.value", value: 3 } } } }
  ];
  const snapshot = structuredClone(items);
  const entries = getItemPassiveEntries(items);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].itemId, "ring");
  assert.equal(entries[0].sourceName, "Ring of Strength");
  assert.equal(entries[0].name, "Ring of Strength");
  assert.equal(entries[0].summary, "Adds 2 to Strength.");
  assert.equal(entries[0].description, "Ancient magic strengthens the wearer.");
  assert.equal(entries[0].active, true);
  assert.equal(entries[1].summary, "Subtracts 1.5 from Movement.");
  assert.equal(entries[1].description, "");
  assert.equal(entries[1].status, "Inactive: item passives disabled");
  assert.equal(entries[2].status, "Inactive: quantity zero");
  assert.deepEqual(getItemPassiveModifiers(items), { "abilities.str.value": 2 });
  assert.deepEqual(items, snapshot);
});
