import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { INCARNOS } from "../module/helpers/config.mjs";

globalThis.Item = class {};
const { IncarnosItem, rollWeaponAttackAction } = await import("../module/documents/item.mjs");

const strings = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url)));
function attackPaymentSetup(value = 3, npc = false) {
  const env = setup(Array(20).fill(20));
  const writes = [], warnings = [];
  const actor = { name: "Attacker", uuid: "Actor.attacker", type: npc ? "npc" : "character", items: [], statuses: new Set(),
    system: { actionpoints: { value, max: 3 } }, testUserPermission: () => true,
    async update(data) { await Promise.resolve(); writes.push(data); this.system.actionpoints.value = data["system.actionpoints.value"]; },
    getRollData: () => ({ abilities: { str: { value: 10 }, dex: { value: 10 }, int: { value: 10 }, cha: { value: 10 } } }) };
  game.user.isGM = npc;
  game.i18n = { localize: key => strings[key], format: (key, data) => strings[key].replace(/\{(\w+)\}/g, (_, field) => data[field]) };
  game.settings = { get: () => "publicroll" };
  game.combats = [{ started: true, combatants: [{ actor }] }];
  CONFIG.INCARNOS = INCARNOS;
  globalThis.ui = { notifications: { warn: warning => warnings.push(warning) } };
  foundry.utils.deepClone = structuredClone;
  ChatMessage.getSpeaker = () => ({});
  const item = Object.assign(new IncarnosItem(), { name: "Sword", type: "weapon", actor,
    system: { attackMode: "melee", versatile: true, modifier: 0, damage: "1d6" } });
  const roll = (attackId = "normal", mode = "melee") => rollWeaponAttackAction({
    item, rollData: actor.getRollData(), speaker: {}, rollMode: "publicroll", attackId, mode, parryModifiers: [0, 0, 0]
  });
  return { ...env, actor, item, writes, warnings, roll };
}

test("all weapon actions and modes, including NPCs, Weave and multi-target Cleave, pay once before rolling", async () => {
  for (const npc of [false, true]) for (const attack of Object.values(INCARNOS.attackActions)) for (const mode of attack.modes) {
    const env = attackPaymentSetup(3, npc);
    const OriginalRoll = Roll;
    globalThis.Roll = class extends OriginalRoll {
      async evaluate(options) {
        assert.equal(env.actor.system.actionpoints.value, 2, "paid before the first and every subsequent roll");
        return super.evaluate(options);
      }
    };
    const rolls = await env.roll(attack.id, mode);
    assert.equal(rolls.length, attack.multiTarget ? 3 : 1);
    assert.deepEqual(env.writes, [{ "system.actionpoints.value": 2 }]);
    assert.match(env.cards[0].content, /isc-facts">1 AP/);
    assert.match(env.updates[0].content, /isc-facts">1 AP/);
  }
});

test("attacks block before rolling at zero AP; nonparticipants and attacks outside combat are free", async () => {
  const env = attackPaymentSetup(0);
  assert.equal(await env.roll(), undefined);
  assert.deepEqual(env.warnings, ["Attacker has 0 AP left; Attack: Normal needs 1."]);
  assert.equal(env.cards.length, 0);
  assert.equal(env.writes.length, 0);
  game.combats[0].combatants = [];
  assert.equal((await env.roll()).length, 1);
  game.combats[0].combatants = [{ actor: env.actor }];
  game.combats[0].started = false;
  assert.equal((await env.roll()).length, 1);
  assert.equal(env.writes.length, 0);
  assert.doesNotMatch(env.updates[0].content, /\bAP\b/);
});

test("cancelled attack dialogs cost nothing; rejected attacks leave Hindered untouched", async () => {
  const env = attackPaymentSetup(0);
  env.actor.statuses.add("hindered");
  env.actor.toggleStatusEffect = async () => assert.fail("a cancelled/blocked attack must not consume Hindered");
  foundry.applications = { api: { DialogV2: { prompt: async () => null } } };
  await env.item.roll();
  assert.equal(env.writes.length, 0);
  assert.equal(env.warnings.length, 0);
  foundry.applications.api.DialogV2.prompt = async () => ({ attackId: "normal", mode: "melee", enemyParryModifiers: [0] });
  await env.item.roll();
  assert.equal(env.cards.length, 0);
  assert.equal(env.warnings.length, 1);
});

test("quick attack clicks cannot overspend or overwrite AP", async () => {
  const env = attackPaymentSetup(1);
  const results = await Promise.all([env.roll(), env.roll()]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(env.cards.length, 1);
  assert.deepEqual(env.writes, [{ "system.actionpoints.value": 0 }]);
  assert.equal(env.warnings.length, 1);
});

test("GM can confirm a zero-AP NPC attack without reporting an unpaid AP on the card", async () => {
  const env = attackPaymentSetup(0, true);
  const dialogs = [];
  foundry.utils.escapeHTML = value => value;
  foundry.applications = { api: { DialogV2: { confirm: async options => { dialogs.push(options); return true; } } } };
  assert.equal((await env.roll()).length, 1);
  assert.equal(dialogs[0].window.title, "Use anyway?");
  assert.deepEqual(env.writes, []);
  assert.deepEqual(env.warnings, []);
  assert.doesNotMatch(env.updates[0].content, /\bAP\b/);
});

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

test("PvP: a player's weapon hit on another player character deals half damage (rounded down); NPC targets take it all", async () => {
  for (const [targetType, expected] of [["character", 3], ["npc", 7]]) {
    const env = setup([3, 7]);
    const target = { uuid: "Actor.target", type: targetType, hasPlayerOwner: targetType === "character" };
    game.user.targets = new Set([{ name: "Target", document: { texture: { src: "t.webp" } }, actor: target }]);
    await rollWeaponAttackAction({
      item: { name: "Bow", actor: { items: [], type: "character", hasPlayerOwner: true }, system: { attackMode: "ranged", modifier: 0, damage: "1d8" } },
      rollData: { abilities: { dex: { value: 10 } } },
      speaker: {}, rollMode: "publicroll", attackId: "shoot", mode: "ranged", parryModifiers: [0]
    });
    const card = env.updates[0].content;
    assert.match(card, new RegExp(`<b>${expected}</b>`));
    if (targetType === "character") assert.match(card, /PvP ½/);
    else assert.doesNotMatch(card, /PvP/);
  }
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

test("Bloody Claws upgrades Unarmed: a hit carries Bleed 2d6 for 3 turns to Apply; other weapons stay as they are", async () => {
  const talent = { type: "feature", name: "Bloody Claws", system: { bonus: "Unarmed attacks inflict bleeding status:\n2d6 dmg at the beginning of the victim's turn for 3 turns" } };
  for (const [name, upgraded] of [["Unarmed", true], ["Longsword", false]]) {
    const env = setup([3, 2]);
    game.user.targets = new Set();
    await rollWeaponAttackAction({
      item: { name, actor: { items: [talent] }, system: { attackMode: "ranged", modifier: 0, damage: "1d4" } },
      rollData: { abilities: { dex: { value: 10 } } },
      speaker: {}, rollMode: "publicroll", attackId: "shoot", mode: "ranged", parryModifiers: [0]
    });
    const conditions = env.cards[0].flags.incarnos.spellCast.targets[0].conditions;
    const card = env.updates[0].content;
    if (upgraded) {
      assert.deepEqual(conditions, [{ id: "bleed", name: "Bleed 2d6 for 3 turns", tokens: 3, damage: "2d6", label: true }]);
      assert.match(card, />Bleed 2d6 for 3 turns</);
      assert.match(card, /Bloody Claws: Bleed 2d6 for 3 turns/);
    } else {
      assert.deepEqual(conditions, []);
      assert.doesNotMatch(card, /Bloody Claws/);
    }
  }
});
