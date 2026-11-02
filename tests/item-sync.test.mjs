import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ITEM_SYNC_PACKS, ITEM_SYNC_PLAY_STATE, itemSyncHash, itemSyncKey, itemSourceUuid, itemSyncStatus,
  indexItemSources, findItemSource, planItemSync, syncItemsFromCompendiums, canResetItemSync,
  resetItemToCompendium, registerItemSyncHooks
} from "../module/helpers/item-sync.mjs";

const uuid = (type = "weapon", id = "source") => `Compendium.incarnos.${ITEM_SYNC_PACKS[type]}.Item.${id}`;
const source = (type = "weapon") => ({
  _id: "source", type, name: "Example", img: "example.webp",
  system: { description: "Rules", passivesEnabled: true, passives: {},
    ...(type === "weapon" ? { damage: "d6", quantity: 1, weight: 0 } : {}),
    ...(type === "spell" ? { element: "Plants", effect: "Heal" } : {}) }
});
const linked = (type = "weapon") => {
  const data = source(type);
  return { ...data, _id: "owned", _stats: { compendiumSource: uuid(type) },
    flags: { incarnos: { sourceUuid: uuid(type), syncHash: itemSyncHash(data), customized: false } } };
};

/** Foundry-like nonrecursive root-field writes, plus flattened flags for the edit hook. */
function document(data) {
  return {
    ...structuredClone(data), isOwner: true,
    toObject() { return structuredClone(Object.fromEntries(Object.entries(this).filter(([key, value]) =>
      typeof value !== "function" && !["isOwner", "pack", "parent"].includes(key)))); },
    async update(update, options) { apply(this, update, options); }
  };
}
function apply(doc, update, options) {
  if (Object.hasOwn(update, "system")) {
    assert.equal(options?.recursive, false, "replace whole system so removed rules do not linger");
    assert.equal(options?.diff, false);
  }
  for (const [key, value] of Object.entries(update)) {
    if (key === "flags.incarnos.customized") doc.flags.incarnos.customized = value;
    else doc[key] = structuredClone(value);
  }
}

function setup() {
  const notifications = [], whispers = [], writes = [], reads = [], hooks = {};
  const translations = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
  const user = { id: "gm", isGM: true, active: true };
  const sources = new Map(Object.keys(ITEM_SYNC_PACKS).map(type => [type, [source(type)]]));
  globalThis.game = {
    user, users: [user, { id: "player", active: true, isGM: false }, { id: "otherGM", isGM: true, active: false }],
    actors: [], scenes: { contents: [] }, items: [],
    packs: new Map(Object.entries(ITEM_SYNC_PACKS).map(([type, name]) => [`incarnos.${name}`, {
      async getDocuments() { reads.push(type); return sources.get(type).map(data => ({ uuid: uuid(type, data._id), toObject: () => structuredClone(data) })); },
      async getDocument(id) { const data = sources.get(type).find(entry => entry._id === id); return data ? document(data) : null; }
    }])),
    i18n: { localize: key => translations[key] ?? key,
      format: (key, values) => Object.entries(values).reduce((text, [field, value]) => text.replaceAll(`{${field}}`, value), translations[key]) }
  };
  globalThis.ui = { notifications: { info: text => notifications.push(text), warn: text => notifications.push(text) } };
  globalThis.ChatMessage = { create: async data => whispers.push(data) };
  globalThis.Item = { async updateDocuments(updates, options) {
    writes.push(["world", updates]);
    for (const update of updates) apply(game.items.find(item => item._id === update._id), update, options);
  } };
  globalThis.Hooks = { once: (name, handler) => { hooks[name] = handler; }, on: (name, handler) => { hooks[name] = handler; } };
  globalThis.foundry = { applications: { api: { DialogV2: { confirm: async () => true } } } };
  const actor = (id, items) => ({ id, name: id, items: items.map(document),
    async updateEmbeddedDocuments(type, updates, options) {
      assert.equal(type, "Item");
      writes.push([id, updates]);
      for (const update of updates) apply(this.items.find(item => item._id === update._id), update, options);
    }
  });
  return { notifications, whispers, writes, reads, hooks, sources, actor };
}

test("content fingerprints ignore all documented play state and document metadata, with stable nested key order", () => {
  const original = source();
  const before = structuredClone(original);
  const changed = structuredClone(original);
  for (const field of ITEM_SYNC_PLAY_STATE.system) changed.system[field] = { value: 3, max: 10 };
  for (const field of ITEM_SYNC_PLAY_STATE.document) changed[field] = { arbitrary: true };
  assert.equal(itemSyncHash(original), itemSyncHash(changed));
  changed.system = Object.fromEntries(Object.entries(original.system).reverse());
  assert.equal(itemSyncHash(original), itemSyncHash(changed));
  for (const change of [{ name: "Custom" }, { img: "custom.webp" }, { system: { ...original.system, damage: "d8" } },
    { system: { ...original.system, passives: { one: { stat: "health.max", value: 5 } } } }]) {
    assert.notEqual(itemSyncHash(original), itemSyncHash({ ...original, ...change }));
  }
  assert.deepEqual(original, before);
});

test("unchanged baselined items of every pack receive name, image and rules edits by ID", () => {
  for (const type of Object.keys(ITEM_SYNC_PACKS)) {
    const owned = linked(type), next = source(type);
    next.name = "Renamed"; next.img = "new.webp"; next.system.description = "New rules";
    const before = structuredClone([owned, next]);
    const result = planItemSync(owned, next, uuid(type));
    assert.equal(result.updated, true);
    assert.equal(result.customized, false);
    assert.equal(result.update.name, next.name);
    assert.equal(result.update.img, next.img);
    assert.equal(result.update.system.description, "New rules");
    assert.equal(result.update.flags.incarnos.syncHash, itemSyncHash(next));
    assert.deepEqual([owned, next], before);
  }
});

test("updates preserve quantity, weight, switches, uses, charges and unrelated flags, but replace removed rules", () => {
  const owned = linked();
  for (const key of ITEM_SYNC_PLAY_STATE.system) owned.system[key] = key === "uses" ? { value: 1, max: 4 } : 7;
  owned.flags.module = { note: "keep" }; owned.flags.incarnos.other = "keep too";
  owned.sort = 42; owned.folder = "inventory"; owned.ownership = { player: 3 }; owned.effects = [{ _id: "active" }];
  const next = source();
  next.system.description = "New rules";
  delete next.system.damage;
  const { update } = planItemSync(owned, next, uuid());
  const doc = document(owned);
  apply(doc, update, { recursive: false, diff: false });
  for (const key of ITEM_SYNC_PLAY_STATE.system) assert.deepEqual(doc.system[key], owned.system[key], key);
  for (const key of ITEM_SYNC_PLAY_STATE.document.filter(key => key !== "flags")) assert.deepEqual(doc[key], owned[key], key);
  assert.equal(doc.flags.module.note, "keep");
  assert.equal(doc.flags.incarnos.other, "keep too");
  assert.equal(doc.system.damage, undefined);
  assert.equal(doc.flags.incarnos.syncHash, itemSyncHash(doc));
});

test("hand-edited content is skipped and flagged; customization stays sticky even if content later matches", () => {
  const owned = linked(); owned.system.damage = "d12";
  const result = planItemSync(owned, source(), uuid());
  assert.equal(result.updated, false);
  assert.equal(result.customized, true);
  assert.deepEqual(Object.keys(result.update).sort(), ["_id", "flags"]);
  assert.equal(result.update.flags.incarnos.customized, true);
  assert.equal(result.update.flags.incarnos.syncHash, owned.flags.incarnos.syncHash);
  const customized = { ...source(), flags: result.update.flags };
  assert.equal(planItemSync(customized, source(), uuid()).update, null);
  assert.equal(itemSyncStatus(customized).customized, true);
});

test("no-hash migration baselines identical items, refreshes old spells and protects differing weapons, talents and races", () => {
  for (const type of Object.keys(ITEM_SYNC_PACKS)) {
    const owned = source(type); owned._id = "owned";
    const same = planItemSync(owned, source(type), uuid(type));
    assert.equal(same.updated, false);
    assert.equal(same.customized, false);
    assert.equal(same.update.flags.incarnos.syncHash, itemSyncHash(owned));
    owned.system.description = "Old rules or custom text";
    const result = planItemSync(owned, source(type), uuid(type));
    assert.equal(result.updated, type === "spell");
    assert.equal(result.customized, type !== "spell");
    assert.equal(result.warn, type !== "spell");
    assert.equal(Boolean(result.update.system), type === "spell");
    assert.ok(result.update.flags.incarnos.syncHash);
  }
});

test("fallback links are type/name specific, spells also use element, and ambiguity or a missing ID never guesses", () => {
  const entries = Object.keys(ITEM_SYNC_PACKS).map(type => ({ uuid: uuid(type), source: source(type) }));
  entries.push({ uuid: uuid("spell", "air"), source: { ...source("spell"), system: { element: "Air" } } });
  const index = indexItemSources(entries);
  for (const type of Object.keys(ITEM_SYNC_PACKS)) {
    const owned = source(type); owned.name = " eXamPle ";
    const entry = findItemSource(owned, index);
    assert.equal(entry.uuid, uuid(type));
    const result = planItemSync(owned, entry.source, entry.uuid);
    assert.equal(result.update.flags.incarnos.sourceUuid, uuid(type));
    owned.flags = result.update.flags;
    owned.name = "Now renamed on actor";
    assert.equal(findItemSource(owned, index).uuid, uuid(type));
  }
  assert.notEqual(itemSyncKey(source("spell")), itemSyncKey(entries.at(-1).source));
  for (const link of [uuid("weapon", "missing"), uuid("spell"), "Compendium.other.weapons.Item.source"]) {
    assert.equal(findItemSource({ ...source(), _stats: { compendiumSource: link } }, index), null);
  }
  assert.equal(findItemSource({ ...source(), type: "item" }, index), null);
  const ambiguous = indexItemSources([entries[0], { ...entries[0], uuid: uuid("weapon", "duplicate") }]);
  assert.equal(findItemSource(source(), ambiguous), null);
  assert.equal(itemSourceUuid({ ...source(), _stats: { compendiumSource: "Compendium.incarnos.weapons.source" } }), uuid());
});

test("ready sync batches actors, covers synthetic tokens and world items, warns GMs once and is idempotent", async () => {
  const { notifications, whispers, writes, actor } = setup();
  const weapon = linked(), custom = linked("feature"), oldRace = source("race"), oldSpell = source("spell");
  weapon._id = "weapon"; custom._id = "talent";
  custom.name = "Custom talent";
  oldRace._id = "race"; oldRace.system.description = "Old race";
  oldSpell._id = "spell"; oldSpell.system.effect = "Old effect";
  const pc = actor("Example actor", [weapon, custom, oldRace, oldSpell]);
  game.actors = [pc];
  const token = actor("Synthetic", [{ ...linked(), _id: "tokenWeapon" }]);
  const ignored = actor("Linked token", [linked()]);
  game.scenes.contents = [{ tokens: [{ actorLink: false, actor: token }, { actorLink: true, actor: ignored },
    { actorLink: false, actor: null }, { actorLink: false, actor: token }] }];
  game.items = [document({ ...linked(), _id: "worldWeapon" })];
  game.packs.get("incarnos.weapons").getDocuments = async () => [{ uuid: uuid(), toObject: () => ({ ...source(), name: "New weapon" }) }];
  assert.equal(await syncItemsFromCompendiums(), 4);
  assert.deepEqual(writes.map(write => write[0]), ["Example actor", "Synthetic", "world"]);
  assert.equal(writes[0][1].length, 4);
  assert.equal(pc.items[1].name, "Custom talent");
  assert.equal(pc.items[2].system.description, "Old race");
  assert.equal(ignored.items[0].name, "Example");
  assert.equal(whispers.length, 1);
  assert.deepEqual(whispers[0].whisper, ["gm", "otherGM"]);
  assert.match(whispers[0].content, /1 items differ.*Example actor – Example.*Reset to compendium/);
  assert.deepEqual(notifications, ["Incarnos: 4 items updated from the compendiums, 2 customized left alone"]);
  writes.length = 0;
  assert.equal(await syncItemsFromCompendiums(), 0);
  assert.deepEqual(writes, []);
  assert.equal(whispers.length, 1);
  assert.equal(notifications.length, 1);
});

test("first active GM only, with missing packs and empty worlds allowed", async () => {
  const { reads, writes, notifications } = setup();
  game.user.isGM = false;
  assert.equal(await syncItemsFromCompendiums(), 0);
  game.user.isGM = true;
  game.users.push({ id: "a", active: true, isGM: true });
  assert.equal(await syncItemsFromCompendiums(), 0);
  assert.deepEqual(reads, []);
  assert.deepEqual(writes, []);
  game.users.pop(); game.packs.clear();
  assert.equal(await syncItemsFromCompendiums(), 0);
  assert.deepEqual(notifications, []);
});

test("baseline-only linking is silent, and migration whispers escape actor and item names", async () => {
  const { actor, notifications, whispers, sources } = setup();
  game.actors = [actor("Test", [source()])];
  await syncItemsFromCompendiums();
  assert.deepEqual(notifications, []);
  assert.deepEqual(whispers, []);
  assert.equal(game.actors[0].items[0].flags.incarnos.sourceUuid, uuid());
  const race = source("race"); race.name = "<Race>";
  sources.get("race")[0].name = race.name;
  race.system.description = "Old rules";
  game.actors.push(actor("<Actor & name>", [race]));
  await syncItemsFromCompendiums();
  assert.match(whispers[0].content, /&lt;Actor &amp; name&gt; – &lt;Race&gt;/);
  assert.ok(!whispers[0].content.includes("<Race>"));
});

test("reset requires GM or owner and confirmation, preserves state, clears customization and resumes sync", async () => {
  const { sources } = setup();
  const doc = document(linked()); doc.name = "Custom"; doc.system.quantity = 5;
  doc.flags.incarnos.customized = true;
  const snapshot = doc.toObject();
  game.user.isGM = false; doc.isOwner = false;
  foundry.applications.api.DialogV2.confirm = async () => { assert.fail("Unauthorized confirmation"); };
  assert.equal(canResetItemSync(doc), false);
  assert.equal(await resetItemToCompendium(doc), false);
  doc.isOwner = true;
  foundry.applications.api.DialogV2.confirm = async () => false;
  assert.equal(await resetItemToCompendium(doc), false);
  assert.deepEqual(doc.toObject(), snapshot);
  foundry.applications.api.DialogV2.confirm = async options => {
    assert.match(options.content, /Manual content edits will be lost/);
    doc.system.quantity = 6;
    return true;
  };
  assert.equal(await resetItemToCompendium(doc), true);
  assert.equal(doc.name, "Example");
  assert.equal(doc.system.quantity, 6);
  assert.equal(doc.flags.incarnos.customized, false);
  assert.equal(itemSyncStatus(doc).customized, false);
  sources.get("weapon")[0].system.damage = "d8";
  assert.equal(planItemSync(doc.toObject(), sources.get("weapon")[0], uuid()).updated, true);
  doc.isOwner = false; game.user.isGM = true;
  assert.equal(canResetItemSync(doc), true);
});

test("reset never falls back when a linked entry is missing, and compendium sheets cannot reset themselves", async () => {
  const { notifications, sources } = setup();
  const doc = document(linked());
  doc.pack = "incarnos.weapons";
  assert.equal(canResetItemSync(doc), false);
  delete doc.pack;
  sources.set("weapon", []);
  const snapshot = doc.toObject();
  assert.equal(await resetItemToCompendium(doc), false);
  assert.deepEqual(doc.toObject(), snapshot);
  assert.match(notifications[0], /entry is missing/);
});

test("creation hooks baseline new drops immediately and protect new hand-edited spells without legacy migration", async () => {
  const { hooks } = setup();
  registerItemSyncHooks();
  for (const type of Object.keys(ITEM_SYNC_PACKS)) {
    const data = source(type); data._stats = { compendiumSource: uuid(type) };
    const doc = document(data);
    await hooks.createItem(doc, {}, "player");
    assert.equal(doc.flags, undefined, "only creator writes");
    await hooks.createItem(doc, {}, "gm");
    assert.equal(doc.flags.incarnos.syncHash, itemSyncHash(doc));
    assert.equal(doc.flags.incarnos.customized, false);
    doc.system.description = "Manual rules";
    assert.equal(itemSyncStatus(doc).customized, true, "status detects edits even before hook write");
    await hooks.updateItem(doc, {}, {}, "gm");
    assert.equal(doc.flags.incarnos.customized, true);
  }
  const data = source("spell"); data.system.effect = "Custom"; data._stats = { compendiumSource: uuid("spell") };
  const custom = document(data);
  await hooks.createItem(custom, {}, "gm");
  assert.equal(custom.system.effect, "Custom");
  assert.equal(custom.flags.incarnos.customized, true);
});

test("play-state edits and compendium writes never mark customization or mutate compendium sync flags", async () => {
  const { hooks } = setup();
  registerItemSyncHooks();
  const doc = document(linked()); doc.system.quantity = 5; doc.system.passivesEnabled = false;
  await hooks.updateItem(doc, {}, {}, "gm");
  assert.equal(doc.flags.incarnos.customized, false);
  doc.pack = "incarnos.weapons"; doc.system.damage = "d100";
  await hooks.updateItem(doc, {}, {}, "gm");
  await hooks.createItem(doc, {}, "gm");
  assert.equal(doc.flags.incarnos.customized, false);
});

test("item status distinguishes unlinked, synced and customized, excluding play state", () => {
  assert.equal(itemSyncStatus(source()), null);
  const data = linked();
  assert.deepEqual(itemSyncStatus(data), { customized: false });
  data.system.quantity = 9;
  assert.deepEqual(itemSyncStatus(data), { customized: false });
  data.img = "hand-drawn.webp";
  assert.deepEqual(itemSyncStatus(data), { customized: true });
});
