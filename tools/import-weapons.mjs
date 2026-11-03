/**
 * Import weapons from the Obsidian vault (the rules source of truth) into compendium source files.
 * Reads `Weapons/*.md` and `Weapon Traits/*.md` under the vault's weapon list folder; never writes there.
 *
 *   node tools/import-weapons.mjs [listFolder]
 *
 * listFolder defaults to $INCARNOS_VAULT_LISTS or C:/Users/mfgan/IncarnosPnp/System Files/Listen.
 * Writes packs/_source/weapons/weapons.json. Build the compendium afterwards with `node tools/pack.mjs weapons`.
 */
import { isItemNote } from "./vault-notes.mjs";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseWeaponRows, weaponsToDocuments } from "./weapon-sheet.mjs";
import { parseTraitNote, weaponNotesToRows } from "./weapon-notes.mjs";

const LISTS = process.argv[2] ?? process.env.INCARNOS_VAULT_LISTS ?? "C:/Users/mfgan/IncarnosPnp/System Files/Listen";
const OUT_DIR = new URL("../packs/_source/weapons/", import.meta.url);
const FOUNDRY_ICONS = join(process.env.FOUNDRY_APP ?? "D:/Programme/Foundry Virtual Tabletop/resources/app", "public");
const systemVersion = JSON.parse(readFileSync(new URL("../system.json", import.meta.url))).version;

/** Core Foundry icon per weapon (first matching name pattern wins). */
const WEAPON_ICONS = [
  [/unarmed/i, "icons/weapons/fist/fist-brass-knuckles.webp"],
  [/scalpel/i, "icons/weapons/daggers/dagger-curved-black.webp"],
  [/dagger/i, "icons/weapons/daggers/dagger-simple-black.webp"],
  [/kochl/i, "icons/weapons/clubs/club-banded-brown.webp"],
  [/shortblade/i, "icons/weapons/swords/shortsword-broad.webp"],
  [/claws/i, "icons/weapons/fist/claw-leather-black.webp"],
  [/light hammer/i, "icons/weapons/hammers/hammer-simple-iron.webp"],
  [/maul/i, "icons/weapons/hammers/hammer-double-simple.webp"],
  [/whip/i, "icons/weapons/misc/whip-red-yellow.webp"],
  [/trident|harpoon/i, "icons/weapons/polearms/spear-simple-barbed.webp"],
  [/greatsword/i, "icons/weapons/swords/greatsword-crossguard-curved.webp"],
  [/longsword/i, "icons/weapons/swords/sword-broad-red.webp"],
  [/khopesh|scimitar/i, "icons/weapons/sickles/hand-sickle.webp"],
  [/rapier/i, "icons/weapons/swords/sword-guard-steel-green.webp"],
  [/katana/i, "icons/weapons/swords/sword-katana.webp"],
  [/shield/i, "icons/equipment/shield/buckler-wooden-boss-brown.webp"],
  [/bo staff/i, "icons/weapons/staves/staff-simple-brown.webp"],
  [/cardón|cholla|golden ball/i, "icons/magic/nature/plant-bamboo-green.webp"],
  [/bloodre/i, "icons/weapons/polearms/spear-simple-barbed.webp"],
  [/flintlock|pistol/i, "icons/weapons/guns/gun-pistol-flintlock-metal.webp"],
  [/crossbow/i, "icons/weapons/crossbows/crossbow-blue.webp"],
  [/slingshot/i, "icons/weapons/slings/slingshot-wood.webp"],
  [/grease cannon/i, "icons/weapons/guns/gun-blunderbuss-bronze.webp"],
  [/longbow/i, "icons/weapons/bows/longbow-leather-green.webp"],
  [/shortbow/i, "icons/weapons/bows/shortbow-leather.webp"]
];
const missingIcons = [];
const icon = weapon => {
  const path = WEAPON_ICONS.find(([pattern]) => pattern.test(weapon.name))?.[1];
  if (path && !existsSync(join(FOUNDRY_ICONS, path))) { missingIcons.push(`${weapon.name}: ${path}`); return null; }
  return path ?? null;
};

/** Markdown notes of a folder, skipping Zoottelkeeper's _Index_ files. */
function readNotes(folder) {
  const dir = join(LISTS, folder);
  if (!existsSync(dir)) throw new Error(`Vault folder not found: ${dir}`);
  return readdirSync(dir).filter(isItemNote).sort()
    .map(file => ({ name: basename(file, ".md"), markdown: readFileSync(join(dir, file), "utf8") }));
}

const traits = Object.fromEntries(readNotes("Weapon Traits").map(note => [note.name, parseTraitNote(note.markdown)]));
const { rows, warnings: noteWarnings } = weaponNotesToRows(readNotes("Weapons"), traits);
const { weapons, warnings } = parseWeaponRows(rows);
warnings.unshift(...noteWarnings);
const docs = weaponsToDocuments(weapons, { icon, systemVersion });
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(new URL("weapons.json", OUT_DIR), JSON.stringify(docs, null, 2) + "\n");

console.log(`${weapons.length} weapons (${weapons.filter(w => w.attackMode === "melee").length} melee, ${weapons.filter(w => w.attackMode === "ranged").length} ranged) -> packs/_source/weapons/`);
if (missingIcons.length) warnings.push(...missingIcons.map(entry => `icon not found, using default: ${entry}`));
if (warnings.length) console.log(`\nWarnings:\n- ${warnings.join("\n- ")}`);
