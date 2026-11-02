/** Bring the running compendiums up to date without touching their open LevelDB files. */

/** Strip storage keys and volatile metadata, including on embedded documents; sort object keys for comparison. */
export function compendiumData(value) {
  if (Array.isArray(value)) return value.map(compendiumData);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key => key !== "_key" && key !== "_stats")
    .map(key => [key, compendiumData(value[key])]));
}

/** Decode LevelDB records, including an Actor's items and a RollTable's results. */
export function unpackCompendiumSource(records, documentName) {
  const prefix = { Item: "items", Actor: "actors", RollTable: "tables", Macro: "macros" }[documentName];
  if (!prefix) throw new Error(`Unsupported compendium type ${documentName}`);
  const keyed = new Map();
  const documents = [], folders = [];
  for (const record of records) {
    if (!record?._id || !record._key || keyed.has(record._key)) throw new Error("Invalid or duplicate compendium source record");
    keyed.set(record._key, record);
    if (record._key === `!folders!${record._id}`) folders.push(compendiumData(record));
    else if (record._key === `!${prefix}!${record._id}`) documents.push(compendiumData(record));
    else if (!/^![^!]+\.[^!]+!/.test(record._key)) throw new Error(`Invalid compendium source key ${record._key}`);
  }
  for (const doc of documents) {
    const field = { Actor: "items", RollTable: "results" }[documentName];
    if (!field) continue;
    doc[field] = (doc[field] ?? []).map(item => {
      if (typeof item !== "string") return compendiumData(item);
      const embedded = keyed.get(`!${prefix}.${field}!${doc._id}.${item}`);
      if (!embedded) throw new Error(`Missing embedded ${field} ${doc._id}.${item}`);
      return compendiumData(embedded);
    });
  }
  return { documents, folders };
}

/**
 * Pure diff by stable ID. Sources should have schema defaults applied first. Compare only fields written by the
 * source, replacing whole objects/arrays so removed system values, flags and embedded items do not linger.
 */
export function diffCompendiumDocuments(sources, current) {
  const byId = new Map(current.map(doc => [doc._id, compendiumData(doc)]));
  const ids = new Set(sources.map(doc => doc._id));
  const create = [], update = [];
  for (const source of sources) {
    const data = compendiumData(source);
    const existing = byId.get(data._id);
    if (!existing) create.push(data);
    else if (Object.keys(data).some(key => JSON.stringify(data[key]) !== JSON.stringify(existing[key]))) update.push(data);
  }
  return { create, update, delete: [...byId.keys()].filter(id => !ids.has(id)) };
}

const changeCount = diff => diff.create.length + diff.update.length + diff.delete.length;
const isFirstActiveGM = () => game.user.isGM
  && [...game.users].filter(user => user.active && user.isGM).sort((a, b) => a.id.localeCompare(b.id))[0]?.id === game.user.id;

/** Load the entire source before making any changes; failed/empty listings must never become mass deletions. */
async function readCompendiumSource(name, documentName) {
  const directory = `systems/incarnos/packs/_source/${name}`;
  const listing = await foundry.applications.apps.FilePicker.implementation.browse("data", directory);
  const files = listing.files.filter(file => /\.json$/i.test(file)).sort();
  if (!files.length) throw new Error(`No compendium source JSON in ${directory}`);
  const records = await Promise.all(files.map(async file => {
    const response = await fetch(foundry.utils.getRoute(file), { cache: "no-store" });
    if (!response.ok) throw new Error(`Cannot read ${file}: ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error(`Expected an array in ${file}`);
    return data;
  }));
  return unpackCompendiumSource(records.flat(), documentName);
}

/** Normalize schema defaults, but retain only the fields tools/pack.mjs actually writes. */
function normalizeSource(source, documentClass, pack) {
  const normalized = documentClass.fromSource(structuredClone(source), { pack, strict: true }).toObject();
  return Object.fromEntries(Object.keys(source).map(key => [key, normalized[key]]));
}

async function writeChanges(documentClass, diff, options) {
  if (diff.create.length) await documentClass.createDocuments(diff.create, { ...options, keepId: true });
  if (diff.update.length) await documentClass.updateDocuments(diff.update, { ...options, diff: false, recursive: false });
  if (diff.delete.length) await documentClass.deleteDocuments(diff.delete, options);
}

/** Sync one pack through Foundry's database API, restoring its lock even if a write fails. */
export async function syncCompendium(pack, source) {
  const Folder = foundry.documents.Folder.implementation;
  const documents = source.documents.map(doc => normalizeSource(doc, pack.documentClass, pack.collection));
  const folders = source.folders.map(doc => normalizeSource(doc, Folder, pack.collection));
  const documentDiff = diffCompendiumDocuments(documents, (await pack.getDocuments()).map(doc => doc.toObject()));
  const folderDiff = diffCompendiumDocuments(folders, pack.folders.contents.map(doc => doc.toObject()));
  const counts = { documents: changeCount(documentDiff), folders: changeCount(folderDiff) };
  if (!counts.documents && !counts.folders) return counts;

  const locked = pack.locked;
  const options = { pack: pack.collection, render: false };
  try {
    if (locked) await pack.configure({ locked: false });
    // Establish folders first, then move/update documents before removing obsolete folders.
    await writeChanges(Folder, { ...folderDiff, delete: [] }, options);
    await writeChanges(pack.documentClass, documentDiff, options);
    if (folderDiff.delete.length) await Folder.deleteDocuments(folderDiff.delete, options);
  } finally {
    if (locked) await pack.configure({ locked });
  }
  pack.render(false);
  return counts;
}

/** First active GM only. Called on ready before syncing linked items from the now-current compendiums. */
export async function syncCompendiumsFromSource() {
  if (!isFirstActiveGM()) return 0;
  const summary = [];
  let total = 0, folders = 0;
  for (const metadata of game.system.packs) {
    const pack = game.packs.get(`incarnos.${metadata.name}`);
    if (!pack) throw new Error(`Missing compendium incarnos.${metadata.name}`);
    const source = await readCompendiumSource(metadata.name, metadata.type);
    const counts = await syncCompendium(pack, source);
    total += counts.documents + counts.folders;
    folders += counts.folders;
    if (counts.documents) {
      const label = `INCARNOS.CompendiumSync.${metadata.name}.${counts.documents === 1 ? "one" : "many"}`;
      summary.push(`${counts.documents} ${game.i18n.localize(label)}`);
    }
  }
  if (folders) summary.push(`${folders} ${game.i18n.localize(`INCARNOS.CompendiumSync.folders.${folders === 1 ? "one" : "many"}`)}`);
  if (total) ui.notifications.info(game.i18n.format("INCARNOS.CompendiumSync.updated", { summary: summary.join(", ") }));
  return total;
}
