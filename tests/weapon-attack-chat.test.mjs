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
    async evaluate(options = {}) {
      this.options = options;
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

test("weapon result stays hidden during animation and updates the same card to a green Hit", async () => {
  const env = setup([3]);
  let finish;
  const animation = new Promise(resolve => { finish = resolve; });
  game.dice3d = { waitFor3DAnimationByMessageID: async id => {
    assert.equal(id, "attack-card");
    assert.match(env.cards[0].content, /Rolling…/);
    assert.doesNotMatch(env.cards[0].content, /Hit|Miss|isc-amount/);
    assert.equal(env.updates.length, 0);
    finish();
    await animation;
  } };
  await env.roll();
  assert.equal(env.cards.length, 1);
  assert.equal(env.updates.length, 1);
  assert.deepEqual(Object.keys(env.updates[0]), ["content"]);
  const card = env.updates[0].content;
  assert.match(card, /class="isc-name">Bow</);
  assert.match(card, /Shoot · Ranged/);
  assert.match(card, /Dex 10/);
  assert.match(card, /isc-chip isc-good" title="Dex 10 \+1 weapon \+0 attack modifier: rolled 3, needed 11 or less">Hit <small>3\/11<\/small>/);
});

test("multi-target weapon results distinguish a green Hit and a red Miss without dice animation", async () => {
  const env = setup([3, 18], true);
  await env.roll();
  assert.equal(env.cards.length, 1);
  assert.equal((env.cards[0].content.match(/Rolling…/g) ?? []).length, 2);
  assert.doesNotMatch(env.cards[0].content, /Hit|Miss/);
  const card = env.updates[0].content;
  assert.match(card, /Target 1<\/span><span class="isc-chips"><span class="isc-chip isc-good"[^>]*>Hit/);
  assert.match(card, /Target 2<\/span><span class="isc-chips"><span class="isc-chip isc-bad"[^>]*>Miss <small>18\/11/);
  assert.match(card, /isc-target isc-missed/);
  assert.doesNotMatch(card, /data-incarnos-spell-apply/, "no Apply without targeted tokens");
});

test("natural 20 weapon and Weave cards offer a manual critical failure button with the attacking actor", async () => {
  for (const kind of ["weapon", "spell"]) {
    const env = setup([20]);
    const attackId = kind === "spell" ? "weave" : "shoot";
    if (kind === "spell") CONFIG.INCARNOS.attackActions.weave = { ...CONFIG.INCARNOS.attackActions.shoot, name: "Weave" };
    await rollWeaponAttackAction({
      item: { name: "Bow", actor: { uuid: "Actor.attacker", items: [] }, system: { attackMode: "ranged", modifier: 1 } },
      rollData: { abilities: { dex: { value: 10 } } }, speaker: {}, rollMode: "publicroll", attackId, mode: "ranged", parryModifiers: [0]
    });
    assert.equal(env.cards.length, 1, "only the attack posts, no critical failure severity is rolled automatically");
    assert.doesNotMatch(env.cards[0].content, /data-incarnos-critical-start/);
    assert.match(env.updates[0].content, /data-incarnos-critical-start/);
    assert.deepEqual(env.cards[0].flags.incarnos.criticalFailureAttack, { actorUuid: "Actor.attacker", kind });
  }
});

test("weapon traits apply in attacks: Finesse picks Dex, Critical Strike crits on 3, Fatal swaps the damage die", async () => {
  const env = setup([3, 7]);
  CONFIG.INCARNOS.attackActions.slash = { id: "slash", name: "Slash", modes: ["melee"], statByMode: { melee: "str" } };
  CONFIG.INCARNOS.weaponModes.melee = "Melee";
  const rolls = await rollWeaponAttackAction({
    item: { name: "Pistol-knife", system: { attackMode: "melee", modifier: 0, damage: "1d4", traits: "Finesse: Dex.\nCritical Strike 1-3: Crits.\nFatal D10: Big." } },
    rollData: { abilities: { str: { value: 4 }, dex: { value: 12 } } },
    speaker: {}, rollMode: "publicroll", attackId: "slash", mode: "melee", parryModifiers: [0]
  });
  assert.deepEqual(rolls.map(roll => roll.formula), ["1d20", "1d10"]);
  const card = env.updates[0].content;
  assert.match(card, /Dex 12/, "Finesse uses the better stat");
  assert.match(card, /isc-chip isc-crit"[^>]*>Hit · crit <small>3\/12/);
  assert.match(card, /Fatal D10/, "traits are listed on the card");
});

test("a critical hit maxes the damage dice; a normal hit rolls them", async () => {
  setup([1, 6]);
  CONFIG.INCARNOS.attackActions.slash = { id: "slash", name: "Slash", modes: ["melee"], statByMode: { melee: "str" } };
  CONFIG.INCARNOS.weaponModes.melee = "Melee";
  const attack = () => rollWeaponAttackAction({
    item: { name: "Sword", system: { attackMode: "melee", modifier: 0, damage: "1d6" } },
    rollData: { abilities: { str: { value: 10 } } },
    speaker: {}, rollMode: "publicroll", attackId: "slash", mode: "melee", parryModifiers: [0]
  });
  const [, critDamage] = await attack();
  assert.equal(critDamage.options.maximize, true);
  setup([5, 3]);
  CONFIG.INCARNOS.attackActions.slash = { id: "slash", name: "Slash", modes: ["melee"], statByMode: { melee: "str" } };
  CONFIG.INCARNOS.weaponModes.melee = "Melee";
  const [, normalDamage] = await attack();
  assert.equal(normalDamage.options.maximize, false);
});

test("Two-Hand costs 2 hitrate and swaps the damage die when chosen", async () => {
  const env = setup([10, 6]);
  const rolls = await rollWeaponAttackAction({
    item: { name: "Katana", system: { attackMode: "ranged", modifier: 0, damage: "1d6", traits: "Two-Hand D10: Two hands." } },
    rollData: { abilities: { dex: { value: 12 } } },
    speaker: {}, rollMode: "publicroll", attackId: "shoot", mode: "ranged", parryModifiers: [0], twoHanded: true
  });
  assert.deepEqual(rolls.map(roll => roll.formula), ["1d20", "1d10"]);
  assert.match(env.updates[0].content, /Hit <small>10\/10/);
  assert.match(env.updates[0].content, /Two-handed/);
});

test("Impressive Spectacle doubles the damage of a one-handed hit rolled 10+ under the target number", async () => {
  const env = setup([2, 5]);
  const talents = [{ type: "feature", name: "Impressive Spectacle", system: { bonus: "If you attack with a one-handed weapon, and you succeed an attack by over 10 (e.g. …), your damage is doubled for this attack." } }];
  const rolls = await rollWeaponAttackAction({
    item: { name: "Rapier", actor: { items: talents }, system: { attackMode: "ranged", modifier: 0, hands: 1, damage: "1d6" } },
    rollData: { abilities: { dex: { value: 12 } } },
    speaker: {}, rollMode: "publicroll", attackId: "shoot", mode: "ranged", parryModifiers: [0]
  });
  assert.deepEqual(rolls.map(roll => roll.formula), ["1d20", "(1d6) * 2"]);
  assert.match(env.updates[0].content, /isc-chip isc-crit" title="Impressive Spectacle: [^"]*">×2/);
});

test("Impressive Spectacle does not apply two-handed or when the margin is too small", async () => {
  const env = setup([3, 5]);
  const talents = [{ type: "feature", name: "Impressive Spectacle", system: { bonus: "one-handed weapon, and you succeed an attack by over 10, your damage is doubled" } }];
  const rolls = await rollWeaponAttackAction({
    item: { name: "Rapier", actor: { items: talents }, system: { attackMode: "ranged", modifier: 0, hands: 1, damage: "1d6" } },
    rollData: { abilities: { dex: { value: 12 } } },
    speaker: {}, rollMode: "publicroll", attackId: "shoot", mode: "ranged", parryModifiers: [0]
  });
  assert.deepEqual(rolls.map(roll => roll.formula), ["1d20", "1d6"]);
  assert.doesNotMatch(env.updates[0].content, /×2/);
});

test("a hit rolls the tokens of conditions in the weapon's traits and shows them for Apply", async () => {
  const env = setup([3, 4, 2]);
  CONFIG.INCARNOS.attackActions.slash = { id: "slash", name: "Slash", modes: ["melee"], statByMode: { melee: "str" } };
  CONFIG.INCARNOS.weaponModes.melee = "Melee";
  const rolls = await rollWeaponAttackAction({
    item: { name: "Explosion Hug", system: { attackMode: "melee", modifier: 0, damage: "2d4", traits: "Burn D4\nProne" } },
    rollData: { abilities: { str: { value: 10 } } },
    speaker: {}, rollMode: "publicroll", attackId: "slash", mode: "melee", parryModifiers: [0]
  });
  assert.deepEqual(rolls.map(roll => roll.formula), ["1d20", "2d4", "d4"]);
  assert.deepEqual(env.cards[0].flags.incarnos.spellCast.targets[0].conditions, [{ id: "burn", name: "Burn", tokens: 2 }, { id: "prone", name: "Prone" }]);
  const card = env.updates[0].content;
  assert.match(card, />Burn 2</);
  assert.match(card, />Prone</);
});

test("monster attack conditions carry Immobilized duration metadata through to Apply", async () => {
  for (const timed of [false, true]) {
    const env = setup(timed ? [3, 4, 2] : [3, 4]);
    const rolls = await rollWeaponAttackAction({
      item: { name: "Snare", system: { attackMode: "ranged", modifier: -2, damage: "1d6", traits: timed ? "Immobilized 2" : "Immobilized" } },
      rollData: { abilities: { dex: { value: 10 } } },
      speaker: {}, rollMode: "publicroll", attackId: "shoot", mode: "ranged", parryModifiers: [0]
    });
    assert.deepEqual(rolls.map(roll => roll.formula), timed ? ["1d20", "1d6", "2"] : ["1d20", "1d6"]);
    assert.deepEqual(env.cards[0].flags.incarnos.spellCast.targets[0].conditions,
      [{ id: "immobilized", name: "Immobilized", timed, ...(timed ? { tokens: 2 } : {}) }]);
    assert.match(env.updates[0].content, timed ? />Immobilized 2</ : />Immobilized</);
  }
});
