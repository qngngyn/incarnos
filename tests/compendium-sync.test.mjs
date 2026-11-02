import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { compendiumData, unpackCompendiumSource, diffCompendiumDocuments, syncCompendium, syncCompendiumsFromSource } from "../module/helpers/compendium-sync.mjs";
import { registerSpellRefreshHooks } from "../module/helpers/spell-refresh.mjs";

const spell = (id, effect = "new text") => ({
  _id: id, name: "Leaf wind", type: "spell", img: "leaf.webp",
  system: { element: "Plants", effect }, effects: [], folder: "plants", sort: 100000, flags: {}, ownership: { default: 0 }
});
const folder = (id = "plants") => ({ _id: id, name: "Plants", type: "Item", folder: null, sorting: "m", sort: 1, color: null, description: "Affinity", flags: {} });
const stored = data => ({ toObject: () => structuredClone(data), uuid: `Compendium.incarnos.spells.Item.${data._id}` });

test("diff ignores storage metadata and object key order, without changing its inputs", () => {
  const source = { ...spell("a"), _key: "!items!a", _stats: { modifiedTime: null } };
  const current = { ...spell("a"), system: { effect: "new text", element: "Plants" }, _stats: { modifiedTime: 123 } };
  const before = structuredClone([source, current]);
  assert.deepEqual(diffCompendiumDocuments([source], [current]), { create: [], update: [], delete: [] });
  assert.deepEqual([source, current], before);
});

test("diff creates, updates and removes by ID, including fields and nested values replaced by the source", () => {
  const source = spell("a");
  const old = { ...spell("a", "old text"), flags: { stale: true } };
  assert.deepEqual(diffCompendiumDocuments([source, spell("new")], [old, spell("gone")]), {
    create: [spell("new")], update: [source], delete: ["gone"]
  });
  for (const [field, value] of Object.entries({ name: "renamed", img: "old.webp", type: "feature", folder: null, sort: 2, effects: [{ _id: "effect" }], ownership: { default: 1 } })) {
    assert.equal(diffCompendiumDocuments([source], [{ ...source, [field]: value }]).update.length, 1, field);
  }
});

test("real source files decode Leaf wind and monster embedded records into complete document sources", () => {
  const plants = JSON.parse(readFileSync(new URL("../packs/_source/spells/plants.json", import.meta.url), "utf8"));
  const spells = unpackCompendiumSource(plants, "Item");
  assert.equal(spells.folders[0].name, "Plants");
  assert.match(spells.documents.find(doc => doc.name === "Leaf wind").system.effect, /Regenerating 2/);
  const records = JSON.parse(readFileSync(new URL("../packs/_source/monsters/monsters.json", import.meta.url), "utf8"));
  const monsters = unpackCompendiumSource(records, "Actor");
  assert.ok(monsters.documents.length);
  assert.ok(monsters.documents.some(doc => doc.items.length));
  for (const doc of monsters.documents) {
    assert.equal(doc._key, undefined);
    for (const item of doc.items) {
      assert.equal(typeof item, "object");
      assert.equal(item._key, undefined);
      assert.equal(item._stats, undefined);
    }
  }
});

test("actor items, effects and prototype token changes are diffed, ignoring embedded metadata", () => {
  const item = { ...spell("bite"), _key: "!actors.items!actor.bite", _stats: { modifiedTime: 1 } };
  const records = [{ _id: "actor", _key: "!actors!actor", items: ["bite"], prototypeToken: { texture: { src: "new.webp" } } }, item];
  const { documents } = unpackCompendiumSource(records, "Actor");
  const current = structuredClone(documents);
  current[0].items[0]._stats = { modifiedTime: 999 };
  assert.equal(diffCompendiumDocuments(documents, current).update.length, 0);
  current[0].items.push(spell("removed"));
  current[0].prototypeToken.texture.src = "old.webp";
  assert.deepEqual(diffCompendiumDocuments(documents, current).update, documents);
  assert.deepEqual(compendiumData(documents), documents);
});

test("broken embedded references and duplicate records fail before diffing", () => {
  assert.throws(() => unpackCompendiumSource([{ _id: "a", _key: "!actors!a", items: ["missing"] }], "Actor"), /Missing embedded/);
  const record = { ...spell("a"), _key: "!items!a" };
  assert.throws(() => unpackCompendiumSource([record, record], "Item"), /duplicate/);
  assert.throws(() => unpackCompendiumSource([{ ...record, _key: "!items!wrong" }], "Item"), /Invalid compendium source key/);
  assert.throws(() => unpackCompendiumSource([record], "Actor"), /Invalid compendium source key/);
});

/** Minimal database API mock: normalization adds defaults like Foundry, writes replace complete root fields. */
function setup({ locked = true, failWrite = false, packs = ["spells"] } = {}) {
  const calls = [], notifications = [];
  const databases = new Map();
  const normalized = source => {
    const data = structuredClone(source);
    if (data.system) data.system = { description: "", ...data.system };
    return data;
  };
  const api = kind => ({
    fromSource: data => stored(normalized(data)),
    async createDocuments(data, options) {
      calls.push([kind, "create", structuredClone(data), options]);
      assert.equal(options.keepId, true);
      assert.equal(databases.get(options.pack).pack.locked, false);
      for (const doc of data) databases.get(options.pack)[kind].set(doc._id, normalized(doc));
    },
    async updateDocuments(data, options) {
      calls.push([kind, "update", structuredClone(data), options]);
      assert.equal(options.recursive, false);
      assert.equal(options.diff, false);
      assert.equal(databases.get(options.pack).pack.locked, false);
      if (failWrite) throw new Error("write failed");
      for (const doc of data) databases.get(options.pack)[kind].set(doc._id, normalized(doc));
    },
    async deleteDocuments(ids, options) {
      calls.push([kind, "delete", ids, options]);
      assert.equal(databases.get(options.pack).pack.locked, false);
      for (const id of ids) databases.get(options.pack)[kind].delete(id);
    }
  });
  for (const name of packs) {
    const state = { documents: new Map(), folders: new Map() };
    const pack = {
      collection: `incarnos.${name}`, locked, documentClass: api("documents"),
      getDocuments: async () => [...state.documents.values()].map(stored),
      folders: { get contents() { return [...state.folders.values()].map(stored); } },
      async configure(config) { calls.push(["configure", config]); this.locked = config.locked; },
      render: () => calls.push(["render"])
    };
    state.pack = pack;
    databases.set(pack.collection, state);
  }
  const translations = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
  globalThis.foundry = {
    utils: { deepClone: structuredClone, getRoute: path => `/table/${path}` },
    documents: { Folder: { implementation: api("folders") } },
    applications: { apps: { FilePicker: { implementation: {
      async browse(storage, directory) {
        calls.push(["browse", storage, directory]);
        return { files: [`${directory}/source.json`, `${directory}/ignored.txt`] };
      }
    } } } }
  };
  globalThis.fetch = async (url, options) => {
    calls.push(["fetch", url, options]);
    const actor = url.includes("/monsters/");
    if (url.includes("/critical-failures/")) return { ok: true, json: async () => [
      { _id: "table", _key: "!tables!table", name: "Critical Failure", formula: "1d1", replacement: true, results: ["result"] },
      { _id: "result", _key: "!tables.results!table.result", type: "text", description: "**Fall:** Prone.", range: [1, 1], weight: 1, drawn: false }
    ] };
    if (url.includes("/macros/")) return { ok: true, json: async () => [
      { _id: "macro", _key: "!macros!macro", name: "Critical Failure", type: "script", command: "await game.incarnos.criticalFailure();" }
    ] };
    return { ok: true, json: async () => [
      actor ? { _id: "a", _key: "!actors!a", name: "Monster", type: "npc", system: {}, items: [], prototypeToken: { texture: { src: "monster.webp" } } }
        : { ...spell("a"), _key: "!items!a" },
      { ...folder(), type: actor ? "Actor" : "Item", _key: "!folders!plants" }
    ] };
  };
  const user = { id: "a", active: true, isGM: true };
  globalThis.game = {
    user, users: [user], system: { packs: new Set(packs.map(name => ({ name, type: ({ monsters: "Actor", "critical-failures": "RollTable", macros: "Macro" })[name] ?? "Item" }))) },
    packs: new Map([...databases].map(([key, state]) => [key, state.pack])), actors: [], scenes: { contents: [] }, items: [],
    i18n: { localize: key => translations[key] ?? key, format: (key, data) => translations[key].replace("{summary}", data.summary) }
  };
  globalThis.ui = { notifications: { info: text => notifications.push(text) } };
  return { calls, notifications, databases, state: databases.get(`incarnos.${packs[0]}`), normalized };
}

test("live sync writes folders before documents, deletes obsolete entries, restores the lock and is idempotent", async () => {
  const { calls, state, normalized } = setup();
  state.documents.set("a", normalized(spell("a", "old text")));
  state.documents.set("gone", normalized(spell("gone")));
  state.folders.set("gone", folder("gone"));
  const source = { documents: [spell("a"), spell("new")], folders: [folder()] };
  assert.deepEqual(await syncCompendium(state.pack, source), { documents: 3, folders: 2 });
  assert.deepEqual(calls.map(call => call.slice(0, 2)), [
    ["configure", { locked: false }], ["folders", "create"], ["documents", "create"], ["documents", "update"],
    ["documents", "delete"], ["folders", "delete"], ["configure", { locked: true }], ["render"]
  ]);
  assert.equal(state.pack.locked, true);
  calls.length = 0;
  assert.deepEqual(await syncCompendium(state.pack, source), { documents: 0, folders: 0 });
  assert.deepEqual(calls, []);
});

test("folder changes sync without document changes, preserving an already unlocked pack", async () => {
  const { state, calls, normalized } = setup({ locked: false });
  state.documents.set("a", normalized(spell("a")));
  state.folders.set("plants", { ...folder(), description: "Old affinity" });
  assert.deepEqual(await syncCompendium(state.pack, { documents: [spell("a")], folders: [folder()] }), { documents: 0, folders: 1 });
  assert.equal(state.folders.get("plants").description, "Affinity");
  assert.equal(state.pack.locked, false);
  assert.ok(!calls.some(call => call[0] === "configure"));
});

test("failed writes restore the previous lock", async () => {
  const { state, calls, normalized } = setup({ failWrite: true });
  state.documents.set("a", normalized(spell("a", "old")));
  await assert.rejects(syncCompendium(state.pack, { documents: [spell("a")], folders: [] }), /write failed/);
  assert.equal(state.pack.locked, true);
  assert.deepEqual(calls.at(-1), ["configure", { locked: true }]);
});

test("ready sync browses every system pack, fetches uncached JSON and issues one summary; the next run is silent", async () => {
  const { calls, notifications } = setup({ packs: ["weapons", "talents", "races", "spells", "monsters"] });
  assert.equal(await syncCompendiumsFromSource(), 10);
  assert.deepEqual(calls.filter(call => call[0] === "browse").map(call => call.slice(1)),
    [...game.system.packs].map(pack => ["data", `systems/incarnos/packs/_source/${pack.name}`]));
  assert.ok(calls.filter(call => call[0] === "fetch").every(call => call[1].startsWith("/table/systems/") && call[2].cache === "no-store"));
  assert.deepEqual(notifications, ["Incarnos: compendiums updated from vault: 1 weapon, 1 talent, 1 race, 1 spell, 1 monster, 5 folders"]);
  calls.length = 0;
  assert.equal(await syncCompendiumsFromSource(), 0);
  assert.equal(notifications.length, 1);
  assert.ok(!calls.some(call => call[0] === "configure"));
});

test("ready sync handles locked RollTables with embedded result edits/removals and Macros, then makes no writes", async () => {
  const { databases, calls, notifications } = setup({ packs: ["critical-failures", "macros"] });
  const state = databases.get("incarnos.critical-failures");
  state.documents.set("table", {
    _id: "table", name: "Critical Failure", formula: "1d2", replacement: true,
    results: [{ _id: "result", type: "text", description: "Old text", range: [1, 1], weight: 1, drawn: false },
      { _id: "gone", type: "text", description: "Removed", range: [2, 2], weight: 1, drawn: false }]
  });
  assert.equal(await syncCompendiumsFromSource(), 2);
  assert.equal(state.documents.get("table").results.length, 1);
  assert.equal(state.documents.get("table").results[0].description, "**Fall:** Prone.");
  assert.equal(state.documents.get("table").formula, "1d1");
  assert.equal(state.pack.locked, true);
  assert.equal(databases.get("incarnos.macros").pack.locked, true);
  assert.deepEqual(notifications, ["Incarnos: compendiums updated from vault: 1 critical failure table, 1 macro"]);
  calls.length = 0;
  assert.equal(await syncCompendiumsFromSource(), 0);
  assert.ok(!calls.some(call => call[0] === "configure"));
  assert.throws(() => unpackCompendiumSource([{ _id: "table", _key: "!tables!table", results: ["missing"] }], "RollTable"), /Missing embedded/);
});

test("players and other active GMs never read sources or write packs", async () => {
  const { calls } = setup();
  game.user.isGM = false;
  assert.equal(await syncCompendiumsFromSource(), 0);
  game.user.isGM = true;
  game.users.push({ id: "0", active: true, isGM: true });
  assert.equal(await syncCompendiumsFromSource(), 0);
  assert.deepEqual(calls, []);
});

test("failed or empty source reads never delete compendium content", async () => {
  const { calls, state } = setup();
  state.documents.set("a", spell("a", "old"));
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  await assert.rejects(syncCompendiumsFromSource(), /404/);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ error: "bad data" }) });
  await assert.rejects(syncCompendiumsFromSource(), /Expected an array/);
  foundry.applications.apps.FilePicker.implementation.browse = async () => ({ files: [] });
  await assert.rejects(syncCompendiumsFromSource(), /No compendium source JSON/);
  assert.equal(state.documents.size, 1);
  assert.ok(!calls.some(call => call[0] === "configure"));
});

test("the same ready pass syncs new Leaf wind text before refreshing owned spells", async () => {
  const { state, normalized } = setup();
  state.documents.set("a", normalized(spell("a", "old text")));
  const owned = spell("owned", "old text");
  const updates = [];
  game.actors = [{ items: [{ ...owned, toObject: () => structuredClone(owned) }], async updateEmbeddedDocuments(type, data) { updates.push(...data); } }];
  let ready;
  globalThis.Hooks = { once(name, handler) { assert.equal(name, "ready"); ready = handler; }, on() {} };
  registerSpellRefreshHooks(syncCompendiumsFromSource);
  await ready();
  assert.equal(updates.length, 1);
  assert.equal(updates[0]._id, "owned");
  assert.equal(updates[0].system.effect, "new text");
  assert.equal(state.pack.locked, true);
});
