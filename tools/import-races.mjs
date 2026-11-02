/**
 * Import races from the Obsidian vault (the rules source of truth) into compendium source files.
 * Reads `Races/*.md` under the vault's list folder (same layout as talent notes, "Typ: Race"); never writes there.
 * Icon supplies the item image; missing/blank paths keep the default race image.
 *
 *   node tools/import-races.mjs [listFolder]
 *
 * listFolder defaults to $INCARNOS_VAULT_LISTS or C:/Users/mfgan/IncarnosPnp/System Files/Listen.
 * Writes packs/_source/races/races.json. Build the compendium afterwards with `node tools/pack.mjs races`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseTalentNote, talentsToDocuments } from "./talent-notes.mjs";

const LISTS = process.argv[2] ?? process.env.INCARNOS_VAULT_LISTS ?? "C:/Users/mfgan/IncarnosPnp/System Files/Listen";
const OUT_DIR = new URL("../packs/_source/races/", import.meta.url);
const systemVersion = JSON.parse(readFileSync(new URL("../system.json", import.meta.url))).version;

const dir = join(LISTS, "Races");
if (!existsSync(dir)) throw new Error(`Vault folder not found: ${dir}`);
const warnings = [];
const races = [];
// Zoottelkeeper's _Index_ files are not races.
for (const file of readdirSync(dir).filter(file => file.endsWith(".md") && !file.startsWith("_Index_")).sort()) {
  const result = parseTalentNote(readFileSync(join(dir, file), "utf8"), basename(file, ".md"), { kind: "Race" });
  warnings.push(...result.warnings);
  if (result.talent) races.push(result.talent);
}

const docs = talentsToDocuments(races, { systemVersion, type: "race" });
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(new URL("races.json", OUT_DIR), JSON.stringify(docs, null, 2) + "\n");

const withPassives = docs.filter(doc => Object.keys(doc.system.passives).length).length;
console.log(`${races.length} races (${withPassives} with stat passives) -> packs/_source/races/`);
if (warnings.length) console.log(`\nWarnings:\n- ${warnings.join("\n- ")}`);
