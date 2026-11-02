/** ID-linked copies of the vault's item compendiums, with a baseline protecting character edits. */
import { escape } from "./roll-card.mjs";

export const ITEM_SYNC_PACKS = Object.freeze({ weapon: "weapons", feature: "talents", race: "races", spell: "spells" });

/**
 * Character play state, excluded from the hash and preserved even on Reset to compendium.
 * template.json: weapon/item quantity and weight, and every type's passivesEnabled switch.
 * Equipped/prepared/attuned/identified and uses/charges are supported for module/legacy data.
 * All other system fields (including attackMode, versatile, passives and bonuses) are rules content.
 * Document fields are never copied: only name, img, system and our three sync flags are written.
 */
export const ITEM_SYNC_PLAY_STATE = Object.freeze({
  system: Object.freeze(["quantity", "weight", "passivesEnabled", "equipped", "prepared", "attuned", "identified", "uses", "charges"]),
  document: Object.freeze(["sort", "folder", "ownership", "flags", "effects", "_stats"])
});

const t = key => game.i18n.localize(`INCARNOS.ItemSync.${key}`);
const format = (key, data) => game.i18n.format(`INCARNOS.ItemSync.${key}`, data);
const normalized = value => String(value ?? "").trim().toLowerCase();
const dataOf = item => item.toObject ? item.toObject() : item;
const rawLink = item => item._stats?.compendiumSource || item.flags?.incarnos?.sourceUuid;
const isCompendiumItem = item => Boolean(item.pack || item.parent?.pack);
const writeOptions = { diff: false, recursive: false };

/** Canonical JSON makes object insertion order irrelevant, including nested passives. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

export function itemSyncContent(item) {
  const system = structuredClone(item.system ?? {});
  for (const key of ITEM_SYNC_PLAY_STATE.system) delete system[key];
  return canonical({ name: item.name ?? "", img: item.img ?? "", system });
}

/** Versioned FNV-1a 64-bit content fingerprint; a change detector, not a security credential. */
export function itemSyncHash(item) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(JSON.stringify(itemSyncContent(item)))) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return `v1:${hash.toString(16).padStart(16, "0")}`;
}

/** Fallback is deliberately type-specific; spells also need the same element. */
export const itemSyncKey = item => `${item.type}|${normalized(item.name)}${item.type === "spell" ? `|${normalized(item.system?.element)}` : ""}`;

/** Accept Foundry's current UUIDs and older UUIDs without the Item segment. */
export function itemSourceUuid(item) {
  const pack = ITEM_SYNC_PACKS[item.type];
  const link = rawLink(item);
  if (!pack || typeof link !== "string") return null;
  const prefix = `Compendium.incarnos.${pack}.`;
  if (!link.startsWith(prefix)) return null;
  const id = link.slice(prefix.length).replace(/^Item\./, "");
  return id && !id.includes(".") ? `${prefix}Item.${id}` : null;
}

/** Ambiguous legacy names are left alone. A missing/stale/external ID never falls back to a name. */
export function indexItemSources(entries) {
  const byUuid = new Map(), byKey = new Map();
  for (const entry of entries) {
    byUuid.set(entry.uuid, entry);
    const key = itemSyncKey(entry.source);
    byKey.set(key, byKey.has(key) ? null : entry);
  }
  return { byUuid, byKey };
}

export function findItemSource(item, index) {
  if (!ITEM_SYNC_PACKS[item.type]) return null;
  return (rawLink(item) ? index.byUuid.get(itemSourceUuid(item)) : index.byKey.get(itemSyncKey(item))) ?? null;
}

/** Read-only status also catches edits made since the last GM ready pass. */
export function itemSyncStatus(item) {
  if (!itemSourceUuid(item)) return null;
  const flags = item.flags?.incarnos ?? {};
  return { customized: Boolean(flags.customized || (flags.syncHash && flags.syncHash !== itemSyncHash(item))) };
}

/** Copy only rules content, preserving document state and unrelated flags. Use non-recursive writes. */
function syncedUpdate(owned, source, uuid) {
  const system = structuredClone(source.system ?? {});
  for (const key of ITEM_SYNC_PLAY_STATE.system) {
    if (Object.hasOwn(owned.system ?? {}, key)) system[key] = structuredClone(owned.system[key]);
  }
  const flags = structuredClone(owned.flags ?? {});
  flags.incarnos = { ...flags.incarnos, sourceUuid: uuid, syncHash: itemSyncHash(source), customized: false };
  return { _id: owned._id, name: source.name, img: source.img, system, flags };
}

/** Pure plan. Legacy spells alone may migrate differing content without an existing baseline. */
export function planItemSync(owned, source, uuid, { reset = false, legacySpells = true } = {}) {
  const currentHash = itemSyncHash(owned), sourceHash = itemSyncHash(source);
  const flags = owned.flags?.incarnos ?? {};
  const customized = !reset && Boolean(flags.customized || (flags.syncHash
    ? currentHash !== flags.syncHash
    : currentHash !== sourceHash && !(legacySpells && owned.type === "spell")));
  const nextFlags = { ...flags, sourceUuid: uuid, syncHash: customized ? flags.syncHash ?? sourceHash : sourceHash, customized };
  const updated = !customized && currentHash !== sourceHash;
  let update = null;
  if (updated || reset) update = syncedUpdate(owned, source, uuid);
  else if (JSON.stringify(canonical(flags)) !== JSON.stringify(canonical(nextFlags))) {
    update = { _id: owned._id, flags: { ...structuredClone(owned.flags ?? {}), incarnos: nextFlags } };
  }
  return { update, updated, customized, warn: customized && !flags.customized && !flags.syncHash && owned.type !== "spell" };
}

const isFirstActiveGM = () => game.user.isGM
  && [...game.users].filter(user => user.active && user.isGM).sort((a, b) => a.id.localeCompare(b.id))[0]?.id === game.user.id;

/** World actors, each unlinked token's synthetic actor, and world items; one write per owner. */
export async function syncItemsFromCompendiums() {
  if (!isFirstActiveGM()) return 0;
  const entries = [];
  for (const [type, name] of Object.entries(ITEM_SYNC_PACKS)) {
    const pack = game.packs.get(`incarnos.${name}`);
    if (!pack) continue;
    for (const doc of await pack.getDocuments()) {
      const source = doc.toObject();
      if (source.type === type) entries.push({ uuid: doc.uuid, source });
    }
  }
  const index = indexItemSources(entries);
  let updated = 0, customized = 0, changed = false;
  const warnings = [];
  const plan = (item, owner) => {
    const owned = dataOf(item), entry = findItemSource(owned, index);
    if (!entry) return null;
    const result = planItemSync(owned, entry.source, entry.uuid);
    if (result.updated) updated++;
    if (result.customized) customized++;
    if (result.update && (result.updated || result.customized)) changed = true;
    if (result.warn) warnings.push(`${owner} – ${owned.name}`);
    return result.update;
  };
  const actors = new Set([...game.actors, ...game.scenes.contents.flatMap(scene => scene.tokens
    .filter(token => !token.actorLink && token.actor).map(token => token.actor))]);
  for (const actor of actors) {
    const updates = actor.items.map(item => plan(item, actor.name)).filter(Boolean);
    if (updates.length) await actor.updateEmbeddedDocuments("Item", updates, writeOptions);
  }
  const worldUpdates = game.items.map(item => plan(item, t("worldItem"))).filter(Boolean);
  if (worldUpdates.length) await Item.updateDocuments(worldUpdates, writeOptions);
  if (warnings.length) await ChatMessage.create({
    content: `<p>${escape(format("legacyWarning", { count: warnings.length, items: warnings.join(", ") }))}</p>`,
    whisper: [...game.users].filter(user => user.isGM).map(user => user.id)
  });
  if (changed) ui.notifications.info(format("summary", { updated, customized }));
  return updated;
}

/** Only resolve a linked item in its own system pack; owners can reset without a GM writer. */
async function linkedSource(item) {
  const uuid = itemSourceUuid(dataOf(item));
  if (!uuid) return null;
  const pack = game.packs.get(`incarnos.${ITEM_SYNC_PACKS[item.type]}`);
  const doc = await pack?.getDocument(uuid.split(".").at(-1));
  return doc?.type === item.type ? { uuid, source: doc.toObject() } : null;
}

export const canResetItemSync = item => Boolean(item && !isCompendiumItem(item) && itemSourceUuid(dataOf(item))
  && (globalThis.game?.user?.isGM || item.isOwner));

/** Confirmation is part of the sheet action, including permission and missing-source checks. */
export async function resetItemToCompendium(item) {
  if (!canResetItemSync(item)) return false;
  if (!await foundry.applications.api.DialogV2.confirm({
    window: { title: t("reset") }, content: `<p>${escape(t("resetConfirm"))}</p>`,
    yes: { label: t("reset") }, rejectClose: false, modal: true
  })) return false;
  // Read after confirmation so character state and compendium edits during the dialog are retained.
  const entry = await linkedSource(item);
  if (!entry) { ui.notifications.warn(t("missingSource")); return false; }
  if (!canResetItemSync(item)) return false;
  const { update } = planItemSync(dataOf(item), entry.source, entry.uuid, { reset: true });
  await item.update(update, writeOptions);
  return true;
}

export function registerItemSyncHooks(beforeSync = async () => {}) {
  Hooks.once("ready", async () => {
    try { await beforeSync(); await syncItemsFromCompendiums(); }
    catch (error) { console.error("Incarnos | item sync", error); }
  });
  // Only the originating client writes. Compendium live sync must never add character sync flags to packs.
  Hooks.on("createItem", async (item, options, userId) => {
    if (userId !== game.user.id || isCompendiumItem(item) || !canResetItemSync(item)) return;
    try {
      const entry = await linkedSource(item);
      if (!entry) return;
      const { update } = planItemSync(dataOf(item), entry.source, entry.uuid, { legacySpells: false });
      if (update) await item.update(update, writeOptions);
    } catch (error) { console.error("Incarnos | item sync baseline", error); }
  });
  Hooks.on("updateItem", async (item, changes, options, userId) => {
    if (userId !== game.user.id || isCompendiumItem(item) || !canResetItemSync(item)) return;
    const owned = dataOf(item), flags = owned.flags?.incarnos;
    if (!flags?.syncHash || flags.customized || !itemSyncStatus(owned)?.customized) return;
    try { await item.update({ "flags.incarnos.customized": true }); }
    catch (error) { console.error("Incarnos | item sync customization", error); }
  });
}
