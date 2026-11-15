import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { criticalFailureSeverity, criticalFailureTableName, hasCriticalFailure } from "../module/helpers/critical-failure-rules.mjs";
import { bindCriticalFailureButtons, canRollCriticalFailure, criticalFailure, criticalFailureOwner, processCriticalFailureRequest,
  promptCriticalFailureSeverity, registerCriticalFailureHooks, renderCriticalFailure, renderCriticalFailurePrompt,
  requestCriticalFailureDraw, resolveCriticalFailure, rollCriticalFailureSeverity, settleCriticalFailurePrompt } from "../module/helpers/critical-failure.mjs";
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
  const gm = { id: "gm", name: "GM", isGM: true, active: true }, owner = { id: "owner", name: "Player", active: true }, stranger = { id: "stranger", active: true };
  const actor = { uuid: "Actor.test", name: "Test actor", type: "character", testUserPermission: user => user.id === owner.id };
  const translations = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
  const calls = [], creates = [], warnings = [];
  globalThis.game = { user: gm, users: [gm, owner, stranger], actors: [actor], messages: new Map(),
    i18n: { localize: key => translations[key] ?? key,
      format: (key, data) => (translations[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => data[name]) }, packs: new Map() };
  globalThis.fromUuid = async uuid => uuid === actor.uuid ? actor : null;
  globalThis.ui = { notifications: { warn: text => warnings.push(text), error: text => warnings.push(text), info: text => warnings.push(text) } };
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
      if (change["flags.incarnos.criticalFailurePrompt"]) this.flags.incarnos.criticalFailurePrompt = structuredClone(change["flags.incarnos.criticalFailurePrompt"]);
      if (change.rolls) this.rolls = change.rolls.map(value => roll(value.total));
      this.content = change.content;
    }
  };
  game.messages.set(message.id, message);
  globalThis.ChatMessage = { getSpeaker: ({ actor }) => ({ actor: actor.uuid }), async create(data, options) {
    creates.push({ data, options });
    const created = { ...data, id: `created-${creates.length}`, author: game.user, update: message.update,
      rolls: (data.rolls ?? []).map(value => roll(value.total)) };
    game.messages.set(created.id, created);
    return created;
  } };
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
  return { disabled: false, removed: false, listeners: [], hasAttribute: name => start === "prompt"
    ? name === "data-incarnos-critical-prompt" : start && name === "data-incarnos-critical-start",
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

function confirmSelection(actor, kind = "weapon") {
  globalThis.foundry = { applications: { api: { DialogV2: { prompt: async options => options.ok.callback(null, { form: { elements: {
    actor: { value: actor.uuid }, kind: { value: kind }
  } } }) } } } };
}

test("online owner selection prefers the assigned character, otherwise sorts non-GM owners by id", () => {
  const { actor, owner, stranger, gm } = setup();
  const first = { id: "aaa", active: true }, offline = { id: "000", active: false, character: actor };
  game.users = [owner, gm, stranger, offline, first];
  actor.testUserPermission = (user, permission) => permission === "OWNER" && user !== stranger;
  assert.equal(criticalFailureOwner(actor), first);
  owner.character = { uuid: actor.uuid };
  assert.equal(criticalFailureOwner(actor), owner);
  owner.active = false;
  assert.equal(criticalFailureOwner(actor), first);
  first.active = false;
  assert.equal(criticalFailureOwner(actor), undefined);
});

test("GM confirmation whispers an escaped roll card to the online owner and GM without rolling", async () => {
  const { actor, gm, owner, calls, creates, warnings } = setup();
  confirmSelection(actor, "spell");
  const prompt = await criticalFailure({ actor, kind: "spell" });
  assert.deepEqual(calls, []);
  assert.deepEqual(prompt.whisper, [owner.id, gm.id]);
  assert.deepEqual(prompt.flags.incarnos.criticalFailurePrompt, {
    actorUuid: actor.uuid, actorName: actor.name, kind: "spell", userId: owner.id, state: "pending"
  });
  assert.match(prompt.content, /Test actor: critical failure \(Spell attack\). Player rolls for severity\./);
  assert.match(prompt.content, /incarnos-spell-card/);
  assert.match(prompt.content, /data-incarnos-critical-prompt/);
  assert.equal(creates.length, 1);
  assert.deepEqual(warnings, ["Asked Player to roll"]);
  owner.name = "<img onerror=bad>";
  const data = { ...prompt.flags.incarnos.criticalFailurePrompt, actorName: "<script>" };
  assert.doesNotMatch(renderCriticalFailurePrompt(data), /<script>|<img onerror/);
  assert.match(renderCriticalFailurePrompt({ ...data, state: "done" }), /disabled[^>]*>[\s\S]*Rolled/);
});

test("GM rolls directly when the player is offline or only a GM owns the actor", async () => {
  for (const gmOnly of [false, true]) {
    const { actor, gm, owner, calls, creates } = setup();
    if (gmOnly) actor.testUserPermission = user => user.id === gm.id;
    else owner.active = false;
    confirmSelection(actor);
    await criticalFailure({ actor });
    assert.deepEqual(calls, [["roll", "1d10"]]);
    assert.equal(creates[0].data.flags.incarnos.criticalFailure.d10, 7);
    assert.equal(creates[0].data.flags.incarnos.criticalFailurePrompt, undefined);
    assert.equal(creates[0].data.whisper, undefined);
  }
});

test("only the chosen player gets the automatic dialog; closing it preserves the whisper button", async () => {
  const { actor, owner, stranger, calls } = setup();
  confirmSelection(actor, "spell");
  const prompt = await criticalFailure({ actor });
  let dialog;
  foundry.applications.api.DialogV2.prompt = async options => { dialog = options; return null; };
  assert.equal(await promptCriticalFailureSeverity(prompt), false); // GM does not open it.
  game.user = stranger;
  assert.equal(await promptCriticalFailureSeverity(prompt), false);
  game.user = owner;
  await promptCriticalFailureSeverity(prompt);
  assert.match(dialog.content, /Your Spell attack critically failed! Roll how bad it is\./);
  assert.equal(dialog.ok.label, "Roll severity");
  assert.equal(dialog.rejectClose, false);
  assert.deepEqual(calls, []);
  assert.equal(prompt.flags.incarnos.criticalFailurePrompt.state, "pending");
  const rollButton = button("prompt");
  await bindCriticalFailureButtons(prompt, { querySelectorAll: () => [rollButton] });
  assert.equal(rollButton.disabled, false);
  await dialog.ok.callback();
  assert.equal(game.messages.get("created-2").author, owner);
  assert.equal(game.messages.get("created-2").flags.incarnos.criticalFailure.promptId, prompt.id);
});

test("prompt button permits only the chosen player or GM and disappears when no longer pending", async () => {
  const { actor, owner, stranger, gm, calls } = setup();
  confirmSelection(actor);
  const prompt = await criticalFailure({ actor });
  actor.testUserPermission = () => true; // Even another owner cannot take this player's prompt.
  for (const user of [stranger, owner, gm]) {
    game.user = user;
    const rollButton = button("prompt");
    await bindCriticalFailureButtons(prompt, { querySelectorAll: () => [rollButton] });
    assert.equal(rollButton.removed, user === stranger);
    assert.equal(rollButton.listeners.length, user === stranger ? 0 : 1);
  }
  game.user = stranger;
  assert.equal(await rollCriticalFailureSeverity(actor, "weapon", prompt.id), false);
  assert.deepEqual(calls, []);
  prompt.flags.incarnos.criticalFailurePrompt.state = "done";
  game.user = owner;
  const doneButton = button("prompt");
  await bindCriticalFailureButtons(prompt, { querySelectorAll: () => [doneButton] });
  assert.equal(doneButton.removed, true);
  assert.equal(await rollCriticalFailureSeverity(actor, "weapon", prompt.id), false);
});

test("dialog and whisper clicks roll once; an existing severity card blocks rerolls before GM settlement", async () => {
  const { actor, owner, gm, calls, creates } = setup();
  confirmSelection(actor);
  const prompt = await criticalFailure({ actor });
  game.user = owner;
  const results = await Promise.all([rollCriticalFailureSeverity(actor, "weapon", prompt.id), rollCriticalFailureSeverity(actor, "weapon", prompt.id)]);
  assert.equal(results[1], false);
  assert.deepEqual(calls, [["roll", "1d10"]]);
  assert.equal(creates.length, 2);
  assert.equal(prompt.flags.incarnos.criticalFailurePrompt.state, "pending"); // Player never updates a GM's message.
  const severity = results[0];
  assert.equal(severity.author, owner);
  assert.deepEqual(severity.rolls.map(roll => roll.toJSON()), [{ total: 7 }]);
  assert.deepEqual(creates[1].options, { messageMode: "public" });
  assert.equal(await rollCriticalFailureSeverity(actor, "weapon", prompt.id), false);
  assert.equal(await promptCriticalFailureSeverity(prompt), false);
  const staleButton = button("prompt");
  await bindCriticalFailureButtons(prompt, { querySelectorAll: () => [staleButton] });
  assert.equal(staleButton.removed, true);
  assert.equal(await settleCriticalFailurePrompt(severity), false);
  const secondGM = { id: "zGM", isGM: true, active: true };
  game.users.push(secondGM);
  game.user = secondGM;
  assert.equal(await settleCriticalFailurePrompt(severity), false);
  game.user = gm;
  assert.equal(await settleCriticalFailurePrompt(severity), true);
  assert.equal(prompt.flags.incarnos.criticalFailurePrompt.state, "done");
  assert.match(prompt.content, /disabled[^>]*>[\s\S]*Rolled/);
  assert.equal(await settleCriticalFailurePrompt(severity), false);
  assert.equal(await resolveCriticalFailure(severity, owner), true); // Existing table flow still works.
});

test("GM settlement rejects unrelated or impersonated severity cards", async () => {
  const { actor, stranger, owner, gm } = setup();
  confirmSelection(actor);
  const prompt = await criticalFailure({ actor });
  const severity = { author: stranger, flags: { incarnos: { criticalFailure: {
    actorUuid: actor.uuid, kind: "weapon", d10: 7, promptId: prompt.id
  } } } };
  assert.equal(await settleCriticalFailurePrompt(severity), false);
  severity.author = owner;
  severity.flags.incarnos.criticalFailure.actorUuid = "Actor.other";
  assert.equal(await settleCriticalFailurePrompt(severity), false);
  severity.flags.incarnos.criticalFailure.actorUuid = actor.uuid;
  severity.author = gm;
  assert.equal(await settleCriticalFailurePrompt(severity), true);
});

test("chat creation opens the player's dialog and GM ready settles missed severity cards without prompting again", async () => {
  const { actor, owner, gm } = setup();
  const hooks = new Map();
  globalThis.Hooks = { on: (name, callback) => hooks.set(name, callback), once: (name, callback) => hooks.set(name, callback) };
  registerCriticalFailureHooks();
  confirmSelection(actor);
  const prompt = await criticalFailure({ actor });
  game.user = owner;
  let dialog;
  foundry.applications.api.DialogV2.prompt = async options => { dialog = options; return null; };
  hooks.get("createChatMessage")(prompt);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(dialog);
  const severity = await dialog.ok.callback();
  game.user = gm;
  hooks.get("createChatMessage")(severity);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prompt.flags.incarnos.criticalFailurePrompt.state, "done");
  prompt.flags.incarnos.criticalFailurePrompt.state = "pending";
  dialog = undefined;
  await hooks.get("ready")();
  assert.equal(prompt.flags.incarnos.criticalFailurePrompt.state, "done");
  assert.equal(dialog, undefined);
});

test("GM natural-20 button uses the owner prompt; the player's natural-20 button rolls directly", async () => {
  for (const player of [false, true]) {
    const { actor, owner, calls, creates } = setup();
    if (player) game.user = owner;
    confirmSelection(actor, "spell");
    const start = button(true);
    const message = { flags: { incarnos: { criticalFailureAttack: { actorUuid: actor.uuid, kind: "spell" } } } };
    await bindCriticalFailureButtons(message, { querySelectorAll: () => [start] });
    await start.listeners[0]();
    assert.deepEqual(calls, player ? [["roll", "1d10"]] : []);
    assert.equal(Boolean(creates[0].data.flags.incarnos.criticalFailurePrompt), !player);
  }
});
