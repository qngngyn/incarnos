import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { castSpell, encoreCost, isEncoreSpell, lastSpellRecord } from "../module/helpers/spell-cast.mjs";

const encore = { element: "Shadow", category: "Utility", cost: "X Actions, Y+2 IP", range: "3m", target: "Single Ally", check: "No Check",
  duration: "Instant", effect: "On cast:\nImmediatly copy a spell and pay the costs: \nX is the initial spell's actioncost\nY is the initial spell's mpcost" };

test("Encore is recognised by its text; it costs the copied spell's actions and its IP + 2", () => {
  assert.equal(isEncoreSpell(encore), true);
  assert.equal(isEncoreSpell({ effect: "On hit: Deals 6d6 fire dmg" }), false);
  assert.deepEqual(encoreCost({ cost: { actions: 2, mp: 10 } }), { actions: 2, mp: 12 });
  const record = lastSpellRecord({ name: "Firelance" }, { actions: 2, mp: 0, hp: 10 });
  assert.deepEqual([record.name, record.cost], ["Firelance", { actions: 2, mp: 10 }], "an Abomination's HP payment counts as the IP cost");
});

test("casting Encore on an ally copies that ally's last spell, pays its AP and IP + 2, and remembers the copied spell", async () => {
  const song = { name: "Song of Winds", type: "spell", img: "song.webp",
    system: { element: "Air", category: "Utility", cost: "2 Actions, 8 IP", actions: 2, mp: 8, range: "Self", target: "Self", check: "No Check", effect: "On cast: Blocks any projectile fully" } };
  const flags = {};
  const caster = { uuid: "Actor.bard", name: "Bard", type: "character", items: [], statuses: new Set(), writes: [],
    system: { power: { value: 30 }, health: { value: 20 }, actionpoints: { value: 3, max: 3 } }, getRollData: () => ({}),
    async update(changes) { this.writes.push(changes); }, async setFlag(scope, key, value) { flags[key] = value; } };
  const ally = { uuid: "Actor.ally", name: "Ally", type: "character", getFlag: (scope, key) => (key === "lastSpell" ? lastSpellRecord(song, { actions: 2, mp: 8 }) : undefined) };
  const language = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
  const prompts = [], cards = [];
  globalThis.game = { user: { id: "u", isGM: false, targets: new Set([{ actor: ally, name: "Ally", document: {} }]) }, combats: [],
    settings: { get: () => "publicroll" },
    i18n: { localize: key => language[key] ?? key, format: (key, data) => (language[key] ?? key).replace(/\{(\w+)\}/g, (_, field) => data[field]) } };
  globalThis.canvas = { ready: false, tokens: { placeables: [] } };
  globalThis.ui = { notifications: { warn: message => assert.fail(message), info: () => {} } };
  globalThis.foundry = { utils: { deepClone: structuredClone, isEmpty: object => !Object.keys(object).length },
    applications: { api: { DialogV2: { async confirm(options) { prompts.push(options.content); return true; } } } } };
  globalThis.CONFIG = { Item: { documentClass: class { constructor(data, { parent }) { Object.assign(this, data); this.actor = parent; } } } };
  globalThis.Roll = class { static validate() { return true; } };
  globalThis.ChatMessage = { getSpeaker: () => ({}), applyMode: () => {}, async create(data) { cards.push(data); return data; } };

  await castSpell({ name: "Encore", img: "encore.webp", actor: caster, system: encore });
  assert.match(prompts[0], /Copy Song of Winds, the last spell Ally cast, for 2 AP and 10 IP/);
  assert.deepEqual(caster.writes, [{ "system.power.value": 20 }], "IP 8 + 2 paid (no AP outside combat)");
  assert.match(cards[0].content, /Encore: Song of Winds/);
  assert.equal(flags.lastSpell.name, "Song of Winds", "the Encore caster now remembers the copied spell");
  assert.deepEqual(flags.lastSpell.cost, { actions: 2, mp: 8 }, "with the copied spell's own cost, not Encore's");

  // An ally who hasn't cast anything yet: a warning, nothing paid.
  const warnings = [];
  ui.notifications.warn = message => warnings.push(message);
  ally.getFlag = () => undefined;
  caster.writes = [];
  await castSpell({ name: "Encore", img: "encore.webp", actor: caster, system: encore });
  assert.match(warnings[0], /Ally has not cast a spell yet/);
  assert.deepEqual(caster.writes, []);
});
