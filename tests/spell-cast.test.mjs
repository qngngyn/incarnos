import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { applyCastConditions, applySpellResult, castSpell, getTokensInArea, registerSpellCastHooks } from "../module/helpers/spell-cast.mjs";
import { applyAttackConditions, conditionTokens, setConditionTokens } from "../module/helpers/conditions.mjs";
import { parseSpellNote } from "../tools/spell-notes.mjs";

const leafWind = {
  element: "Plants", category: "Heal", check: "No Check", target: "Single Ally", range: "6m",
  duration: "2 turns", cost: "2 Actions, 8 IP", actions: 2, mp: 8,
  effect: "On cast:\nHeals the target by 2d6 + (lvl * 1)\n"
    + "Target gains Regenerating 2: heals 1d6 + (lvl * 1) at the beginning of the target's turn"
};

for (const activationResult of ["document", "already-active"]) {
  test(`Leaf wind auto-applies two Regenerating tokens and caster-level healing (${activationResult})`, { timeout: 2000 }, async () => {
    const hooks = {};
    globalThis.Hooks = { on: (name, callback) => (hooks[name] ??= []).push(callback) };
    registerSpellCastHooks();
    const fire = (name, message) => { for (const callback of hooks[name] ?? []) callback(message); };
    const gm = { id: "gm", isGM: true, active: true };
    const otherGM = { id: "other-gm", isGM: true, active: true };
    const target = { uuid: "Actor.target", name: "Target", effects: [], statuses: new Set() };
    const token = { actor: target, name: target.name, document: { texture: {} } };
    globalThis.game = { user: { ...gm, targets: new Set([token]) }, users: [otherGM, gm], combats: [],
      settings: { get: () => "publicroll" } };
    globalThis.canvas = { tokens: { placeables: [] } };
    globalThis.CONFIG = { sounds: { dice: "dice" } };
    globalThis.foundry = { utils: { deepClone: structuredClone, isEmpty: object => !Object.keys(object).length } };
    globalThis.ui = { notifications: { warn: message => assert.fail(message) } };
    globalThis.fromUuid = async uuid => { assert.equal(uuid, target.uuid); return target; };
    const formulas = [];
    globalThis.Roll = class {
      static validate() { return true; }
      static replaceFormulaData(formula, data) { return formula.replace(/@lvl\b/g, String(data.lvl)); }
      constructor(formula, data) { this.formula = Roll.replaceFormulaData(formula, data); formulas.push(formula); }
      async evaluate() { this.total = 10; this.result = "7 + 3"; return this; }
      toJSON() { return { formula: this.formula, total: this.total }; }
    };
    const flags = { statuscounter: { value: 1, visible: false } };
    let counterPending = false;
    const writes = [];
    const effect = {
      statuses: new Set(["regenerating"]),
      getFlag: (scope, key) => flags[scope]?.[key],
      async setFlag(scope, key, value) {
        assert.equal(counterPending, false, "heal must wait for statusCounter.setValue");
        (flags[scope] ??= {})[key] = value;
        writes.push("heal");
      },
      get statusCounter() {
        return this._statusCounter ??= {
          get displayValue() { return flags.statuscounter.value; },
          async setValue(value) {
            counterPending = true;
            await new Promise(resolve => setImmediate(resolve));
            flags.statuscounter.value = value;
            flags.statuscounter.visible = value > 1;
            counterPending = false;
            writes.push("counter");
          }
        };
      }
    };
    target.toggleStatusEffect = async (id, options) => {
      assert.equal(id, "regenerating");
      assert.deepEqual(options, { active: true });
      // Model preCreateActiveEffect's default of one and an eagerly cached counter.
      assert.equal(effect.statusCounter.displayValue, 1);
      target.effects.push(effect);
      target.statuses.add(id);
      return activationResult === "document" ? effect : true;
    };
    let applied;
    const finished = new Promise(resolve => { applied = resolve; });
    const caster = { name: "Caster", items: [], system: { power: { value: 20 }, attributes: { level: { value: 3 } } },
      getRollData: () => ({}), async update(changes) { assert.deepEqual(changes, { "system.power.value": 12 }); } };
    globalThis.ChatMessage = {
      getSpeaker: () => ({}), applyMode: () => {},
      async create(data) {
        const message = { ...structuredClone(data), id: `leaf-wind-${activationResult}`,
          async update(changes) {
            if ("content" in changes) this.content = changes.content;
            for (const key of ["resolved", "targets"]) {
              const path = `flags.incarnos.spellCast.${key}`;
              if (path in changes) this.flags.incarnos.spellCast[key] = changes[path];
            }
            fire("updateChatMessage", this);
            if (this.flags.incarnos.spellCast.targets[0].appliedConditions) applied();
          }
        };
        assert.equal(data.flags.incarnos.spellCast.autoConditions, true);
        assert.equal(data.flags.incarnos.spellCast.resolved, false);
        assert.deepEqual(data.flags.incarnos.spellCast.targets[0].conditions,
          [{ id: "regenerating", name: "Regenerating", tokens: 2, heal: "1d6 + (3 * 1)" }]);
        fire("createChatMessage", message);
        assert.equal(target.effects.length, 0, "wait for the instant-heal dice to resolve");
        return message;
      }
    };
    const message = await castSpell({ name: "Leaf wind", actor: caster, system: leafWind });
    await finished;
    assert.deepEqual(formulas, ["2d6 + (@lvl * 1)"], "no attack or duration roll is needed");
    assert.equal(message.flags.incarnos.spellCast.resolved, true);
    assert.equal(conditionTokens(target, "regenerating"), 2);
    assert.deepEqual(flags, { statuscounter: { value: 2, visible: true }, incarnos: { heal: "1d6 + (3 * 1)" } });
    assert.deepEqual(writes, ["counter", "heal"]);
    fire("updateChatMessage", message);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(writes, ["counter", "heal"], "later chat updates must not apply the condition twice");
    await applyAttackConditions(target, [{ id: "regenerating", tokens: 2, heal: "1d6 + (4 * 1)" }]);
    assert.equal(conditionTokens(target, "regenerating"), 4, "reapplication adds to the existing tokens");
    assert.equal(flags.incarnos.heal, "1d6 + (4 * 1)", "the newest source's healing wins");
  });
}

test("without statuscounter, new and existing token counts are saved and zero removes the effect", async () => {
  const actor = { effects: [] };
  const flags = {};
  const effect = { statuses: new Set(["regenerating"]), getFlag: (scope, key) => flags[`${scope}.${key}`],
    async update(changes) { for (const [key, value] of Object.entries(changes)) flags[key.replace(/^flags\./, "")] = value; },
    async delete() { actor.effects = []; } };
  actor.toggleStatusEffect = async () => { actor.effects.push(effect); return effect; };
  await setConditionTokens(actor, "regenerating", 2);
  assert.equal(conditionTokens(actor, "regenerating"), 2);
  assert.equal(flags["statuscounter.visible"], true);
  await setConditionTokens(actor, "regenerating", 1);
  assert.equal(conditionTokens(actor, "regenerating"), 1);
  assert.equal(flags["statuscounter.visible"], false);
  await setConditionTokens(actor, "regenerating", 0);
  assert.equal(conditionTokens(actor, "regenerating"), 0);
});

const leafToss = {
  element: "Plants", category: "Attack", check: "Attack Int / Cha (3x)", target: "Enemies" /* several targets per test; counts are tested in spell-targets.test.mjs */, range: "9m",
  duration: "Instant", cost: "2 Actions, 12 IP", actions: 2, mp: 12,
  effect: "On cast:\nFor each successful attack, deal 3d4 + (lvl * 1) earth dmg"
};

/** Deterministic casting through the public flow, with no world documents. */
async function castAttackSpell({ system = leafToss, statuses = [], parries = [14], playerTarget = false, stat = 14, dice, area = false, cancel = false, choice }) {
  const casterWrites = [];
  const consumed = [];
  const caster = { uuid: "Actor.caster", name: "Caster", type: "character", hasPlayerOwner: true, items: [], statuses: new Set(statuses),
    system: { power: { value: 30 }, actionpoints: { value: 3, max: 3 }, attributes: { level: { value: 3 } },
      abilities: { int: { value: stat - 2 }, cha: { value: stat } } }, getRollData: () => ({}),
    async update(changes) { casterWrites.push(changes); },
    async toggleStatusEffect(id, options) { consumed.push({ id, ...options }); this.statuses.delete(id); } };
  const targets = parries.map((parry, index) => ({ uuid: `Actor.target-${index}`, name: `Target ${index}`, type: playerTarget ? "character" : "npc",
    hasPlayerOwner: playerTarget, items: [], statuses: new Set(), effects: [], conditionWrites: [], healthWrites: [], appliedPrompts: {},
    getFlag(scope, key) { return key === "appliedPrompts" ? this.appliedPrompts : undefined; },
    system: { attributes: { parry: { value: parry } }, abilities: { con: { save: 8 }, str: { save: 8 } }, health: { value: 100, max: 100, min: 0 } },
    async toggleStatusEffect(id, options) {
      this.conditionWrites.push({ id, ...options }); this.statuses.add(id);
      const flags = {};
      this.effects.push({ statuses: new Set([id]), getFlag: (scope, key) => flags[`${scope}.${key}`],
        async setFlag(scope, key, value) { flags[`${scope}.${key}`] = value; },
        async update(changes) { for (const [path, value] of Object.entries(changes)) flags[path.replace(/^flags\./, "")] = value; } });
    },
    async update(changes) {
      this.healthWrites.push(changes);
      this.system.health.value = changes["system.health.value"];
      for (const [key, value] of Object.entries(changes)) {
        if (key.startsWith("flags.incarnos.appliedPrompts.")) this.appliedPrompts[key.slice("flags.incarnos.appliedPrompts.".length)] = value;
      }
    } }));
  globalThis.game = { user: { id: "gm", isGM: true, targets: new Set(targets.map(actor => ({ actor, name: actor.name, document: { texture: {} } }))) },
    combats: [{ started: true, combatants: [{ actor: caster }] }], settings: { get: () => "publicroll" } };
  globalThis.canvas = { tokens: { placeables: [] } };
  globalThis.CONFIG = { sounds: { dice: "dice" } };
  globalThis.foundry = { utils: { deepClone: structuredClone, isEmpty: object => !Object.keys(object).length } };
  globalThis.ui = { notifications: { warn: message => assert.fail(message) } };
  const language = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
  game.i18n = { localize: key => language[key] ?? key, format: (key, data) => language[key].replace(/\{(\w+)\}/g, (_, field) => data[field]) };
  const dialogs = [];
  foundry.applications = { api: { DialogV2: { async input(options) {
    assert.deepEqual(casterWrites, [], "the option dialog opens before any cost is paid");
    assert.equal(placements.length, 0, "choose before placing an area");
    dialogs.push(options);
    return choice === null ? null : { option: String(choice) };
  } } } };
  const placements = [];
  if (area) {
    const casterToken = { actor: caster, center: { x: 0, y: 0 }, document: { actorId: caster.id } };
    const tokens = [...game.user.targets].map((token, index) => ({ ...token, center: { x: 300 + index * 100, y: 100 } }));
    canvas.ready = true;
    canvas.dimensions = { distancePixels: 100 };
    canvas.tokens = { placeables: [casterToken, ...tokens], activate: () => {} };
    globalThis.CONST = { REGION_VISIBILITY: { ALWAYS: 0 } };
    ui.notifications.info = () => {};
    canvas.regions = { async placeRegion(data, options) {
      placements.push({ data, options });
      assert.equal(options.create, false);
      if (system.range.includes("(3m x")) {
        assert.equal(options.preConfirm({ shape: { x: 1200, y: 0 } }), undefined, "the placement origin can be at range 12 m");
        const warnings = [];
        ui.notifications.warn = message => warnings.push(message);
        assert.equal(options.preConfirm({ shape: { x: 1201, y: 0 } }), false, "an origin beyond 12 m cannot be confirmed");
        assert.match(warnings[0], /within 12 m/);
        ui.notifications.warn = message => assert.fail(message);
      }
      return cancel ? null : { canUserModify: () => false,
        // The caster and the first two tokens are inside; the third token is outside.
        testPoint: point => point.x < 500 };
    } };
  }
  globalThis.fromUuid = async uuid => targets.find(actor => actor.uuid === uuid);
  const calls = [];
  const queue = [...dice];
  globalThis.Roll = class {
    static validate() { return true; }
    constructor(formula, data) { this.formula = formula.replace(/@lvl\b/g, String(data.lvl)); this.original = formula; }
    async evaluate(options) {
      const expected = queue.shift();
      assert.ok(expected, `unexpected roll ${this.original}`);
      assert.equal(this.original, expected.formula);
      assert.equal(Boolean(options?.maximize), Boolean(expected.maximize));
      calls.push({ formula: this.original, maximize: Boolean(options?.maximize) });
      this.total = expected.total;
      this.result = String(this.total);
      return this;
    }
    toJSON() { return { formula: this.formula, total: this.total }; }
  };
  let pending;
  globalThis.ChatMessage = {
    getSpeaker: () => ({}), applyMode: () => {},
    async create(data) {
      pending = data.content;
      return { ...data, id: "attack-spell", async update(changes) {
        if ("content" in changes) this.content = changes.content;
        for (const key of ["resolved", "targets"]) {
          const path = `flags.incarnos.spellCast.${key}`;
          if (path in changes) this.flags.incarnos.spellCast[key] = changes[path];
        }
      } };
    }
  };
  const message = await castSpell({ name: system.name ?? "Leaf toss", actor: caster, system });
  assert.equal(queue.length, 0, "all expected attacks and damage rolls must happen");
  assert.deepEqual(casterWrites, cancel || choice === null ? [] : [{ "system.actionpoints.value": 3 - system.actions }, { "system.power.value": 30 - system.mp }], "IP/AP paid once for the whole cast");
  return { message, targets, pending, calls, consumed, placements, dialogs, caster };
}

const optionNote = name => parseSpellNote(readFileSync(new URL(`fixtures/${name}.md`, import.meta.url), "utf8"), name).spell;

test("Crystal Shower chooses Spear before rolling and uses only its single-target damage and card", async () => {
  const system = optionNote("crystal-shower");
  const { message, placements, dialogs } = await castAttackSpell({ system, choice: 0,
    dice: [{ formula: "4d6 + (@lvl * 2)", total: 16 }, { formula: "1d20", total: 5 }] });
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].window.title, "Choose how to cast Crystal Shower");
  assert.equal(dialogs[0].rejectClose, false);
  assert.equal((dialogs[0].content.match(/name="option"/g) ?? []).length, 2);
  assert.match(dialogs[0].content, /Spear[\s\S]*9m · Single Target · Attack Int \/ Cha/);
  assert.match(dialogs[0].content, /Needles[\s\S]*Leaves difficult terrain/);
  assert.equal(placements.length, 0);
  assert.match(message.content, /Crystal Shower — Spear/);
  assert.doesNotMatch(message.content, /Needles|2d4|difficult terrain/);
  assert.equal(message.flags.incarnos.spellCast.targets[0].damage, 16);
});

test("choosing Needles replaces range, ground square and damage before area placement", async () => {
  const system = optionNote("crystal-shower");
  const { message, placements } = await castAttackSpell({ system, choice: 1, area: true, parries: [14, 14, 14],
    dice: [{ formula: "2d4 + 1 + (@lvl * 2)", total: 12 }, ...[5, 5, 5].map(total => ({ formula: "1d20", total }))] });
  assert.deepEqual(placements[0].data.shapes, [{ type: "line", x: 0, y: 0, length: 450, width: 450, rotation: 0 }]);
  assert.equal(placements[0].options.allowRotation, true);
  assert.equal(placements[0].options.preConfirm({ shape: { x: 900, y: 0 } }), undefined);
  const warnings = [];
  ui.notifications.warn = text => warnings.push(text);
  assert.equal(placements[0].options.preConfirm({ shape: { x: 901, y: 0 } }), false);
  assert.match(warnings[0], /within 9 m/);
  assert.match(message.content, /Crystal Shower — Needles/);
  assert.match(message.content, /Leaves difficult terrain/);
  assert.doesNotMatch(message.content, /Spear|4d6|Varied/);
  assert.equal(message.flags.incarnos.spellCast.targets.length, 3);
});

test("closing the choice dialog cancels before IP/AP, area placement, rolls or chat", async () => {
  const { message, calls, placements, dialogs } = await castAttackSpell({ system: optionNote("crystal-shower"), choice: null, area: true, dice: [] });
  assert.equal(message, undefined);
  assert.deepEqual(calls, []);
  assert.deepEqual(placements, []);
  assert.equal(dialogs.length, 1);
});

test("Crescent places a transverse 12m line centred at the chosen point within its own 9m range", async () => {
  const { message, placements } = await castAttackSpell({ system: optionNote("darkness-manifestation"), choice: 1, area: true,
    dice: [{ formula: "2d6 + (@lvl *1)", total: 10 }, { formula: "1d20", total: 5 }] });
  const { data, options } = placements[0];
  assert.deepEqual(data.shapes, [{ type: "line", x: 0, y: 0, length: 1200, width: 150, rotation: 0 }]);
  assert.equal(options.allowRotation, false);
  const placed = { ...data.shapes[0], updateSource(changes) { Object.assign(this, changes); } };
  assert.equal(options.onMove({ shape: placed, position: { x: 900, y: 0 } }), false);
  assert.equal(placed.rotation, 90);
  assert.ok(Math.abs(placed.x - 900) < 1e-6);
  assert.equal(placed.y, -600);
  assert.equal(options.preConfirm({ shape: placed }), undefined);
  options.onMove({ shape: placed, position: { x: 901, y: 0 } });
  const warnings = [];
  ui.notifications.warn = text => warnings.push(text);
  assert.equal(options.preConfirm({ shape: placed }), false);
  assert.match(warnings[0], /within 9 m/);
  assert.match(message.content, /Darkness Manifestation — Crescent/);
  assert.doesNotMatch(message.content, /Spiked Ball|4d6/);
});

test("cancelling placement after an option choice also costs nothing", async () => {
  const { message, dialogs, placements } = await castAttackSpell({ system: optionNote("crystal-shower"), choice: 1, area: true, cancel: true, dice: [] });
  assert.equal(message, undefined);
  assert.equal(dialogs.length, 1);
  assert.equal(placements.length, 1);
});

test("the same spell asks again on the next cast, and cancelling that choice spends nothing", async () => {
  const system = optionNote("shadow-play");
  const { caster, message } = await castAttackSpell({ system, choice: 0, dice: [{ formula: "1d20", total: 5 }] });
  assert.match(message.content, /Shadow Play — Taunt/);
  assert.doesNotMatch(message.content, /Knife Throw|Flower Bouquet|4d4/);
  caster.update = () => assert.fail("a cancelled repeat cast spent resources");
  let prompted = false;
  foundry.applications.api.DialogV2.input = async ({ content }) => { prompted = true; assert.match(content, /Flower Bouquet/); return null; };
  assert.equal(await castSpell({ name: "Shadow Play", system, actor: caster }), undefined);
  assert.equal(prompted, true);
});

test("option dialogs escape names, facts and rules text", async () => {
  const system = { ...optionNote("shadow-play"), range: '<range> & "facts"',
    effect: 'Pick one:\nFirst: <script>bad()</script> & "rules"\nSecond: Heal 1d6' };
  const { dialogs } = await castAttackSpell({ system, choice: null, dice: [] });
  assert.doesNotMatch(dialogs[0].content, /<script>|<range>/);
  assert.match(dialogs[0].content, /&lt;range&gt; &amp; &quot;facts&quot;/);
  assert.match(dialogs[0].content, /&lt;script&gt;bad\(\)&lt;\/script&gt; &amp; &quot;rules&quot;/);
});

const ivyVines = { ...leafToss, check: "Attack Int / Cha", target: "Ground", range: "12m (3m x 1,5m)", duration: "2 turns",
  effect: "On cast: Summons ivy vines from the ground that occupy the space they grow from\n"
    + "On hit: Target is immobilized (cannot use Movement actions). The target can use an action to break out." };

test("Ivy vines places a rotatable rectangle and rolls on everyone inside, including the caster; only hits gain two timed tokens", async () => {
  const { message, targets, placements } = await castAttackSpell({ system: ivyVines, area: true, parries: [14, 14, 14],
    dice: [5, 5, 20].map(total => ({ formula: "1d20", total })) });
  assert.deepEqual(placements[0].data.shapes, [{ type: "line", x: 0, y: 0, length: 300, width: 150, rotation: 0 }]);
  assert.equal(placements[0].options.allowRotation, true);
  assert.equal(placements[0].options.onMove, undefined, "a placed rectangle can move freely instead of following the caster");
  const results = message.flags.incarnos.spellCast.targets;
  assert.equal(results.length, 3, "caster and two area targets; the third targeted token outside is ignored");
  const condition = { id: "immobilized", name: "Immobilized", tokens: 2, timed: true };
  assert.deepEqual(results.map(result => result.conditions), [[condition], [condition], []]);
  await applyCastConditions(message);
  assert.equal(conditionTokens(targets[0], "immobilized"), 2);
  assert.equal(targets[0].effects[0].getFlag("incarnos", "timed"), true);
  assert.deepEqual(targets[1].conditionWrites, [], "a miss applies nothing");
  assert.deepEqual(targets[2].conditionWrites, [], "outside the area applies nothing");
});

test("cancelling rectangle placement spends no resources and rolls nothing", async () => {
  const { message } = await castAttackSpell({ system: ivyVines, area: true, cancel: true, dice: [] });
  assert.equal(message, undefined);
});

test("Crystal Trap requires a hit and failed Strength save, and applies indefinite Immobilized", async () => {
  const system = { ...leafToss, check: "Attack Dex, Target Save Str+2", duration: "Instant",
    effect: "On hit: Target is immobilized (cannot use Movement actions). The target can use an action to break out (still immobilized when failed). Each attempt gives +2 for the next one." };
  const { message, targets } = await castAttackSpell({ system, parries: [14, 14, 14], dice: [
    // Dex is zero in this fixture: natural 1 hits; monster Strength save threshold is 8 - 2 = 6.
    { formula: "1d20", total: 1 }, { formula: "1d20", total: 7 },
    { formula: "1d20", total: 1 }, { formula: "1d20", total: 6 },
    { formula: "1d20", total: 20 }
  ] });
  assert.deepEqual(message.flags.incarnos.spellCast.targets.map(result => result.conditions), [
    [{ id: "immobilized", name: "Immobilized", timed: false }], [], []
  ]);
  await applyCastConditions(message);
  assert.equal(conditionTokens(targets[0], "immobilized"), 1);
  assert.equal(targets[0].effects[0].getFlag("incarnos", "timed"), false);
  assert.deepEqual(targets[1].conditionWrites, [], "a successful save negates Immobilized");
  assert.deepEqual(targets[2].conditionWrites, [], "a miss doesn't even roll a save");
});

test("Leaf toss rolls three attacks per target, separate hit damage and a maxed crit; Apply uses each sum once", async () => {
  const damage = "3d4 + (@lvl * 1)";
  const { message, targets, pending } = await castAttackSpell({ parries: [14, 8],
    system: { ...leafToss, effect: `${leafToss.effect}\nTarget is knocked prone` }, dice: [
      { formula: "1d20", total: 8 }, { formula: damage, total: 9 },
      { formula: "1d20", total: 20 },
      { formula: "1d20", total: 1 }, { formula: damage, total: 15, maximize: true },
      { formula: "1d20", total: 17 },
      { formula: "1d20", total: 12 }, { formula: damage, total: 10 },
      { formula: "1d20", total: 11 }, { formula: damage, total: 11 }
    ] });
  assert.deepEqual(message.flags.incarnos.spellCast.targets.map(target => target.damage), [24, 21]);
  assert.deepEqual(message.flags.incarnos.criticalFailureAttack, { actorUuid: "Actor.caster", kind: "spell" });
  assert.match(message.content, /data-incarnos-critical-start/);
  assert.doesNotMatch(pending, /data-incarnos-critical-start/);
  assert.match(message.content, /Attack 1: Hit <small>8\/10/);
  assert.match(message.content, /Attack 1: Miss <small>17\/16/);
  assert.match(message.content, /Attack 3: Hit · nat 1/);
  assert.match(message.content, /15 earth damage \(dice maxed\)/);
  assert.match(message.content, /data-index="0" title="Apply 24 damage"/);
  assert.match(message.content, /data-index="1" title="Apply 21 damage"/);
  assert.doesNotMatch(pending, /Attack [123]:|Total|data-incarnos-spell-apply/);
  await applyCastConditions(message);
  await applyCastConditions(message);
  for (const target of targets) assert.deepEqual(target.conditionWrites, [{ id: "prone", active: true }]);
  await applySpellResult(message, "damage", 0);
  await applySpellResult(message, "all");
  await applySpellResult(message, "all");
  assert.deepEqual(targets.map(target => target.healthWrites.map(write => write["system.health.value"])), [[76], [79]]);
  for (const target of targets) assert.equal(target.conditionWrites.length, 1, "damage application must not repeat conditions");
});

for (const [statuses, formula] of [[[], "1d20"], [["hidden"], "2d20kl"], [["hindered"], "2d20kh"], [["hidden", "hindered"], "1d20"]]) {
  test(`each multi-attack uses caster advantage (${statuses.join(" + ") || "none"}); full misses do no damage or conditions`, async () => {
    const { message, targets, consumed } = await castAttackSpell({ statuses,
      system: { ...leafToss, effect: `${leafToss.effect}\nTarget is knocked prone` },
      dice: [18, 19, 20].map(total => ({ formula, total })) });
    assert.equal(message.flags.incarnos.spellCast.targets[0].damage, 0);
    assert.deepEqual(message.flags.incarnos.spellCast.targets[0].conditions, []);
    await applyCastConditions(message);
    assert.deepEqual(targets[0].conditionWrites, []);
    assert.deepEqual(consumed, statuses.includes("hindered") ? [{ id: "hindered", active: false }] : []);
    assert.doesNotMatch(message.content, /data-incarnos-spell-apply/);
  });
}

test("each hit's PvP damage is halved before summing; natural 20 misses even above threshold 20", async () => {
  const damage = "3d4 + (@lvl * 1)";
  const { message } = await castAttackSpell({ playerTarget: true, stat: 30, dice: [
    { formula: "1d20", total: 19 }, { formula: damage, total: 9 },
    { formula: "1d20", total: 20 },
    { formula: "1d20", total: 1 }, { formula: damage, total: 15, maximize: true }
  ] });
  assert.equal(message.flags.incarnos.spellCast.targets[0].damage, 11);
  assert.match(message.content, /Attack 2: Miss · nat 20 <small>20\/26/);
  assert.match(message.content, /PvP ½/);
});

test("multi-attacks preserve target saves and apply a save-negated condition once if any hit was not saved", async () => {
  const { message } = await castAttackSpell({ parries: [40], system: { ...leafToss,
    check: "Attack Int / Cha (3x), Target Save Con", effect: "On hit: Deal 3d4 earth dmg (half dmg when save succeeded)\nTarget is knocked prone (none when save succeeded)" }, dice: [
    { formula: "1d20", total: 1 }, { formula: "1d20", total: 5 }, { formula: "3d4", total: 12, maximize: true },
    { formula: "1d20", total: 1 }, { formula: "1d20", total: 15 }, { formula: "3d4", total: 12, maximize: true },
    { formula: "1d20", total: 2 }
  ] });
  const target = message.flags.incarnos.spellCast.targets[0];
  assert.equal(target.damage, 18);
  assert.deepEqual(target.conditions, [{ id: "prone", name: "Prone" }]);
  assert.match(message.content, /Attack 1: Hit · nat 1 <small>1\/-16/);
  assert.match(message.content, /Saved <small>5\/8/);
  assert.match(message.content, /Failed save <small>15\/8/);
});

test("single-attack spells keep their shared damage roll and existing card layout", async () => {
  const { message } = await castAttackSpell({ system: { ...leafToss, check: "Attack Int / Cha" }, parries: [14, 8], dice: [
    { formula: "3d4 + (@lvl * 1)", total: 9 },
    { formula: "1d20", total: 8 }, { formula: "1d20", total: 12 }
  ] });
  assert.deepEqual(message.flags.incarnos.spellCast.targets.map(target => target.damage), [9, 9]);
  assert.doesNotMatch(message.content, /Attack [123]:|>Total</);
  assert.match(message.content, /Hit <small>8\/10/);
});


/** Minimal plain-spell casting fixture: resources and UI only, no live world. */
async function castResourceSpell({ cost = "2 Actions, 12 IP", mp = 12, available = 30, hpMagic = false, input = null, ap = null, gm = false, override = false } = {}) {
  const writes = [], warnings = [], dialogs = [];
  const actor = { uuid: "Actor.caster", name: "Caster", testUserPermission: () => true, items: hpMagic ? [{ type: "race", name: "Abomination",
    system: { bonus: "You have no IP. Instead gain HP and all spells use HP." } }] : [],
    system: { power: { value: hpMagic ? 0 : available }, health: { value: available }, actionpoints: { value: ap ?? 3, max: 3 } },
    getRollData: () => ({}), async update(changes) {
      writes.push(changes);
      if ("system.actionpoints.value" in changes) this.system.actionpoints.value = changes["system.actionpoints.value"];
    } };
  const strings = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url)));
  globalThis.game = { user: { isGM: gm, targets: new Set() }, combats: ap === null ? [] : [{ started: true, combatants: [{ actor }] }],
    settings: { get: () => "publicroll" }, i18n: { localize: key => strings[key], format: (key, data) => strings[key].replace(/\{(\w+)\}/g, (_, field) => data[field]) } };
  globalThis.canvas = { tokens: { placeables: [] } };
  globalThis.CONFIG = { sounds: {} };
  globalThis.ui = { notifications: { warn: message => warnings.push(message) } };
  globalThis.foundry = { utils: { isEmpty: object => !Object.keys(object).length, escapeHTML: value => value },
    applications: { api: { DialogV2: {
      async input(options) { dialogs.push(options); return input; },
      async confirm(options) { dialogs.push(options); return override; }
    } } } };
  globalThis.ChatMessage = { getSpeaker: () => ({}), applyMode: () => {}, async create(data) { return data; } };
  const message = await castSpell({ name: "Plain spell", actor, system: { cost, mp, actions: 2 } });
  return { message, writes, warnings, dialogs };
}

test("fixed IP costs spend the existing Incarna pool and chat uses IP for legacy text too", async () => {
  for (const unit of ["IP", "MP", "PP"]) {
    const { message, writes, warnings, dialogs } = await castResourceSpell({ cost: "2 Actions, 12 " + unit });
    assert.deepEqual(writes, [{ "system.power.value": 18 }]);
    assert.deepEqual(warnings, []);
    assert.deepEqual(dialogs, []);
    assert.match(message.content, /12 IP/);
    assert.doesNotMatch(message.content, /\b(?:MP|PP)\b/);
  }
});

test("spells use the shared AP check and GM override without paying IP on rejection", async () => {
  const blocked = await castResourceSpell({ ap: 1 });
  assert.equal(blocked.message, undefined);
  assert.deepEqual(blocked.writes, []);
  assert.deepEqual(blocked.warnings, ["Caster has 1 AP left; Plain spell needs 2."]);
  for (const override of [false, true]) {
    const result = await castResourceSpell({ ap: 1, gm: true, override });
    assert.equal(result.dialogs[0].window.title, "Use anyway?");
    assert.deepEqual(result.writes, override ? [{ "system.actionpoints.value": 0 }, { "system.power.value": 18 }] : []);
    if (override) assert.match(result.message.content, /title="Paid">12 IP · 1 AP/);
    else assert.equal(result.message, undefined);
  }
});

test("variable IP and legacy costs prompt for IP and pay the entered amount once", async () => {
  for (const unit of ["IP", "MP", "PP"]) {
    for (const cost of ["X * 8 " + unit, "3 " + unit + " times 4d4"]) {
      const { message, writes, dialogs } = await castResourceSpell({ cost, mp: 0, input: { actions: 2, mp: 16 } });
      assert.equal(dialogs.length, 1);
      assert.match(dialogs[0].content, /<label>IP<\/label>/);
      assert.match(dialogs[0].content, /name="mp"/);
      assert.doesNotMatch(dialogs[0].content, /\b(?:MP|PP)\b/);
      assert.deepEqual(writes, [{ "system.power.value": 14 }]);
      assert.match(message.content, /16 IP/);
    }
  }
});

test("insufficient Incarna warns with IP amounts and makes no payment or chat card", async () => {
  const { message, writes, warnings } = await castResourceSpell({ available: 5 });
  assert.equal(message, undefined);
  assert.deepEqual(writes, []);
  assert.deepEqual(warnings, ["Not enough Incarna: Caster has 5 IP; Plain spell costs 12 IP."]);
});

test("Abomination pays an IP spell cost from HP and the card shows HP", async () => {
  const { message, writes, warnings } = await castResourceSpell({ hpMagic: true });
  assert.deepEqual(writes, [{ "system.health.value": 18 }]);
  assert.deepEqual(warnings, []);
  assert.match(message.content, /title="Paid">12 HP/);
  const insufficient = await castResourceSpell({ hpMagic: true, available: 5 });
  assert.deepEqual(insufficient.writes, []);
  assert.deepEqual(insufficient.warnings, ["Not enough HP: Caster has 5 HP; Plain spell costs 12 HP."]);
});

test("area spells never hit invisible tokens (hidden from players); visible ones inside the area are hit", () => {
  const area = { testPoint: ({ x }) => x < 100 };
  const token = (name, x, hidden = false) => ({ name, actor: {}, center: { x, y: 0 }, document: { hidden, elevation: 0 } });
  const hit = getTokensInArea(area, [token("Seen", 50), token("Invisible", 50, true), token("Outside", 150)]);
  assert.deepEqual(hit.map(entry => entry.name), ["Seen"]);
});

test("Who let the apes out (Thunder): a hit with a failed save adds +2d4 and Paralyzed; a save or miss doesn't", async () => {
  const system = { ...leafToss, name: "Who let the apes out? Thunder Version", element: "Thunder", check: "Attack Int / Cha, Target Save Con",
    target: "Up to 3 Enemies", range: "6m", cost: "2 Actions, 10 IP", actions: 2, mp: 10,
    effect: "On hit: 2d4 + (lvl * 2) fire dmg\nLaunches targets into the air (none when Save succeeded), making them paralyzed and take additional 2d4 fire dmg when hit" };
  const { message, pending } = await castAttackSpell({ system, parries: [14, 14, 14], dice: [
    { formula: "2d4 + (@lvl * 2)", total: 8 }, { formula: "2d4", total: 5 },
    { formula: "1d20", total: 5 }, { formula: "1d20", total: 15 },
    { formula: "1d20", total: 5 }, { formula: "1d20", total: 3 },
    { formula: "1d20", total: 20 }
  ] });
  const results = message.flags.incarnos.spellCast.targets;
  assert.deepEqual(results.map(result => result.damage), [13, 8, 0]);
  assert.deepEqual(results.map(result => result.conditions.map(condition => condition.id)), [["paralyzed"], [], []]);
  // The card marks the included extra damage on the target that failed its save, and only there.
  assert.equal((message.content.match(/Included extra damage on a failed save: 2d4 = 5 fire/g) ?? []).length, 1);
});
