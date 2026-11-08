import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { castSpell, encoreCost, encoreNeedsTargets, isEncoreSpell, lastSpellRecord } from "../module/helpers/spell-cast.mjs";

const encore = { element: "Shadow", category: "Utility", cost: "X Actions, Y+2 IP", range: "3m", target: "Single Ally", check: "No Check",
  duration: "Instant", effect: "On cast:\nImmediatly copy a spell and pay the costs: \nX is the initial spell's actioncost\nY is the initial spell's mpcost" };

test("Encore is recognised by its text; it costs the copied spell's actions and its IP + 2", () => {
  assert.equal(isEncoreSpell(encore), true);
  assert.equal(isEncoreSpell({ effect: "On hit: Deals 6d6 fire dmg" }), false);
  assert.deepEqual(encoreCost({ cost: { actions: 2, mp: 10 } }), { actions: 2, mp: 12 });
  const record = lastSpellRecord({ name: "Firelance" }, { actions: 2, mp: 0, hp: 10 });
  assert.deepEqual([record.name, record.cost], ["Firelance", { actions: 2, mp: 10 }], "an Abomination's HP payment counts as the IP cost");
});

test("which copies need targets picked first", () => {
  assert.equal(encoreNeedsTargets({ target: "Single Enemy", range: "12m", effect: "On hit: Deals 6d6 fire dmg", check: "Attack Int / Cha" }), true);
  assert.equal(encoreNeedsTargets({ target: "Self", range: "Self", effect: "On cast: Gain +2 Parry" }), false);
  assert.equal(encoreNeedsTargets({ target: "Ground Circle", range: "12m (2m radius)", effect: "On hit: Deals 2d6 fire dmg", check: "Target Save Dex" }), false, "areas are placed instead");
  assert.equal(encoreNeedsTargets({ target: "Up to 5 Enemies", range: "Self (6m radius)", effect: "On hit: Deals 2d6 dmg", check: "Target Save Dex" }), true, "picked targets within a radius");
});

test("Encore copies the ally's last spell, clears targets for the targeting tool, pays its AP and IP + 2", async () => {
  const song = { name: "Song of Deceit", type: "spell", img: "song.webp",
    system: { element: "Air", category: "Control", cost: "2 Actions, 8 IP", actions: 2, mp: 8, range: "9m", target: "Single Enemy",
      check: "No Check", effect: "On cast: \nTarget becomes a friend to the user for the duration." } };
  const flags = {};
  const caster = { uuid: "Actor.bard", name: "Bard", type: "character", items: [], statuses: new Set(), writes: [],
    system: { power: { value: 30 }, health: { value: 20 }, actionpoints: { value: 3, max: 3 } }, getRollData: () => ({}),
    async update(changes) { this.writes.push(changes); }, async setFlag(scope, key, value) { flags[key] = value; } };
  const ally = { uuid: "Actor.ally", name: "Ally", type: "character", getFlag: (scope, key) => (key === "lastSpell" ? lastSpellRecord(song, { actions: 2, mp: 8 }) : undefined) };
  const language = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
  const prompts = [], cards = [], targetCalls = [], tools = [], infos = [];
  globalThis.game = { user: { id: "u", isGM: false, targets: new Set([{ actor: ally, name: "Ally", document: {} }]) }, combats: [],
    settings: { get: () => "publicroll" },
    i18n: { localize: key => language[key] ?? key, format: (key, data) => (language[key] ?? key).replace(/\{(\w+)\}/g, (_, field) => data[field]) } };
  globalThis.canvas = { ready: false, tokens: { placeables: [], setTargets: ids => targetCalls.push(ids) } };
  globalThis.ui = { notifications: { warn: message => assert.fail(message), info: message => infos.push(message) },
    controls: { async activate(options) { tools.push(options.tool); } } };
  globalThis.foundry = { utils: { deepClone: structuredClone, isEmpty: object => !Object.keys(object).length },
    applications: { api: { DialogV2: { async confirm(options) { prompts.push(options.content); return true; } } } } };
  globalThis.CONFIG = { Item: { documentClass: class { constructor(data, { parent }) { Object.assign(this, data); this.actor = parent; } } } };
  globalThis.Roll = class { static validate() { return true; } };
  globalThis.ChatMessage = { getSpeaker: () => ({}), applyMode: () => {}, async create(data) { cards.push(data); return data; } };

  await castSpell({ name: "Encore", img: "encore.webp", actor: caster, system: encore });
  assert.match(prompts[0], /Copied Song of Deceit from Ally \(2 AP, 10 IP\)\. Target what Song of Deceit should hit/);
  assert.deepEqual(targetCalls, [[]], "the ally's target is cleared");
  assert.deepEqual(tools, ["target", "select"], "targeting tool on while choosing, select tool after");
  assert.deepEqual(caster.writes, [{ "system.power.value": 20 }], "IP 8 + 2 paid (no AP outside combat)");
  assert.match(cards[0].content, /Encore: Song of Deceit/);
  assert.equal(flags.lastSpell.name, "Song of Deceit", "the Encore caster now remembers the copied spell");
  assert.deepEqual(flags.lastSpell.cost, { actions: 2, mp: 8 }, "with the copied spell's own cost, not Encore's");

  // A Self spell needs no targets: no window, the copy is cast at once.
  ally.getFlag = () => lastSpellRecord({ ...song, name: "Shadowform", system: { ...song.system, range: "Self", target: "Self" } }, { actions: 1, mp: 6 });
  prompts.length = 0;
  await castSpell({ name: "Encore", img: "encore.webp", actor: caster, system: encore });
  assert.equal(prompts.length, 0);
  assert.match(infos.at(-1), /Spell copied: Shadowform from Ally \(1 AP, 8 IP\)/);
  assert.match(cards.at(-1).content, /Encore: Shadowform/);

  // An ally who hasn't cast anything yet: a warning, nothing paid.
  const warnings = [];
  ui.notifications.warn = message => warnings.push(message);
  ally.getFlag = () => undefined;
  caster.writes = [];
  const before = cards.length;
  await castSpell({ name: "Encore", img: "encore.webp", actor: caster, system: encore });
  assert.match(warnings[0], /Ally has not cast a spell yet/);
  assert.deepEqual(caster.writes, []);
  assert.equal(cards.length, before);
});
