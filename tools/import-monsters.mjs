/**
 * Import monsters from the Obsidian vault (the rules source of truth) into compendium source files.
 * Reads `Custom Monsters/<Type>/**.md` next to the vault's list folder (and `Listen/Weapon Traits` for trait
 * links in attacks); never writes there.
 *
 *   node tools/import-monsters.mjs [listFolder]
 *
 * listFolder defaults to $INCARNOS_VAULT_LISTS or C:/Users/mfgan/IncarnosPnp/System Files/Listen.
 * Writes packs/_source/monsters/monsters.json. Build the compendium afterwards with `node tools/pack.mjs monsters`.
 * A note's "Token:" is a path inside Foundry's data folder (e.g. tokens/monsters/lashtail-panther.webp).
 * Optional Stats: IP, Race, Talents, Spells and Disposition; nested note folders are retained up to depth 4.
 * Race/talent/spell copies read the corresponding packs/_source JSON, so import those packs first.
 */
import { isItemNote } from "./vault-notes.mjs";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { monstersToDocuments, parseMonsterNote } from "./monster-notes.mjs";
import { parseTraitNote } from "./weapon-notes.mjs";
import { readPackSource } from "./pack.mjs";

const LISTS = process.argv[2] ?? process.env.INCARNOS_VAULT_LISTS ?? "C:/Users/mfgan/IncarnosPnp/System Files/Listen";
const OUT_DIR = new URL("../packs/_source/monsters/", import.meta.url);
const systemVersion = JSON.parse(readFileSync(new URL("../system.json", import.meta.url))).version;

const dir = resolve(LISTS, "..", "..", "Welten", "Incarnos", "Custom Monsters");
if (!existsSync(dir)) throw new Error(`Vault folder not found: ${dir}`);
const traitDir = join(LISTS, "Weapon Traits");
const traits = existsSync(traitDir) ? Object.fromEntries(readdirSync(traitDir).filter(isItemNote)
  .map(file => [basename(file, ".md"), parseTraitNote(readFileSync(join(traitDir, file), "utf8"))])) : {};

const files = [];
const walk = folder => {
  for (const name of readdirSync(folder).sort()) {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) walk(path);
    // Zoottelkeeper's _Index_ files are not monsters.
    else if (isItemNote(name)) files.push(path);
  }
};
walk(dir);

const warnings = [];
const skipped = [];
const entries = [];
for (const file of files) {
  const parts = relative(dir, file).split(sep);
  const result = parseMonsterNote(readFileSync(file, "utf8"), basename(file, ".md"), { traits });
  warnings.push(...result.warnings.filter(warning => !/not a monster note|incomplete/.test(warning)));
  if (result.monster) entries.push({ monster: result.monster, type: parts.length > 1 ? parts[0] : "", folderPath: parts.slice(0, -1).join("/") });
  else if (result.warnings.some(warning => /incomplete/.test(warning))) skipped.push(basename(file, ".md"));
}

const sources = Object.fromEntries(["races", "talents", "spells"].map(pack => [pack, readPackSource(pack)]));
const docs = monstersToDocuments(entries, { systemVersion, sources, warnings });
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(new URL("monsters.json", OUT_DIR), JSON.stringify(docs, null, 2) + "\n");

const weapons = entries.reduce((sum, { monster }) => sum + monster.weapons.length, 0);
console.log(`${entries.length} monsters (${weapons} attacks as weapons) -> packs/_source/monsters/`);
// "~ " lines are information for sync-vault, not warnings.
if (skipped.length) console.log(`~ Skipped ${skipped.length} unfinished monster notes (no HP or stat table): ${skipped.join(", ")}`);
if (warnings.length) console.log(`\nWarnings:\n- ${warnings.join("\n- ")}`);
