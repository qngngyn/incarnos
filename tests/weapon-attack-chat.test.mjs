import assert from "node:assert/strict";
import { test } from "node:test";

globalThis.Item = class {};
const { rollWeaponAttackAction } = await import("../module/documents/item.mjs");

function setup(results, multiTarget = false) {
  const updates = [];
  const cards = [];
  globalThis.CONFIG = { sounds: { dice: "dice" }, INCARNOS: {
    weaponModes: { ranged: "Ranged" }, attackActions: { shoot: {
      name: "Shoot", modes: ["ranged"], statByMode: { ranged: "dex" }, multiTarget
    } }
  } };
  globalThis.CONST = { CHAT_MESSAGE_STYLES: { ROLL: 5 } };
  globalThis.game = { user: { id: "player" } };
  globalThis.foundry = { utils: { getProperty: (object, path) => path.split(".").reduce((value, key) => value?.[key], object) } };
  globalThis.Roll = class {
    constructor(formula) { this.formula = formula; }
    async evaluate() {
      this.total = results.shift();
      this.dice = [{ faces: 20, results: [{ result: this.total, active: true }] }];
      return this;
    }
    toJSON() { return { formula: this.formula, total: this.total }; }
  };
  globalThis.ChatMessage = {
    applyMode: () => {},
    async create(data) {
      cards.push(structuredClone(data));
      return { id: "attack-card", async update(data) { updates.push(data); } };
    }
  };
  const roll = () => rollWeaponAttackAction({
    item: { name: "Bow", system: { attackMode: "ranged", modifier: 1 } },
    rollData: { abilities: { dex: { value: 10 } } },
    speaker: {}, rollMode: "publicroll", flavor: "Bow", attackId: "shoot", mode: "ranged",
    parryModifiers: multiTarget ? [0, 0] : [0]
  });
  return { updates, cards, roll };
}

test("weapon result stays blank during animation and updates the same message to green Success", async () => {
  const env = setup([3]);
  let finish;
  const animation = new Promise(resolve => { finish = resolve; });
  game.dice3d = { waitFor3DAnimationByMessageID: async id => {
    assert.equal(id, "attack-card");
    assert.match(env.cards[0].flavor, /Result:<\/b>/);
    assert.doesNotMatch(env.cards[0].flavor, /Success|Fail/);
    assert.equal(env.updates.length, 0);
    finish();
    await animation;
  } };
  await env.roll();
  assert.equal(env.cards.length, 1);
  assert.equal(env.updates.length, 1);
  assert.match(env.updates[0].flavor, /color: #2e7d32.*Success/);
  assert.deepEqual(Object.keys(env.updates[0]), ["flavor"]);
});

test("multi-target weapon results distinguish green Success and red Fail without dice animation", async () => {
  const env = setup([3, 18], true);
  await env.roll();
  assert.equal(env.cards.length, 1);
  assert.equal((env.cards[0].flavor.match(/Result:/g) ?? []).length, 2);
  assert.doesNotMatch(env.cards[0].flavor, /Success|Fail/);
  assert.match(env.updates[0].flavor, /color: #2e7d32.*Success/);
  assert.match(env.updates[0].flavor, /color: #c62828.*Fail/);
  assert.doesNotMatch(env.updates[0].flavor, /Critical| by /);
});
