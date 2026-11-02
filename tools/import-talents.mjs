/**
 * Import talents from the Obsidian vault (the rules source of truth) into compendium source files.
 * Reads `Talents/*.md` under the vault's list folder; never writes there.
 * Icon supplies the item image; missing/blank paths keep the default talent image.
 *
 *   node tools/import-talents.mjs [listFolder]
 *
 * listFolder defaults to $INCARNOS_VAULT_LISTS or C:/Users/mfgan/IncarnosPnp/System Files/Listen.
 * Writes packs/_source/talents/talents.json. Build the compendium afterwards with `node tools/pack.mjs talents`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseTalentNote, talentsToDocuments } from "./talent-notes.mjs";

const LISTS = process.argv[2] ?? process.env.INCARNOS_VAULT_LISTS ?? "C:/Users/mfgan/IncarnosPnp/System Files/Listen";
const OUT_DIR = new URL("../packs/_source/talents/", import.meta.url);
const systemVersion = JSON.parse(readFileSync(new URL("../system.json", import.meta.url))).version;

const dir = join(LISTS, "Talents");
if (!existsSync(dir)) throw new Error(`Vault folder not found: ${dir}`);
const warnings = [];
const talents = [];
// Zoottelkeeper's _Index_ files are not talents.
for (const file of readdirSync(dir).filter(file => file.endsWith(".md") && !file.startsWith("_Index_")).sort()) {
  const result = parseTalentNote(readFileSync(join(dir, file), "utf8"), basename(file, ".md"));
  warnings.push(...result.warnings);
  if (result.talent) talents.push(result.talent);
}

const docs = talentsToDocuments(talents, { systemVersion });
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(new URL("talents.json", OUT_DIR), JSON.stringify(docs, null, 2) + "\n");

const withPassives = docs.filter(doc => Object.keys(doc.system.passives).length).length;
console.log(`${talents.length} talents (${withPassives} with stat passives) -> packs/_source/talents/`);
if (warnings.length) console.log(`\nWarnings:\n- ${warnings.join("\n- ")}`);
