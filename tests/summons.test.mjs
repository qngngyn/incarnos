import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseSpellNote } from "../tools/spell-notes.mjs";
import { describeSpellAutomation, getSpellAutomation, parseSpellSummon } from "../module/helpers/spells.mjs";
import { castSpell } from "../module/helpers/spell-cast.mjs";
import { getCastCost } from "../module/helpers/spell-cost.mjs";
import { findSummonVersion, processSummonRequest, registerSummonHooks, summonInRange, validateSummonRequest } from "../module/helpers/summons.mjs";
import { addSummonCombatant, removeSummonCombatants, sortSummonCombatants, tickSummons } from "../module/helpers/summon-lifecycle.mjs";
import { replenishCombatTurn } from "../module/helpers/action-tracker.mjs";

// Exact rules text from the real vault note, kept portable and independent of the GM's files.
const { spell } = parseSpellNote(readFileSync(new URL("fixtures/death-fire-elemental.md", import.meta.url), "utf8"), "Death fire elemental", "Deathfire");
const strings = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
const collection = values => Object.assign(values, { get(id) { return this.find(value => value.id === id || value._id === id); } });

function setup({ combat = false, tier = 0, cancel = false, cancelDialog = false, gm = true, previewCancel = false } = {}) {
  const writes = [], cards = [], warnings = [], placements = [], imports = [], deletedRequests = [], hooks = {};
  const player = { id: "player", active: true, isGM: false, viewedScene: "scene" };
  const elected = { id: "a-gm", active: true, isGM: true }, other = { id: "z-gm", active: true, isGM: true };
  globalThis.game = { user: gm ? elected : player, users: collection([other, player, elected]), paused: false,
    actors: collection([]), folders: collection([]), combats: collection([]), scenes: collection([]), packs: new Map(),
    settings: { get: () => "publicroll" }, i18n: { localize: key => strings[key],
      format: (key, data) => strings[key].replace(/\{(\w+)\}/g, (_, field) => data[field]) } };
  const actor = { id: "caster", uuid: "Actor.caster", documentName: "Actor", type: "character", name: "Caster", items: [],
    testUserPermission: user => user.id === player.id || user.isGM,
    system: { power: { value: 200 }, health: { value: 200 }, actionpoints: { value: 3, max: 3 } },
    async update(changes) { writes.push(changes); for (const [key, value] of Object.entries(changes)) {
      const [, pool, field] = key.split("."); this.system[pool][field] = value;
    } } };
  const item = { id: "spell", uuid: "Actor.caster.Item.spell", documentName: "Item", type: "spell", name: spell.name,
    parent: actor, actor, system: { ...spell } };
  const scene = { id: "scene", grid: { size: 100, distance: 1.5 }, levels: collection([{ id: "level" }]),
    dimensions: { sceneX: 0, sceneY: 0, sceneWidth: 3000, sceneHeight: 3000 }, tokens: collection([]),
    async createEmbeddedDocuments(type, data) {
      assert.equal(type, "Token");
      return data.map(data => {
        const token = { ...structuredClone(data), id: `summon-${scene.tokens.length}`, parent: scene, documentName: "Token",
          async update(change) { this.flags.incarnos.summon = change["flags.incarnos.summon"]; },
          async delete() { this.deleted = true; scene.tokens.splice(scene.tokens.indexOf(this), 1); } };
        scene.tokens.push(token); return token;
      });
    } };
  game.scenes.push(scene);
  const caster = { id: "caster-token", uuid: "Scene.scene.Token.caster-token", documentName: "Token", parent: scene,
    x: 500, y: 500, width: 1, height: 1, actor };
  scene.tokens.push(caster);
  const encounter = { id: "combat", started: true, combatants: collection([]),
    _sortCombatants(a, b) { return sortSummonCombatants(a, b, (a, b) => b.initiative - a.initiative || a.id.localeCompare(b.id)); },
    async createEmbeddedDocuments(type, data) {
      assert.equal(type, "Combatant");
      const created = data.map((data, index) => ({ ...data, id: `summon-combatant-${this.combatants.length + index}`, parent: encounter }));
      this.combatants.push(...created); return created;
    },
    async deleteEmbeddedDocuments(type, ids) {
      for (const id of ids) this.combatants.splice(this.combatants.findIndex(c => c.id === id), 1);
    } };
  encounter.combatants.push({ id: "caster-combatant", actor, tokenId: caster.id, sceneId: scene.id, initiative: 18, parent: encounter });
  if (combat) game.combats.push(encounter);
  const versions = [0, 20, 40, 60].map((ip, index) => ({ _id: `version-${ip}`, name: `Deathfire Elemental${ip ? ` +${ip} IP` : ""}`,
    documentName: "Actor", type: "npc", uuid: `Compendium.incarnos.monsters.Actor.version-${ip}`,
    prototypeToken: { width: index + 1, height: index + 1, actorLink: true,
      texture: { src: "pnp%20zeugs/tokens/Monster/Fire%20Elemental%20-%20Cold%20Chill.png" } } }));
  let privateReads = 0;
  game.packs.set("incarnos.monsters", { async getIndex() { privateReads++; return versions; }, async getDocument(id) { return versions.find(v => v._id === id); } });
  const documents = new Map([[item.uuid, item], [caster.uuid, caster]]);
  globalThis.fromUuid = async uuid => documents.get(uuid);
  globalThis.CONST = { REGION_VISIBILITY: { ALWAYS: 0 }, GRID_SNAPPING_MODES: { TOP_LEFT_CORNER: 1 },
    TOKEN_DISPOSITIONS: { FRIENDLY: 1 }, DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 } };
  globalThis.ui = { notifications: { info: () => {}, warn: value => warnings.push(value) } };
  globalThis.foundry = { utils: { deepClone: structuredClone, isEmpty: data => !Object.keys(data).length, randomID: () => "preview-nonce", escapeHTML: value => value },
    applications: { api: { DialogV2: { async input() { return cancelDialog ? null : { ip: tier }; }, async confirm() { return true; } } } } };
  globalThis.Folder = { async create(data) { const folder = { ...data, id: "summons-folder" }; game.folders.push(folder); return folder; } };
  game.actors.fromCompendium = source => ({ name: source.name, prototypeToken: structuredClone(source.prototypeToken), flags: {}, ownership: { default: 0 } });
  globalThis.CONFIG = { Actor: { documentClass: { async create(data) {
    imports.push(data);
    const world = { ...data, id: `world-${imports.length}`, async update(change) { Object.assign(this, change); },
      async getTokenDocument() { return { toObject: () => ({ ...structuredClone(this.prototypeToken), actorId: this.id, delta: { system: { tampered: true } } }) }; } };
    game.actors.push(world); return world;
  } } } };
  globalThis.Hooks = { on(name, callback) { (hooks[name] ??= []).push(callback); return callback; },
    once(name, callback) { (hooks[name] ??= []).push(callback); },
    off(name, callback) { hooks[name] = hooks[name].filter(entry => entry !== callback); } };
  globalThis.canvas = { ready: true, scene, level: { id: "level" }, grid: { getSnappedPoint: p => ({ x: Math.round(p.x / 100) * 100, y: Math.round(p.y / 100) * 100 }) },
    tokens: { placeables: [{ actor, document: caster, controlled: true }], activate: () => {} },
    regions: { async placeRegion(data, options) {
      placements.push({ data, options });
      assert.equal(options.create, false);
      assert.equal(options.allowRotation, false);
      const shape = { ...data.shapes[0], updateSource(changes) { Object.assign(this, changes); } };
      assert.equal(options.onMove({ shape, position: { x: 912, y: 689 } }), false);
      assert.deepEqual([shape.x, shape.y], [900, 700]);
      return cancel ? null : { shapes: [shape] };
    } } };
  globalThis.ChatMessage = { getSpeaker: () => ({}), async create(data) {
    const message = { ...data, id: `request-${cards.length}`, timestamp: Date.now(), author: game.user,
      async update(changes) {
        if (changes["flags.incarnos.summonRequest.handled"]) this.flags.incarnos.summonRequest.handled = true;
        if (changes["flags.incarnos.summonPreview"]) this.flags.incarnos.summonPreview = changes["flags.incarnos.summonPreview"];
      },
      async delete() { deletedRequests.push(this.id); } };
    cards.push(message);
    // Simulate only the GM's metadata reply on a player client with a private compendium.
    if (!gm && data.flags?.incarnos?.summonRequest?.kind === "preview") {
      if (!previewCancel) message.flags.incarnos.summonPreview = { name: versions[tier / 20].name, width: tier / 20 + 1, height: tier / 20 + 1 };
      else message.flags.incarnos.summonPreview = { error: true };
      for (const callback of hooks.updateChatMessage ?? []) callback(message, {}, {}, elected.id);
    }
    return message;
  } };
  const request = overrides => ({ id: `manual-${Math.random()}`, timestamp: Date.now(), author: player,
    flags: { incarnos: { summonRequest: { itemUuid: item.uuid, casterTokenUuid: caster.uuid, ip: tier, sceneId: scene.id,
      x: 900, y: 700, levelId: "level", ...overrides } } },
    async update(changes) {
      if (changes["flags.incarnos.summonRequest.handled"]) this.flags.incarnos.summonRequest.handled = true;
      if (changes["flags.incarnos.summonPreview"]) this.flags.incarnos.summonPreview = changes["flags.incarnos.summonPreview"];
    }, async delete() { deletedRequests.push(this.id); } });
  return { actor, item, caster, scene, encounter, versions, player, elected, other, request, documents,
    writes, cards, warnings, placements, imports, deletedRequests, hooks, privateReads: () => privateReads };
}

test("real Death fire elemental note parses four tiers, corpse and ten turns, without rolling its attack damage", () => {
  const f = setup();
  const auto = getSpellAutomation(spell);
  assert.deepEqual(auto.summon, { creature: "deathfire elemental", tiers: [
    { ip: 0, effect: "" }, { ip: 20, effect: "+1 size, +5 to all stats, +1d8 fire damage" },
    { ip: 40, effect: "+2 sizes, +10 to all stats, +2d8 fire damage" }, { ip: 60, effect: "+3 sizes, +15 to all stats, +3d8 fire damage" }
  ], turns: 10, corpse: true });
  assert.equal(auto.damage, "");
  assert.equal(describeSpellAutomation(auto), "Summons Deathfire Elemental (4 empower tiers), 10 turns");
  assert.equal(parseSpellSummon({ effect: "On cast: SPAWN AN air elemental AT a point.", duration: "1 turn" }).creature, "air elemental");
  assert.equal(parseSpellSummon({ effect: "Summons ivy vines from the ground" }), null);
  assert.equal(f.item.system.mp, 20);
});

test("version lookup is case insensitive, falls back to base, and never picks an unrelated pack", async () => {
  const f = setup();
  assert.equal((await findSummonVersion("DEATHFIRE ELEMENTAL", 40)).actor.name, "Deathfire Elemental +40 IP");
  f.versions.splice(2, 1);
  const fallback = await findSummonVersion("Deathfire Elemental", 40);
  assert.equal(fallback.actor.name, "Deathfire Elemental");
  assert.equal(fallback.fallback, true);
  assert.equal(fallback.requested, "Deathfire Elemental +40 IP");
  assert.equal(await findSummonVersion("Unknown"), null);
  game.packs.clear();
  assert.equal(await findSummonVersion("Deathfire Elemental"), null);
});

test("tier cost uses existing IP and Abomination HP pools and never charges AP outside combat", async () => {
  for (const tier of [0, 20, 40, 60]) {
    const f = setup({ tier });
    assert.deepEqual(await getCastCost(f.item, tier), { mp: 20 + tier, actions: 2 });
    await castSpell(f.item);
    assert.deepEqual(f.writes, [{ "system.power.value": 180 - tier }]);
    assert.equal(f.scene.tokens.at(-1).width, tier / 20 + 1);
  }
  const f = setup({ tier: 60 });
  f.actor.items.push({ type: "race", system: { bonus: "You have no IP. Instead gain HP and all spells use HP." } });
  await castSpell(f.item);
  assert.deepEqual(f.writes, [{ "system.health.value": 120 }]);
  assert.match(f.cards.at(-1).content, /80 HP/);
});

test("summon range matches rectangle origin measurement, including exactly 12m and decimal commas", () => {
  const f = setup();
  assert.equal(summonInRange(spell, f.caster, { x: 1350, y: 550 }, f.scene), true);
  assert.equal(summonInRange(spell, f.caster, { x: 1350.1, y: 550 }, f.scene), false);
  assert.equal(summonInRange({ range: "1,5m" }, f.caster, { x: 650, y: 550 }, f.scene), true);
  assert.equal(summonInRange(spell, f.caster, { x: NaN, y: 550 }, f.scene), false);
});

test("GM request validation rejects spoofed author, ownership, tier, range, coordinates, scene, token and stale/replayed requests", async () => {
  const f = setup({ combat: true });
  assert.ok(await validateSummonRequest(f.request(), f.player.id));
  const invalid = [f.request({ ip: 80 }), f.request({ ip: "20" }), f.request({ sceneId: "other" }), f.request({ x: Infinity }),
    f.request({ x: -1 }), f.request({ x: 2900 }), f.request({ x: 1500 }), f.request({ x: 1500, rangeOverride: true }),
    f.request({ levelId: "missing" }), f.request({ itemUuid: "not-an-item" }), f.request({ casterTokenUuid: f.item.uuid }),
    f.request({ handled: true }), { ...f.request(), timestamp: Date.now() - 121000 }, { ...f.request(), author: f.other }];
  for (const request of invalid) assert.equal(await validateSummonRequest(request, f.player.id), null);
  f.actor.testUserPermission = () => false;
  assert.equal(await validateSummonRequest(f.request(), f.player.id), null);
  assert.deepEqual(f.writes, []);
});

test("players are range blocked; only a GM author can request an out-of-range override", async () => {
  const f = setup({ gm: false, tier: 20 });
  await castSpell(f.item);
  const { options } = f.placements[0];
  assert.equal(options.preConfirm({ shape: { x: 1500, y: 550 } }), false);
  assert.equal(options.preConfirm({ shape: { x: 1300, y: 550 } }), undefined);
  assert.equal(f.privateReads(), 0, "player preview never reads GM-only monster data");
  const request = f.request({ x: 1500, rangeOverride: true });
  assert.equal(await validateSummonRequest(request, f.player.id), null);
  request.author = f.elected;
  assert.ok(await validateSummonRequest(request, f.elected.id));
  assert.deepEqual(f.writes, [], "a player submits an intent; only the GM pays");
});

test("only elected GM fulfills once, pays authoritative tier cost, creates friendly unlinked token and same-initiative combatant", async () => {
  const f = setup({ combat: true, tier: 40 });
  const request = f.request({ selectedCost: { actions: 0, mp: 0 }, width: 99, actorId: "spoof", turns: 999 });
  game.user = f.other;
  assert.equal(await processSummonRequest(request, f.player.id), false);
  game.user = f.elected;
  const results = await Promise.all([processSummonRequest(request, f.player.id), processSummonRequest(request, f.player.id)]);
  assert.deepEqual(results, [true, false]);
  assert.equal(await processSummonRequest(request, f.player.id), false);
  assert.deepEqual(f.writes, [{ "system.actionpoints.value": 1 }, { "system.power.value": 140 }]);
  const token = f.scene.tokens.at(-1);
  assert.equal(token.width, 3);
  assert.equal(token.height, 3);
  assert.equal(token.disposition, 1);
  assert.equal(token.actorLink, false);
  assert.equal(token.actorId, game.actors[0].id);
  assert.equal(token.delta, undefined);
  assert.equal(token.name, "Deathfire Elemental +40 IP");
  assert.equal(token.level, "level");
  assert.deepEqual(token.flags.incarnos.summon, { casterUuid: f.actor.uuid, spell: spell.name, turnsLeft: 10 });
  assert.equal(token.texture.src, f.versions[2].prototypeToken.texture.src);
  const combatant = f.encounter.combatants.at(-1);
  assert.equal(combatant.initiative, 18);
  assert.equal(combatant.flags.incarnos.summonAfter, "caster-combatant");
  assert.equal(game.actors[0].ownership.player, 3);
  assert.equal(game.actors[0].folder, "summons-folder");
  assert.match(f.cards[0].content, /Deathfire Elemental \+40 IP.*3 × 3 squares.*10 turns/);
  assert.match(f.cards[0].content, /Place it on a corpse/);
});

test("world actor is reused by version and keeps existing owners when another caster summons it", async () => {
  const f = setup({ tier: 20 });
  await processSummonRequest(f.request(), f.player.id);
  game.actors[0].ownership.existing = 3;
  game.users.push({ id: "second-player", isGM: false, active: true });
  f.actor.testUserPermission = user => ["second-player", "player"].includes(user.id);
  await processSummonRequest(f.request(), f.player.id);
  assert.equal(f.imports.length, 1);
  assert.equal(game.folders.length, 1);
  assert.deepEqual(game.actors[0].ownership, { default: 0, player: 3, existing: 3, "second-player": 3 });
});

test("missing empowered actor creates base size, charges chosen tier and puts an escaped warning on the card", async () => {
  const f = setup({ tier: 60 });
  f.versions.pop();
  f.item.name = "<script>spell</script>";
  await processSummonRequest(f.request(), f.player.id);
  assert.equal(f.scene.tokens.at(-1).width, 1);
  assert.deepEqual(f.writes, [{ "system.power.value": 120 }]);
  assert.match(f.cards[0].content, /Missing version deathfire elemental \+60 IP; summoned Deathfire Elemental instead/);
  assert.match(f.cards[0].content, /&lt;script&gt;spell&lt;\/script&gt;/);
  assert.doesNotMatch(f.cards[0].content, /<script>/);
});

test("cancelling tier, right-click/Esc placement, or GM range override spends nothing and creates nothing", async () => {
  for (const options of [{ cancelDialog: true }, { cancel: true }, { gm: false, cancel: true }]) {
    const f = setup({ combat: true, ...options });
    assert.equal(await castSpell(f.item), undefined);
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.imports, []);
    assert.equal(f.scene.tokens.length, 1);
  }
  const f = setup({ combat: true });
  canvas.regions.placeRegion = async () => ({ shapes: [{ x: 1600, y: 550 }] });
  foundry.applications.api.DialogV2.confirm = async () => false;
  assert.equal(await castSpell(f.item), undefined);
  assert.deepEqual(f.writes, []);
});

test("GM preview request exposes only version name and dimensions, with no payment or imported actors", async () => {
  const f = setup({ tier: 60 });
  const request = f.request({ kind: "preview", nonce: "test" });
  assert.equal(await processSummonRequest(request, f.player.id), true);
  assert.deepEqual(request.flags.incarnos.summonPreview, { name: "Deathfire Elemental +60 IP", width: 4, height: 4,
    fallback: false, requested: "deathfire elemental +60 IP" });
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.imports, []);
});

test("players with insufficient AP/IP and inactive/paused scenes never create a token or get a GM cost override", async () => {
  for (const mode of ["AP", "IP", "paused", "viewedScene", "noGM"]) {
    const f = setup({ combat: true, tier: 60 });
    if (mode === "AP") f.actor.system.actionpoints.value = 1;
    if (mode === "IP") f.actor.system.power.value = 79;
    if (mode === "paused") game.paused = true;
    if (mode === "viewedScene") f.player.viewedScene = "other";
    if (mode === "noGM") f.elected.active = false;
    assert.equal(await processSummonRequest(f.request(), f.player.id), false);
    assert.equal(f.scene.tokens.length, 1);
    assert.deepEqual(f.writes, []);
  }
});

test("a rejected token creation refunds tier IP and AP", async () => {
  const f = setup({ combat: true, tier: 40 });
  f.scene.createEmbeddedDocuments = async () => [];
  const original = console.error;
  console.error = () => {};
  try { assert.equal(await processSummonRequest(f.request(), f.player.id), false); }
  finally { console.error = original; }
  assert.equal(f.actor.system.power.value, 200);
  assert.equal(f.actor.system.actionpoints.value, 3);
  assert.equal(f.scene.tokens.length, 1);
});

test("summons sort directly after their caster at equal initiative, before unrelated ties", () => {
  const combat = { combatants: collection([]) };
  const make = (id, initiative, caster) => ({ id, initiative, parent: combat, flags: { incarnos: { summonAfter: caster } } });
  const caster = make("b", 18), summon = make("z", 18, "b"), tie = make("c", 18), first = make("a", 19), last = make("d", 17);
  combat.combatants.push(last, tie, summon, first, caster);
  const original = (a, b) => b.initiative - a.initiative || a.id.localeCompare(b.id);
  assert.deepEqual([...combat.combatants].sort((a, b) => sortSummonCombatants(a, b, original)).map(c => c.id), ["a", "b", "z", "c", "d"]);
  summon.initiative = 16;
  assert.deepEqual([...combat.combatants].sort((a, b) => sortSummonCombatants(a, b, original)).map(c => c.id), ["a", "b", "c", "d", "z"]);
});

test("inserting/removing a summon preserves a later active combatant without emitting turn events", async () => {
  const f = setup({ combat: true });
  const caster = f.encounter.combatants[0];
  const active = { id: "active", initiative: 10, parent: f.encounter };
  f.encounter.combatants.push(active);
  f.encounter.combatant = active;
  let addition, removal;
  f.encounter.createEmbeddedDocuments = async (type, data, options) => {
    addition = options;
    const created = { ...data[0], id: data[0]._id, parent: f.encounter };
    f.encounter.combatants.push(created);
    return [created];
  };
  f.encounter.deleteEmbeddedDocuments = async (type, ids, options) => { removal = options; };
  const [summon] = await addSummonCombatant(f.encounter, { initiative: caster.initiative,
    flags: { incarnos: { summonAfter: caster.id } } });
  assert.deepEqual(addition, { keepId: true, turnEvents: false, combatTurn: 2 });
  await removeSummonCombatants(f.encounter, [summon.id]);
  assert.deepEqual(removal, { turnEvents: false, combatTurn: 1 });
});

test("combatant rejection also removes the new token and refunds the complete tier cost", async () => {
  const f = setup({ combat: true, tier: 60 });
  f.encounter.createEmbeddedDocuments = async () => [];
  const original = console.error;
  console.error = () => {};
  try { assert.equal(await processSummonRequest(f.request(), f.player.id), false); }
  finally { console.error = original; }
  assert.equal(f.scene.tokens.length, 1);
  assert.equal(f.encounter.combatants.length, 1);
  assert.equal(f.actor.system.power.value, 200);
  assert.equal(f.actor.system.actionpoints.value, 3);
});

test("existing end-of-turn flow decrements once per caster turn and removes token/combatant on the tenth turn", async () => {
  const f = setup({ combat: true });
  await processSummonRequest(f.request(), f.player.id);
  const summon = f.scene.tokens.at(-1);
  const prior = round => ({ round, turn: 0, combatantId: "caster-combatant" });
  const next = round => ({ round, turn: 1, combatantId: "enemy" });
  await tickSummons(f.encounter, { round: 0, turn: null }, prior(1));
  await tickSummons(f.encounter, next(1), prior(1));
  game.user = f.other;
  await tickSummons(f.encounter, prior(1), next(1));
  assert.equal(summon.flags.incarnos.summon.turnsLeft, 10);
  game.user = f.elected;
  for (let round = 1; round <= 9; round++) {
    await replenishCombatTurn(f.encounter, prior(round), next(round));
    await tickSummons(f.encounter, prior(round), next(round));
    assert.equal(summon.flags.incarnos.summon.turnsLeft, 10 - round);
  }
  await replenishCombatTurn(f.encounter, prior(10), next(10));
  assert.equal(summon.deleted, true);
  assert.equal(f.encounter.combatants.length, 1);
  assert.equal(f.scene.tokens.length, 1);
  assert.match(f.cards.at(-1).content, /Deathfire Elemental fades/);
});

test("outside combat, other actors' turns, round wrap and solo forward turns respect caster duration", async () => {
  const f = setup({ combat: true });
  await processSummonRequest(f.request(), f.player.id);
  const summon = f.scene.tokens.at(-1);
  const prior = { round: 1, turn: 0, combatantId: "caster-combatant" };
  const next = { round: 2, turn: 0, combatantId: "caster-combatant" };
  f.encounter.started = false;
  await tickSummons(f.encounter, prior, next);
  assert.equal(summon.flags.incarnos.summon.turnsLeft, 10);
  f.encounter.started = true;
  await tickSummons(f.encounter, { ...prior, combatantId: "other" }, next);
  assert.equal(summon.flags.incarnos.summon.turnsLeft, 10);
  await tickSummons(f.encounter, prior, next);
  assert.equal(summon.flags.incarnos.summon.turnsLeft, 9);
});

test("hidden summon request messages are not rendered in chat", () => {
  const f = setup();
  registerSummonHooks();
  const html = { style: {} };
  for (const callback of f.hooks.renderChatMessageHTML) callback(f.request(), html);
  assert.equal(html.style.display, "none");
});
