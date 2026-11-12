import assert from "node:assert/strict";
import { test } from "node:test";
import { drinkPotion, isPotion, parsePotionActions, parsePotionEffect, restoredPower } from "../module/helpers/potions.mjs";
import { itemsToDocuments, parseItemNote } from "../tools/item-notes.mjs";

const note = (name, effect, extra = "") => "```ad-note\ntitle:### " + name + "\n```\n```ad-check\ntitle: ### Stat Beschreibung:\nTyp: Potion\n"
  + "Icon: icons/consumables/potions/bottle-round-corked-red.webp\nCost: 1 Action (Use Object)\nEffect: " + effect + "\nPrice: 60 gold / 40 gold\n" + extra
  + "```\n```ad-example\ntitle: ### Beschreibung:\nTastes of iron.\n```\n";

test("potion effects: heal and IP formulas", () => {
  assert.deepEqual(parsePotionEffect("Heals 2d8 + 2 HP"), { heal: "2d8 + 2", incarna: "" });
  assert.deepEqual(parsePotionEffect("Restores 3d6 IP"), { heal: "", incarna: "3d6" });
  assert.deepEqual(parsePotionEffect("Heals 1d6 HP and restores 1d4 IP"), { heal: "1d6", incarna: "1d4" });
  assert.equal(parsePotionActions("1 Action (Use Object)"), 1);
  assert.equal(parsePotionActions("2 AP"), 2);
  assert.equal(parsePotionActions(""), 1, "Use Object costs 1 AP");
  assert.equal(restoredPower({ value: 10, max: 15 }, 9), 15, "capped at the maximum");
});

test("vault potion notes become items in a Potions folder", () => {
  const health = parseItemNote(note("Health Potion", "Heals 2d8 + 2 HP"), "Health Potion");
  const incarna = parseItemNote(note("Incarna Potion", "Restores 3d6 IP"), "Incarna Potion");
  assert.deepEqual(health.warnings, []);
  assert.equal(parseItemNote("Rüstungen:\nStoff 10g: 2HP", "1. Shop").item, null, "the price list is no item");
  assert.match(parseItemNote(note("Odd", "Smells nice"), "Odd").warnings[0], /names no healing/);
  const docs = itemsToDocuments([health.item, incarna.item]);
  assert.equal(docs[0].name, "Potions");
  const [hp, ip] = docs.slice(1);
  assert.equal(hp.type, "item");
  assert.equal(hp.folder, docs[0]._id);
  assert.deepEqual([hp.system.heal, hp.system.incarna, hp.system.actions, hp.system.price], ["2d8 + 2", "", 1, "60 gold / 40 gold"]);
  assert.equal(ip.system.incarna, "3d6");
  assert.match(hp.system.description, /Tastes of iron/);
  assert.equal(isPotion(hp), true);
  assert.equal(isPotion({ type: "item", system: {} }), false);
});

function setup(potion) {
  const writes = [], heals = [], paid = [], messages = [];
  const actor = { name: "Silver", system: { power: { value: 4, max: 20 } }, async update(changes) { writes.push(changes); this.system.power.value = changes["system.power.value"]; } };
  const item = { id: "p", name: "Potion", img: "x.webp", actor, type: "item", deleted: false,
    system: { quantity: 2, actions: 1, ...potion },
    async update(changes) { this.system.quantity = changes["system.quantity"]; },
    async delete() { this.deleted = true; } };
  globalThis.ui = { notifications: { warn: message => assert.fail(message) } };
  globalThis.foundry = { utils: { randomID: () => "r" } };
  globalThis.CONFIG = { sounds: { dice: "dice" } };
  globalThis.game = { settings: { get: () => "public" } };
  globalThis.ChatMessage = { getSpeaker: () => ({}), applyMode() {}, async create(data) { messages.push(data); return data; } };
  globalThis.Roll = class {
    static validate() { return true; }
    constructor(formula) { this.formula = formula; }
    async evaluate() { this.total = 7; this.result = "7"; return this; }
    toJSON() { return { formula: this.formula, total: this.total }; }
  };
  const helpers = {
    payActions: async (who, count) => { paid.push(count); return count; },
    applyHealthChange: async (who, key, kind, amount) => { heals.push([kind, amount]); return true; },
    renderRollCard: ({ title, facts, notes }) => `${title}|${facts}|${notes.join("")}`,
    escape: text => String(text)
  };
  return { actor, item, writes, heals, paid, messages, helpers };
}

test("drinking a Health Potion heals, pays 1 AP and uses one up", async () => {
  const f = setup({ heal: "2d8 + 2" });
  await drinkPotion(f.item, f.helpers);
  assert.deepEqual(f.paid, [1]);
  assert.deepEqual(f.heals, [["heal", 7]]);
  assert.equal(f.item.system.quantity, 1);
  assert.match(f.messages[0].content, /Heals <b>7<\/b> HP/);
  assert.match(f.messages[0].content, /1 left/);
});

test("drinking the last Incarna Potion restores IP and removes it", async () => {
  const f = setup({ incarna: "3d6", quantity: 1 });
  f.item.system.quantity = 1;
  await drinkPotion(f.item, f.helpers);
  assert.deepEqual(f.writes, [{ "system.power.value": 11 }]);
  assert.deepEqual(f.heals, []);
  assert.equal(f.item.deleted, true);
});

test("no AP left: nothing is drunk", async () => {
  const f = setup({ heal: "2d8 + 2" });
  f.helpers.payActions = async () => false;
  assert.equal(await drinkPotion(f.item, f.helpers), null);
  assert.deepEqual(f.heals, []);
  assert.equal(f.item.system.quantity, 2);
});
