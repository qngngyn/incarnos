/**
 * Import the conditions from the Obsidian vault (the rules source of truth) into Foundry's status effect list.
 * Reads `Conditions/*.md` under the vault's list folder; never writes there.
 *
 *   node tools/import-conditions.mjs [listFolder]
 *
 * listFolder defaults to $INCARNOS_VAULT_LISTS or C:/Users/mfgan/IncarnosPnp/System Files/Listen.
 * Writes module/data/conditions.mjs (loaded at startup: Foundry clients reload with F5 to see changes).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { conditionsModule, parseConditionNote } from "./condition-notes.mjs";

const LISTS = process.argv[2] ?? process.env.INCARNOS_VAULT_LISTS ?? "C:/Users/mfgan/IncarnosPnp/System Files/Listen";
const OUT = new URL("../module/data/conditions.mjs", import.meta.url);

const dir = join(LISTS, "Conditions");
if (!existsSync(dir)) throw new Error(`Vault folder not found: ${dir}`);
const warnings = [];
const conditions = [];
// Zoottelkeeper's _Index_ files are not conditions.
for (const file of readdirSync(dir).filter(file => file.endsWith(".md") && !file.startsWith("_Index_")).sort()) {
  const result = parseConditionNote(readFileSync(join(dir, file), "utf8"), basename(file, ".md"));
  warnings.push(...result.warnings);
  if (result.condition) conditions.push(result.condition);
}

mkdirSync(new URL("../module/data/", import.meta.url), { recursive: true });
const source = conditionsModule(conditions);
const changed = !existsSync(OUT) || readFileSync(OUT, "utf8") !== source;
if (changed) writeFileSync(OUT, source);
console.log(`${conditions.length} conditions (${conditions.filter(c => c.tokens).length} with tokens) -> module/data/conditions.mjs${changed ? " (changed)" : ""}`);
if (warnings.length) console.log(`\nWarnings:\n- ${warnings.join("\n- ")}`);
