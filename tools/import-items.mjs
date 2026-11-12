/**
 * Import items (potions) from the Obsidian vault into compendium source files.
 * Reads `Welten/Incarnos/Listen/Shop/*.md` next to the vault's list folder (notes with "Typ: Potion"); never writes there.
 *
 *   node tools/import-items.mjs [listFolder]
 *
 * listFolder defaults to $INCARNOS_VAULT_LISTS or C:/Users/mfgan/IncarnosPnp/System Files/Listen.
 * Writes packs/_source/items/items.json. Build the compendium afterwards with `node tools/pack.mjs items`.
 */
import { isItemNote } from "./vault-notes.mjs";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { itemsToDocuments, parseItemNote } from "./item-notes.mjs";

const LISTS = process.argv[2] ?? process.env.INCARNOS_VAULT_LISTS ?? "C:/Users/mfgan/IncarnosPnp/System Files/Listen";
const OUT_DIR = new URL("../packs/_source/items/", import.meta.url);
const systemVersion = JSON.parse(readFileSync(new URL("../system.json", import.meta.url))).version;

const dir = resolve(LISTS, "..", "..", "Welten", "Incarnos", "Listen", "Shop");
if (!existsSync(dir)) throw new Error(`Vault folder not found: ${dir}`);
const warnings = [];
const items = [];
for (const file of readdirSync(dir).filter(isItemNote).sort()) {
  const result = parseItemNote(readFileSync(join(dir, file), "utf8"), basename(file, ".md"));
  warnings.push(...result.warnings);
  if (result.item) items.push(result.item);
}

const docs = itemsToDocuments(items, { systemVersion });
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(new URL("items.json", OUT_DIR), JSON.stringify(docs, null, 2) + "\n");

console.log(`${items.length} items -> packs/_source/items/`);
if (warnings.length) console.log(`\nWarnings:\n- ${warnings.join("\n- ")}`);
