/**
 * Import spells from the Obsidian vault (the rules source of truth) into compendium source files.
 * Reads `Spells/<Element>/*.md` under the vault's list folder (one folder per element, with an `<Element>.md`
 * note holding its Affinity) and spell notes left in `Spells/` itself, grouped by their Element field; never writes there.
 *
 *   node tools/import-spells.mjs [listFolder]
 *
 * listFolder defaults to $INCARNOS_VAULT_LISTS or C:/Users/mfgan/IncarnosPnp/System Files/Listen.
 * Writes packs/_source/spells/<element>.json (one Folder + its spells per file).
 * Build the compendium afterwards with `node tools/pack.mjs spells`.
 */
import { isItemNote } from "./vault-notes.mjs";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { elementToDocuments } from "./spell-sheet.mjs";
import { parseElementNote, parseSpellNote } from "./spell-notes.mjs";

const LISTS = process.argv[2] ?? process.env.INCARNOS_VAULT_LISTS ?? "C:/Users/mfgan/IncarnosPnp/System Files/Listen";
const OUT_DIR = new URL("../packs/_source/spells/", import.meta.url);
const systemVersion = JSON.parse(readFileSync(new URL("../system.json", import.meta.url))).version;

/** Fallback for notes without Icon (paths inside Foundry's public/icons). */
const ELEMENT_ICONS = {
  Air: "icons/magic/air/air-burst-spiral-large-blue.webp",
  Ambericity: "icons/magic/lightning/barrier-shield-crackling-orb-pink.webp",
  Blood: "icons/magic/death/blood-corruption-vomit-red.webp",
  Crystal: "icons/magic/water/barrier-ice-crystal-wall-jagged-blue.webp",
  Darkness: "icons/magic/unholy/beam-ringed-impact-purple.webp",
  Deathfire: "icons/magic/unholy/barrier-fire-pink.webp",
  Dream: "icons/magic/nature/dreamcatcher-green.webp",
  Earth: "icons/magic/earth/barrier-stone-brown-green.webp",
  Fabric: "icons/svg/net.svg",
  Fire: "icons/magic/fire/barrier-wall-flame-ring-yellow.webp",
  Flesh: "icons/magic/acid/dissolve-arm-flesh.webp",
  Ketchup: "icons/svg/blood.svg",
  Light: "icons/magic/light/beam-horizon-strike-yellow.webp",
  Luck: "icons/sundries/gaming/playing-cards.webp",
  Mayo: "icons/svg/acid.svg",
  Oil: "icons/magic/acid/dissolve-pool-bubbles.webp",
  Physical: "icons/svg/sword.svg",
  Plants: "icons/magic/nature/beam-hand-leaves-green.webp",
  Poison: "icons/magic/acid/dissolve-drip-droplet-smoke.webp",
  Shadow: "icons/svg/invisible.svg",
  Thunder: "icons/magic/lightning/bolt-blue.webp",
  Water: "icons/magic/water/barrier-ice-crystal-wall-faceted-blue.webp"
};

const dir = join(LISTS, "Spells");
if (!existsSync(dir)) throw new Error(`Vault folder not found: ${dir}`);

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

let total = 0;
const warnings = [];
const affinities = new Map();
const byElement = new Map();
// Element folders, plus notes left in Spells/ itself (a new spell from the TSpells template lands there; its Element field decides).
const folders = ["", ...readdirSync(dir).filter(name => statSync(join(dir, name)).isDirectory())];
for (const folder of folders) {
  // Zoottelkeeper's _Index_ files are not spells.
  for (const file of readdirSync(join(dir, folder)).filter(isItemNote)) {
    const markdown = readFileSync(join(dir, folder, file), "utf8");
    const elementNote = parseElementNote(markdown, basename(file, ".md"));
    if (elementNote) { affinities.set(elementNote.element, elementNote.affinity); continue; }
    const result = parseSpellNote(markdown, basename(file, ".md"), folder);
    warnings.push(...result.warnings);
    if (!result.spell) continue;
    if (!result.spell.element) { warnings.push(`${result.spell.name}: no Element, skipped`); continue; }
    if (!byElement.has(result.spell.element)) byElement.set(result.spell.element, []);
    byElement.get(result.spell.element).push(result.spell);
  }
}

const elements = [...byElement.keys()].sort();
for (const [index, element] of elements.entries()) {
  const spells = byElement.get(element).sort((a, b) => a.name.localeCompare(b.name));
  const affinity = affinities.get(element) ?? "";
  // Each spell supplies its own Icon; img is the fallback for older notes.
  const docs = elementToDocuments({ element, affinity, spells }, { img: ELEMENT_ICONS[element], sort: (index + 1) * 100000, systemVersion });
  writeFileSync(new URL(`${element.toLowerCase()}.json`, OUT_DIR), JSON.stringify(docs, null, 2) + "\n");
  total += spells.length;
  console.log(`${element.padEnd(12)} ${spells.length} spells`);
}

console.log(`\n${total} spells in ${elements.length} elements -> packs/_source/spells/`);
if (warnings.length) console.log(`\nWarnings:\n- ${warnings.join("\n- ")}`);
