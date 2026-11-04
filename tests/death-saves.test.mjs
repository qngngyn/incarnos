import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { deathSaveCharacters, deathSaveResult, deathSaveTally, emptyDeathSaves, healthTransition, unshownDeathSaves } from "../module/helpers/death-save-rules.mjs";
import { applyHealthChange, conditionTokens, markDead, registerConditionHooks, setConditionTokens, startOfTurn } from "../module/helpers/conditions.mjs";
import { applyUnconscious, deathSave, handleDyingHealth, processDeathSaveRequest, registerDeathSaveHooks, rollDeathSave, showDeathSave } from "../module/helpers/death-saves.mjs";
import { changeActions, getActionState } from "../module/helpers/action-tracker.mjs";
import { acceptSummonedCounter, syncSummoned, tickSummons } from "../module/helpers/summon-lifecycle.mjs";
import { deathSaveMacroDocuments } from "../tools/death-save-macro.mjs";
import { criticalFailureMacroDocuments } from "../tools/critical-failure-notes.mjs";

const strings = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
const get = (object, path) => object?.[path] ?? path.split(".").reduce((value, key) => value?.[key], object);
function set(object, path, value) {
  const keys = path.split("."), last = keys.pop();
  for (const key of keys) object = object[key] ??= {};
  object[last] = structuredClone(value);
}
const flush = () => new Promise(resolve => setImmediate(resolve));

function setup() {
  const gm = { id: "a-gm", isGM: true, active: true }, other = { id: "z-gm", isGM: true, active: true };
  const player = { id: "player", isGM: false, active: true };
  const hooks = {}, documents = new Map(), warnings = [], dice = [];
  const emit = (name, ...args) => { for (const callback of hooks[name] ?? []) callback(...args); };
  globalThis.Hooks = { once() {}, on(name, callback) { (hooks[name] ??= []).push(callback); } };
  globalThis.CONFIG = { specialStatusEffects: { DEFEATED: "dead" } };
  globalThis.foundry = { utils: { getProperty: get,
    setProperty: (object, path, value) => path in object ? object[path] = value : set(object, path, value),
    hasProperty: (object, path) => get(object, path) !== undefined } };
  globalThis.game = { user: gm, users: [gm, other, player], actors: [], combats: [], scenes: [], messages: new Map(),
    i18n: { localize: key => strings[key] ?? key, format: (key, data) => (strings[key] ?? key).replace(/\{(\w+)\}/g, (_, key) => data[key]) } };
  globalThis.ui = { notifications: { warn: text => warnings.push(text), info() {}, error: text => { throw new Error(text); } } };
  globalThis.canvas = { scene: { tokens: [] } };
  globalThis.fromUuid = async uuid => documents.get(uuid);
  globalThis.Roll = class { constructor(formula) { this.formula = formula; } async evaluate() { this.total = dice.shift(); return this; } };
  globalThis.ChatMessage = { getSpeaker: ({ actor }) => ({ actor: actor.id }), async create(data, options) {
    const message = { ...structuredClone(data), id: `message-${game.messages.size}`, timestamp: game.messages.size,
      author: game.user, options, async update(changes) { for (const [path, value] of Object.entries(changes)) set(this, path, value); emit("updateChatMessage", this); },
      async delete() { game.messages.delete(this.id); } };
    game.messages.set(message.id, message);
    // Requests are processed explicitly in delegation tests.
    return message;
  } };
  registerConditionHooks();
  function actor({ type = "character", hp = 10, name = "Test <hero>" } = {}) {
    const result = { id: `actor-${documents.size}`, uuid: `Actor.${documents.size}`, type, name, statuses: new Set(), effects: [], flags: {},
      system: { health: { value: hp, min: 0, max: 30 }, actionpoints: { value: 3, max: 3 } },
      testUserPermission: user => user.isGM || user.id === player.id,
      getFlag(scope, key) { return this.flags[scope]?.[key]; },
      async setFlag(scope, key, value) { return this.update({ [`flags.${scope}.${key}`]: value }); },
      async update(changes, options = {}) {
        // Foundry strips unchanged HP from its diff; damage at zero must survive in options.
        changes = Object.fromEntries(Object.entries(changes).filter(([path, value]) => !Object.is(get(this, path), value)));
        emit("preUpdateActor", this, changes, options, game.user.id);
        for (const [path, value] of Object.entries(changes)) set(this, path, value);
        emit("updateActor", this, changes, options, game.user.id);
      },
      async toggleStatusEffect(id, { active = true } = {}) {
        const old = this.effects.find(effect => effect.statuses.has(id));
        if (!active) return old?.delete();
        if (old) return true;
        const effect = { parent: this, statuses: new Set([id]), flags: {},
          getFlag(scope, key) { return this.flags[scope]?.[key]; },
          async update(changes) { for (const [path, value] of Object.entries(changes)) set(this, path, value); },
          async delete() { result.effects = result.effects.filter(entry => entry !== this); result.statuses.delete(id); } };
        this.effects.push(effect); this.statuses.add(id);
        emit("createActiveEffect", effect);
        return true;
      } };
    documents.set(result.uuid, result); game.actors.push(result);
    return result;
  }
  return { gm, other, player, actor, hooks, emit, documents, warnings, dice };
}

test("death saves use roll-under boundaries, natural 1 healing and natural 20 double failure", () => {
  for (const d20 of [1, 10, 11, 20]) {
    const result = deathSaveResult({}, d20);
    assert.equal(result.success, d20 <= 10);
    assert.equal(result.successes, d20 <= 10 ? 1 : 0);
    assert.equal(result.failures, d20 === 20 ? 2 : d20 > 10 ? 1 : 0);
    assert.equal(result.heal, d20 === 1 ? 1 : 0);
  }
  assert.equal(deathSaveResult({ successes: 2 }, 10).outcome, "stabilized");
  assert.equal(deathSaveResult({ failures: 2 }, 11).outcome, "dead");
  assert.equal(deathSaveResult({ failures: 1 }, 20).outcome, "dead");
  assert.equal(deathSaveResult({ successes: 2 }, 1).outcome, "healed");
  assert.equal(deathSaveResult({ failures: 2 }).outcome, "dead", "damage is one failure");
  assert.equal(deathSaveTally({ successes: 2, failures: 1 }), "✓✓✗");
  assert.throws(() => deathSaveResult({}, 0));
  assert.throws(() => deathSaveResult({}, 21));
});

test("0 HP transition is character-only, excludes defeated and Bleed, and healing resets", () => {
  const transition = { type: "character", before: 4, after: 0, dying: false };
  assert.equal(healthTransition(transition), "dying");
  for (const type of ["npc", "monster", "vehicle"]) assert.equal(healthTransition({ ...transition, type }), null);
  assert.equal(healthTransition({ ...transition, dead: true }), null);
  assert.equal(healthTransition({ ...transition, bledOut: true }), null);
  assert.equal(healthTransition({ ...transition, before: 0 }), null, "stable at 0 stays stable");
  assert.equal(healthTransition({ ...transition, before: 0, after: -1, dying: true }), "failure");
  assert.equal(healthTransition({ ...transition, before: 0, damage: true, dying: true }), "failure");
  assert.equal(healthTransition({ ...transition, before: 0, after: 1, dying: true }), "heal");
});

test("sheet HP updates add Dying and Prone, cap AP and heal without standing up or refunding AP", async () => {
  const f = setup(), actor = f.actor();
  await actor.update({ "system.health.value": 0 }); await flush();
  assert.deepEqual([...actor.statuses].sort(), ["dying", "prone"]);
  assert.equal(actor.system.actionpoints.value, 1);
  assert.deepEqual(getActionState(actor), { max: 1, value: 1 });
  await actor.update({ "system.actionpoints.value": 9 });
  assert.equal(actor.system.actionpoints.value, 1, "manual AP cannot exceed the cap");
  await changeActions(actor, "spend"); await changeActions(actor, "reset");
  assert.equal(actor.system.actionpoints.value, 1);
  await actor.toggleStatusEffect("unconscious", { active: true });
  await actor.setFlag("incarnos", "deathSaves", { successes: 1, failures: 2, rolls: [1] });
  await actor.update({ "system.health.value": 3 }); await flush();
  assert.deepEqual([...actor.statuses], ["prone"]);
  assert.deepEqual(actor.getFlag("incarnos", "deathSaves"), emptyDeathSaves());
  assert.equal(actor.system.actionpoints.value, 1);
  await changeActions(actor, "reset");
  assert.equal(actor.system.actionpoints.value, 3);
  for (const type of ["npc", "monster"]) {
    const npc = f.actor({ type }); await npc.update({ "system.health.value": 0 }); await flush();
    assert.equal(npc.statuses.size, 0);
  }
  const defeated = f.actor(); await markDead(defeated);
  await defeated.update({ "system.health.value": 0 }); await flush();
  assert.equal(defeated.statuses.has("dying"), false);
});

test("only the elected writer reacts to player HP edits, with owner fallback when no GM is online", async () => {
  const f = setup(), actor = f.actor();
  game.user = f.player;
  const options = {};
  f.emit("preUpdateActor", actor, { "system.health.value": 0 }, options);
  actor.system.health.value = 0;
  f.emit("updateActor", actor, {}, options, f.player.id); await flush();
  assert.equal(actor.statuses.has("dying"), false);
  game.user = f.other; f.emit("updateActor", actor, {}, options, f.player.id); await flush();
  assert.equal(actor.statuses.has("dying"), false);
  game.user = f.gm; f.emit("updateActor", actor, {}, options, f.player.id); await flush();
  assert.equal(actor.statuses.has("dying"), true);
  const fallback = f.actor(); game.users = [f.player]; game.user = f.player;
  await fallback.update({ "system.health.value": 0 }); await flush();
  assert.equal(fallback.statuses.has("dying"), true);
});

test("Apply at clamped zero and negative HP edits count once; replay and zero damage do not", async () => {
  const f = setup(), actor = f.actor();
  await applyHealthChange(actor, "first", "damage", 30);
  assert.equal(actor.getFlag("incarnos", "deathSaves").failures, 0);
  await applyHealthChange(actor, "second", "damage", 4);
  assert.equal(actor.getFlag("incarnos", "deathSaves").failures, 1);
  assert.equal(await applyHealthChange(actor, "second", "damage", 4), false); await flush();
  await applyHealthChange(actor, "zero", "damage", 0); await flush();
  assert.equal(actor.getFlag("incarnos", "deathSaves").failures, 1);
  await actor.update({ "system.health.value": -1 }); await flush();
  assert.equal(actor.getFlag("incarnos", "deathSaves").failures, 2);
  const notes = [...game.messages.values()];
  assert.equal(notes.length, 2);
  assert.ok(notes.every(message => message.blind && !message.whisper.includes(f.player.id)));
  assert.match(notes[0].content, /Damage while Dying/);
});

test("start-of-turn Burn causes Dying and a GM reminder; Bleed kills without Dying", async () => {
  const f = setup(), actor = f.actor({ hp: 2 });
  await setConditionTokens(actor, "burn", 2);
  await startOfTurn(actor); await flush();
  assert.equal(actor.statuses.has("dying"), true);
  const reminder = [...game.messages.values()].find(message => message.flags?.incarnos?.deathSaveReminder);
  assert.match(reminder.content, /is dying: roll a death save/);
  assert.match(reminder.content, /data-incarnos-death-roll/);
  assert.deepEqual(reminder.whisper, [f.gm.id, f.other.id]);
  assert.equal(actor.getFlag("incarnos", "deathSaves").rolls.length, 0, "reminder does not roll");
  const bleeding = f.actor({ hp: 2 }); await setConditionTokens(bleeding, "bleed", 2);
  await startOfTurn(bleeding); await flush();
  assert.equal(bleeding.statuses.has("dead"), true);
  assert.equal(bleeding.statuses.has("dying"), false);
  assert.equal(bleeding.getFlag("incarnos", "deathSaves"), undefined);
});

test("hidden rolls stabilize on three successes, can be shown once, and only GMs apply Unconscious", async () => {
  const f = setup(), actor = f.actor();
  await actor.update({ "system.health.value": 0 }); await flush();
  f.dice.push(10, 10, 10);
  const first = await rollDeathSave(actor); await rollDeathSave(actor); const third = await rollDeathSave(actor);
  assert.equal(actor.statuses.has("dying"), false);
  assert.equal(actor.system.health.value, 0);
  assert.equal(actor.statuses.has("prone"), true);
  assert.equal(third.blind, true); assert.deepEqual(third.whisper, [f.gm.id, f.other.id]);
  assert.equal(third.rolls, undefined, "no dice document goes to animation listeners");
  assert.match(third.content, /✓✓✓/); assert.doesNotMatch(third.content, /<hero>/);
  const shownFirst = await showDeathSave(first);
  assert.doesNotMatch(shownFirst.content, /data-incarnos-unconscious/);
  const [shown] = await Promise.all([showDeathSave(third), showDeathSave(third)]);
  assert.deepEqual(shown.whisper, []); assert.equal(shown.blind, false);
  assert.equal(third.flags.incarnos.deathSave.shown, true);
  assert.equal(await showDeathSave(third), false);
  assert.match(shown.content, /data-incarnos-unconscious/);
  game.user = f.player;
  assert.equal(await applyUnconscious(shown), false);
  assert.equal(await rollDeathSave(actor), false);
  await deathSave(); assert.match(f.warnings.at(-1), /Only GMs/);
  game.user = f.gm;
  assert.deepEqual(await Promise.all([applyUnconscious(shown), applyUnconscious(shown)]), [true, false]);
  assert.equal(await applyUnconscious(shown), false);
  assert.match(shown.content, /data-incarnos-unconscious disabled/);
  assert.equal(actor.statuses.has("unconscious"), true);
});

test("nat 1 heals and resets saves while preserving hidden history; nat 20 and damage can kill", async () => {
  const f = setup(), actor = f.actor();
  await actor.update({ "system.health.value": 0 }); await flush();
  f.dice.push(11, 1);
  await rollDeathSave(actor); const healed = await rollDeathSave(actor); await flush();
  assert.equal(actor.system.health.value, 1);
  assert.equal(actor.statuses.has("dying"), false);
  assert.deepEqual(actor.getFlag("incarnos", "deathSaves"), emptyDeathSaves());
  assert.equal(unshownDeathSaves(game.messages.values()).length, 2);
  assert.equal(healed.flags.incarnos.deathSave.successes, 1);
  await actor.update({ "system.health.value": 0 }); await flush();
  f.dice.push(20, 11);
  await rollDeathSave(actor); await rollDeathSave(actor);
  assert.equal(actor.getFlag("incarnos", "deathSaves").failures, 3);
  assert.equal(actor.statuses.has("dead"), true);
  assert.equal(actor.statuses.has("dying"), false);
  const damaged = f.actor(); await damaged.update({ "system.health.value": 0 }); await flush();
  for (const key of ["a", "b", "c"]) { await applyHealthChange(damaged, key, "damage", 2); await flush(); }
  assert.equal(damaged.statuses.has("dead"), true);
});

test("GM delegation authenticates the author and serializes concurrent saves on the elected GM", async () => {
  const f = setup(), actor = f.actor();
  await actor.update({ "system.health.value": 0 }); await flush();
  game.user = f.other; const request = await rollDeathSave(actor);
  assert.equal(actor.getFlag("incarnos", "deathSaves").rolls.length, 0);
  game.user = f.gm; f.dice.push(10);
  await Promise.all([processDeathSaveRequest(request), processDeathSaveRequest(request)]);
  assert.equal(actor.getFlag("incarnos", "deathSaves").successes, 1);
  const forged = { id: "forged", author: f.player, flags: { incarnos: { deathSaveRequest: { action: "roll", target: actor.uuid } } } };
  assert.equal(await processDeathSaveRequest(forged), false);
  f.dice.push(11, 11);
  await Promise.all([rollDeathSave(actor), rollDeathSave(actor)]);
  assert.equal(actor.getFlag("incarnos", "deathSaves").failures, 2);
});

test("dialog lists scene and active-combat characters once, Dying first, and only unshown results newest first", () => {
  const f = setup(), scene = f.actor({ name: "A" }), combat = f.actor({ name: "Z" }), absent = f.actor({ name: "Absent" }), npc = f.actor({ type: "npc" });
  combat.statuses.add("dying");
  assert.deepEqual(deathSaveCharacters([{ actor: scene }, { actor: npc }, { actor: scene }], [{ actor: combat }, { actor: scene }]), [combat, scene]);
  assert.ok(!deathSaveCharacters([{ actor: scene }]).includes(absent));
  const entry = (id, timestamp, shown = false, publicCard = false) => ({ id, timestamp,
    flags: { incarnos: { deathSave: { shown }, ...(publicCard ? { deathSavePublic: "private" } : {}) } } });
  const old = entry("old", 1), recent = entry("recent", 3);
  assert.deepEqual(unshownDeathSaves([old, entry("shown", 4, true), recent, entry("public", 5, false, true), { flags: {} }]), [recent, old]);
});

test("the GM tool opens one DialogV2 with Roll and Show tabs without combat and respects frozen options", async () => {
  const f = setup(), actor = f.actor({ name: "Dying <hero>" });
  actor.statuses.add("dying"); canvas.scene.tokens.push({ actor });
  const instances = [];
  class Dialog {
    constructor(options) {
      this.options = Object.freeze(options); this.events = {};
      this.content = { innerHTML: options.content, querySelectorAll: () => [] };
      this.element = { querySelector: () => this.content, querySelectorAll: () => [] };
      instances.push(this);
    }
    addEventListener(name, callback) { this.events[name] = callback; }
    render() { this.rendered = true; this.events.render(); return this; }
    bringToFront() { this.focused = true; return this; }
  }
  foundry.applications = { api: { DialogV2: Dialog } };
  const tool = await deathSave();
  assert.match(tool.options.content, /data-death-tab="roll"/);
  assert.match(tool.options.content, /data-death-tab="show"/);
  assert.match(tool.options.content, /Dying &lt;hero&gt;/);
  assert.match(tool.options.content, /0 successes \/ 0 failures/);
  await deathSave(); assert.equal(instances.length, 1); assert.equal(tool.focused, true);
  registerDeathSaveHooks(); f.emit("updateActor", actor, {}, {}, f.gm.id);
  assert.match(tool.content.innerHTML, /Roll hidden death save/);
  tool.rendered = false;
});

test("public Unconscious controls are removed for players and stale buttons cannot knock out a healed actor", async () => {
  const f = setup(), actor = f.actor({ hp: 5 });
  const data = { actorUuid: actor.uuid, actorName: actor.name, successes: 3, failures: 0, d20: 10, outcome: "stabilized", shown: true };
  const message = await ChatMessage.create({ flags: { incarnos: { deathSavePublic: "private", deathSave: data } } });
  assert.equal(await applyUnconscious(message), false);
  registerDeathSaveHooks(); game.user = f.player;
  const button = { remove() { this.removed = true; } };
  f.emit("renderChatMessageHTML", message, { querySelectorAll: () => [button] });
  assert.equal(button.removed, true);
});

test("Death Save macro has stable IDs, the requested image and GM ownership; importer keeps both macros", () => {
  const [macro] = deathSaveMacroDocuments();
  assert.deepEqual(deathSaveMacroDocuments(), [macro]);
  assert.equal(macro._key, `!macros!${macro._id}`);
  assert.equal(macro.name, "Death Save"); assert.equal(macro.command, "await game.incarnos.deathSave();");
  assert.equal(macro.img, "tokens/items/death-save.webp"); assert.equal(macro.ownership.default, 0);
  const generated = JSON.parse(readFileSync(new URL("../packs/_source/macros/macros.json", import.meta.url), "utf8"));
  assert.deepEqual(generated, [...criticalFailureMacroDocuments(), macro]);
});

test("summon counter belongs to the synthetic actor, follows turnsLeft and accepts GM HUD changes", async () => {
  const f = setup(), actor = f.actor({ type: "npc" }), base = f.actor({ type: "npc" });
  const token = { actor, flags: { incarnos: { summon: { casterUuid: "Actor.caster", turnsLeft: 10 } } },
    async update(changes) { for (const [path, value] of Object.entries(changes)) set(this, path, value); } };
  actor.isToken = true; actor.token = token;
  await syncSummoned(token);
  assert.equal(conditionTokens(actor, "summoned"), 10); assert.equal(base.statuses.size, 0);
  await token.update({ "flags.incarnos.summon.turnsLeft": 9 }); await syncSummoned(token);
  assert.equal(conditionTokens(actor, "summoned"), 9);
  const effect = actor.effects[0];
  await effect.update({ "flags.statuscounter.value": 6 });
  await acceptSummonedCounter(effect, { "flags.statuscounter.value": 6 }, {}, f.gm.id);
  assert.equal(token.flags.incarnos.summon.turnsLeft, 6);
  await acceptSummonedCounter(effect, { flags: { statuscounter: { value: 4 } } }, {}, f.other.id);
  assert.equal(token.flags.incarnos.summon.turnsLeft, 4);
  await acceptSummonedCounter(effect, { "flags.statuscounter.value": 100 }, {}, f.player.id);
  assert.equal(token.flags.incarnos.summon.turnsLeft, 4, "player edits cannot change duration");
  await token.update({ "flags.incarnos.summon.turnsLeft": 0 }); await syncSummoned(token);
  assert.equal(actor.statuses.has("summoned"), false);
  delete token.flags.incarnos.summon.turnsLeft; await syncSummoned(token);
  assert.equal(actor.statuses.has("summoned"), false);
});

test("the caster's committed turn ticks and synchronizes the same countdown once", async () => {
  const f = setup(), caster = f.actor(), actor = f.actor({ type: "npc" });
  const token = { actor, flags: { incarnos: { summon: { casterUuid: caster.uuid, turnsLeft: 3 } } },
    async update(changes) { for (const [path, value] of Object.entries(changes)) set(this, path, value); } };
  actor.isToken = true; actor.token = token;
  game.scenes = [{ tokens: [token] }];
  const combat = { id: "combat", started: true, combatants: new Map([["caster", { actor: caster }]]) };
  const prior = { round: 1, turn: 0, combatantId: "caster" }, current = { round: 1, turn: 1, combatantId: "next" };
  await syncSummoned(token);
  await tickSummons(combat, prior, current); await tickSummons(combat, prior, current);
  assert.equal(token.flags.incarnos.summon.turnsLeft, 2);
  assert.equal(conditionTokens(actor, "summoned"), 2);
});

test("removing the last Summoned counter by hand expires the token instead of leaving a stale duration", async () => {
  const f = setup(), actor = f.actor({ type: "npc" });
  const token = { actor, name: "Summon", flags: { incarnos: { summon: { turnsLeft: 2 } } },
    async update(changes) { for (const [path, value] of Object.entries(changes)) set(this, path, value); },
    async delete() { this.deleted = true; } };
  actor.isToken = true; actor.token = token;
  await syncSummoned(token); const effect = actor.effects[0]; await effect.delete();
  await acceptSummonedCounter(effect, {}, {}, f.gm.id, true);
  assert.equal(token.flags.incarnos.summon.turnsLeft, 0);
  assert.equal(token.deleted, true);
});
