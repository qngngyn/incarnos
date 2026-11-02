import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { criticalFailureSeverity, criticalFailureTableName, hasCriticalFailure } from "../module/helpers/critical-failure-rules.mjs";
import { bindCriticalFailureButtons, canRollCriticalFailure, criticalFailure, processCriticalFailureRequest, renderCriticalFailure,
  requestCriticalFailureDraw, resolveCriticalFailure } from "../module/helpers/critical-failure.mjs";
import { renderSpellCard } from "../module/helpers/spell-card.mjs";

test("severity is exactly 1–6 small, 7–9 hurts and 10 disaster, with six distinct table selections", () => {
  assert.deepEqual(Array.from({ length: 10 }, (_, i) => criticalFailureSeverity(i + 1).id),
    ["small", "small", "small", "small", "small", "small", "hurts", "hurts", "hurts", "disaster"]);
  for (const value of [0, 11, NaN, null, "1", 1.5]) assert.equal(criticalFailureSeverity(value), null);
  const names = new Set();
  for (const severity of ["small", "hurts", "disaster"]) for (const kind of ["weapon", "spell"]) {
    const name = criticalFailureTableName(severity, kind);
    assert.match(name, new RegExp(`Critical Failure – .+ \\(${kind === "weapon" ? "Weapon" : "Spell"}\\)$`));
    names.add(name);
  }
  assert.equal(names.size, 6);
  assert.throws(() => criticalFailureTableName("bad", "weapon"));
  assert.throws(() => criticalFailureTableName("small", "bad"));
});

function setup({ kind = "weapon", d10 = 7 } = {}) {
  const gm = { id: "gm", isGM: true, active: true }, owner = { id: "owner", active: true }, stranger = { id: "stranger", active: true };
  const actor = { uuid: "Actor.test", name: "Test actor", type: "character", testUserPermission: user => user.id === owner.id };
  const translations = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
  const calls = [], creates = [], warnings = [];
  globalThis.game = { user: gm, users: [gm, owner, stranger], actors: [actor], messages: new Map(),
    i18n: { localize: key => translations[key] ?? key }, packs: new Map() };
  globalThis.fromUuid = async uuid => uuid === actor.uuid ? actor : null;
  globalThis.ui = { notifications: { warn: text => warnings.push(text), error: text => warnings.push(text) } };
  globalThis.CONFIG = { sounds: { dice: "dice.wav" } };
  const roll = total => ({ total, toJSON: () => ({ total }) });
  const tables = ["small", "hurts", "disaster"].flatMap(severity => ["weapon", "spell"].map(kind => ({
    _id: `${severity}-${kind}`, name: criticalFailureTableName(severity, kind), uuid: `Table.${severity}-${kind}`,
    async draw(options) { calls.push([this._id, options]); return { roll: roll(1), results: [{ description: "**Fall:** You are *Prone*." }] }; }
  })));
  game.packs.set("incarnos.critical-failures", { getIndex: async () => tables, getDocument: async id => tables.find(table => table._id === id) });
  const message = {
    id: "prompt", author: owner, rolls: [roll(d10)],
    flags: { incarnos: { criticalFailure: { actorUuid: actor.uuid, actorName: actor.name, kind, d10, state: "pending" } } },
    async update(change) {
      calls.push(["update", structuredClone(change)]);
      if (change["flags.incarnos.criticalFailure"]) this.flags.incarnos.criticalFailure = structuredClone(change["flags.incarnos.criticalFailure"]);
      if (change.rolls) this.rolls = change.rolls.map(value => roll(value.total));
      this.content = change.content;
    }
  };
  game.messages.set(message.id, message);
  globalThis.ChatMessage = { getSpeaker: ({ actor }) => ({ actor: actor.uuid }), async create(data, options) { creates.push({ data, options }); return data; } };
  globalThis.Roll = class { constructor(formula) { calls.push(["roll", formula]); } async evaluate() { return roll(d10); } };
  globalThis.canvas = { tokens: { controlled: [] } };
  return { gm, owner, stranger, actor, calls, creates, warnings, tables, message, data: message.flags.incarnos.criticalFailure };
}

test("owners and GMs only, pending only; nonowners cannot resolve or submit", async () => {
  const { actor, owner, gm, stranger, data, message, calls, creates } = setup();
  assert.equal(canRollCriticalFailure(actor, owner, data), true);
  assert.equal(canRollCriticalFailure(actor, gm, data), true);
  assert.equal(canRollCriticalFailure(actor, stranger, data), false);
  assert.equal(canRollCriticalFailure(null, gm, data), false);
  for (const state of ["rolling", "done"]) assert.equal(canRollCriticalFailure(actor, owner, { ...data, state }), false);
  assert.equal(await resolveCriticalFailure(message, stranger), false);
  game.user = stranger;
  assert.equal(await requestCriticalFailureDraw(message), false);
  assert.deepEqual(calls, []);
  assert.deepEqual(creates, []);
});

test("all severity/kind combinations draw the matching pack table", async () => {
  for (const d10 of [1, 6, 7, 9, 10]) for (const kind of ["weapon", "spell"]) {
    const { message, owner, calls } = setup({ d10, kind });
    assert.equal(await resolveCriticalFailure(message, owner), true);
    assert.deepEqual(calls.filter(call => call[0] !== "update"), [[`${criticalFailureSeverity(d10).id}-${kind}`, { displayChat: false, recursive: false }]]);
    assert.equal(message.flags.incarnos.criticalFailure.state, "done");
    assert.match(message.content, /<strong>Fall:<\/strong> You are <em>Prone<\/em>/);
    assert.match(message.content, /data-incarnos-critical-draw disabled/);
    assert.equal(message.rolls.length, 2);
  }
});

test("concurrent requests draw once; stored done/rolling flags block rerolls after reload", async () => {
  const { message, owner, gm, calls } = setup();
  assert.deepEqual(await Promise.all([resolveCriticalFailure(message, owner), resolveCriticalFailure(message, gm)]), [true, false]);
  assert.equal(calls.filter(call => call[0] === "hurts-weapon").length, 1);
  const reloaded = { ...message, flags: JSON.parse(JSON.stringify(message.flags)) };
  assert.equal(await resolveCriticalFailure(reloaded, owner), false);
  reloaded.flags.incarnos.criticalFailure.state = "rolling";
  assert.equal(await resolveCriticalFailure(reloaded, owner), false);
  assert.equal(calls.filter(call => call[0] === "hurts-weapon").length, 1);
});

test("a failed draw retains its persisted reservation; missing table fails before reserving", async () => {
  const { message, owner, tables } = setup();
  const table = tables.find(table => table._id === "hurts-weapon");
  table.draw = async () => { throw new Error("disconnected"); };
  await assert.rejects(resolveCriticalFailure(message, owner), /disconnected/);
  assert.equal(message.flags.incarnos.criticalFailure.state, "rolling");
  assert.equal(await resolveCriticalFailure(message, owner), false);
  message.flags.incarnos.criticalFailure.state = "pending";
  game.packs.clear();
  await assert.rejects(resolveCriticalFailure(message, owner), /missing/);
  assert.equal(message.flags.incarnos.criticalFailure.state, "pending");
});

test("player submits a hidden request, first GM validates server author and rejects impersonation", async () => {
  const { owner, gm, stranger, message, creates, calls } = setup();
  message.author = gm; // The player owns the actor but cannot update this GM-authored prompt.
  game.user = owner;
  assert.equal(await requestCriticalFailureDraw(message), true);
  assert.equal(calls.length, 0);
  assert.deepEqual(creates[0].data.whisper, [gm.id, owner.id]);
  const request = { ...creates[0].data, author: stranger };
  request.flags.incarnos.criticalFailureRequest.userId = owner.id;
  game.user = gm;
  assert.equal(await processCriticalFailureRequest(request), false);
  request.author = owner;
  game.users.push({ id: "zGM", active: true, isGM: true });
  game.user = game.users.at(-1);
  assert.equal(await processCriticalFailureRequest(request), false);
  game.user = gm;
  assert.equal(await processCriticalFailureRequest(request), true);
  assert.equal(await processCriticalFailureRequest(request), false);
});

test("without a GM the prompt author can draw; another owner must wait for a GM", async () => {
  const { message, owner, warnings } = setup();
  game.users = [owner];
  game.user = owner;
  message.author = { id: "other" };
  assert.equal(await requestCriticalFailureDraw(message), false);
  assert.equal(warnings.length, 1);
  message.author = owner;
  assert.equal(await requestCriticalFailureDraw(message), true);
});

test("dialog defaults selected token/kind, cancel rolls nothing; confirmation posts a public visible d10", async () => {
  const { actor, owner, creates, calls } = setup({ kind: "spell", d10: 10 });
  game.user = owner;
  canvas.tokens.controlled = [{ actor }];
  let dialog;
  globalThis.foundry = { applications: { api: { DialogV2: { prompt: async options => { dialog = options; return null; } } } } };
  await criticalFailure({ kind: "spell" });
  assert.equal(calls.length, 0);
  assert.equal(creates.length, 0);
  assert.match(dialog.content, /value="spell" selected/);
  assert.match(dialog.content, /Test actor/);
  foundry.applications.api.DialogV2.prompt = async options => options.ok.callback(null, { form: { elements: {
    actor: { value: actor.uuid }, kind: { value: "spell" }
  } } });
  await criticalFailure({ kind: "spell" });
  assert.deepEqual(calls, [["roll", "1d10"]]);
  assert.deepEqual(creates[0].options, { messageMode: "public" });
  assert.deepEqual(creates[0].data.rolls, [{ total: 10 }]);
  assert.match(creates[0].data.content, /Disaster \(10 %\)/);
  assert.equal(creates[0].data.flags.incarnos.criticalFailure.kind, "spell");
});

test("without a token the dialog offers owned player characters and the GM can choose any character", async () => {
  const { actor, owner, gm, stranger, creates } = setup();
  game.user = owner;
  const other = { ...actor, uuid: "Actor.other", name: "Other character", testUserPermission: user => user.id === stranger.id };
  game.actors.push(other, { ...actor, uuid: "Actor.npc", name: "NPC", type: "npc" });
  let content;
  globalThis.foundry = { applications: { api: { DialogV2: { prompt: async options => { content = options.content; return null; } } } } };
  await criticalFailure();
  assert.match(content, /Test actor/);
  assert.doesNotMatch(content, /Other character|NPC/);
  game.user = gm;
  await criticalFailure();
  assert.match(content, /Other character/);
  assert.doesNotMatch(content, /NPC/);
  assert.deepEqual(creates, []);
});

function button(start = false) {
  return { disabled: false, removed: false, listeners: [], hasAttribute: () => start,
    remove() { this.removed = true; }, addEventListener(type, listener) { this.listeners.push(listener); } };
}

test("render binds only authorized pending buttons, keeps resolved buttons disabled and hides request documents", async () => {
  const { message, owner, stranger } = setup();
  const draw = button(), html = { style: {}, querySelectorAll: () => [draw] };
  game.user = stranger;
  await bindCriticalFailureButtons(message, html);
  assert.equal(draw.removed, true);
  game.user = owner;
  draw.removed = false;
  await bindCriticalFailureButtons(message, html);
  assert.equal(draw.disabled, false);
  assert.equal(draw.listeners.length, 1);
  message.flags.incarnos.criticalFailure.state = "done";
  draw.listeners = [];
  await bindCriticalFailureButtons(message, html);
  assert.equal(draw.disabled, true);
  assert.equal(draw.listeners.length, 0);
  await bindCriticalFailureButtons({ flags: { incarnos: { criticalFailureRequest: {} } } }, html);
  assert.equal(html.style.display, "none");
});

test("attack start button presets the attack actor/kind, opens a dialog and never rolls on render", async () => {
  const { actor, owner, calls } = setup();
  game.user = owner;
  const start = button(true);
  let dialog;
  globalThis.foundry = { applications: { api: { DialogV2: { prompt: async options => { dialog = options; return null; } } } } };
  const message = { flags: { incarnos: { criticalFailureAttack: { actorUuid: actor.uuid, kind: "spell" } } } };
  await bindCriticalFailureButtons(message, { querySelectorAll: () => [start] });
  assert.deepEqual(calls, []);
  assert.equal(dialog, undefined);
  await start.listeners[0]();
  assert.match(dialog.content, /value="spell" selected/);
  assert.match(dialog.content, /Test actor/);
  assert.deepEqual(calls, []);
});

test("only natural 20 attack dice add the spell button (including multi-attack); pending cards and saves do not", () => {
  const results = [{ name: "Target", hit: false, attack: { d20: 20, threshold: 10 } }];
  assert.equal(hasCriticalFailure(results), true);
  assert.match(renderSpellCard({ name: "Spell", results }), /data-incarnos-critical-start/);
  assert.doesNotMatch(renderSpellCard({ name: "Spell", results, pending: true }), /data-incarnos-critical-start/);
  assert.doesNotMatch(renderSpellCard({ name: "Spell", results: [{ save: { d20: 20 }, hit: true }] }), /data-incarnos-critical-start/);
  assert.equal(hasCriticalFailure([{ check: { d20: 20 } }]), true);
  assert.equal(hasCriticalFailure([{ attacks: [{ attack: { d20: 5 } }, { attack: { d20: 20 } }] }]), true);
  assert.equal(hasCriticalFailure([{ attack: { d20: 5, discarded: 20 } }]), false);
  setup();
  assert.doesNotMatch(renderCriticalFailure({ actorName: "<script>", kind: "weapon", d10: 7, state: "done", result: "<img onerror=bad>" }), /<script>|<img onerror/);
});
