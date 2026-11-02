/**
 * Backups made by the Obsidian "Update Foundry" button (tools/sync-vault.mjs runs this after every update).
 *
 *   node tools/backup.mjs [vaultPath]
 *
 * Each backup is a folder <backupDir>/<YYYY-MM-DD_HH-MM-SS>/ with everything needed to rebuild the game content:
 *   vault/                    text copy of the whole vault (without .git, .obsidian and .trash)
 *   foundry/packs-source/     the compendium source JSON (rebuild a pack with `node tools/pack.mjs <name>`)
 *   foundry/tokens/           token images from Foundry's data folder (<Data>/tokens, used by monster notes)
 *   Incarnos Lists.xlsx       weapons, weapon traits, talents, races, spells and monsters as Excel tables
 *   README.txt                what is inside and how to restore it
 * backupDir defaults to $INCARNOS_BACKUP_DIR or C:/Users/mfgan/IncarnosBackups (outside the vault and the
 * system repo, so backups never get pushed to GitHub). Old backups are thinned out by keepBackups().
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildXlsx } from "./xlsx.mjs";
import { parseTraitNote } from "./weapon-notes.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NAME = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/;
const SKIP = new Set([".git", ".obsidian", ".trash"]);
const root = fileURLToPath(new URL("..", import.meta.url));

export const DEFAULT_BACKUP_DIR = "C:/Users/mfgan/IncarnosBackups";

const pad = number => String(number).padStart(2, "0");
/** Folder name for a backup made at `date` (local time). */
export const backupName = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
/** Time a backup folder name stands for, or null for folders that are not backups. */
export function backupTime(name) {
  const match = NAME.exec(name);
  return match ? new Date(+match[1], match[2] - 1, +match[3], +match[4], +match[5], +match[6]).getTime() : null;
}

/**
 * Which backups to keep (3–4 once there is enough history):
 * - the 2 newest,
 * - the oldest one younger than 30 days, so a backup is always growing into the month slot,
 * - the newest one at least 30 days old ("a month ago"),
 * - a week-old one: the growing backup once it is 7+ days old, until then the newest one at least 7 days old.
 * The month backup is therefore 30–60 days old; the week backup is at least 7 days old.
 * @param {{name: string, time: number}[]} backups
 * @param {number} now
 * @returns {Set<string>} names to keep
 */
export function keepBackups(backups, now) {
  const newest = [...backups].sort((a, b) => b.time - a.time);
  const keep = new Set(newest.slice(0, 2).map(backup => backup.name));
  const age = backup => now - backup.time;
  const month = newest.find(backup => age(backup) >= 30 * DAY);
  const growing = newest.filter(backup => age(backup) < 30 * DAY).at(-1);
  // Never a second backup between 7 and 30 days: that would make 5.
  const week = growing && age(growing) >= 7 * DAY ? growing : newest.find(backup => age(backup) >= 7 * DAY);
  for (const backup of [week, month, growing]) if (backup) keep.add(backup.name);
  return keep;
}

/** Delete the backups keepBackups() does not keep, and unfinished ones. Only touches folders named like backups. */
export function pruneBackups(backupDir, now = Date.now()) {
  if (!existsSync(backupDir)) return { kept: [], deleted: [] };
  const deleted = [];
  const backups = [];
  for (const name of readdirSync(backupDir)) {
    if (name.endsWith(".partial") && backupTime(name.slice(0, -".partial".length)) !== null) {
      rmSync(join(backupDir, name), { recursive: true, force: true });
      deleted.push(name);
      continue;
    }
    const time = backupTime(name);
    if (time !== null && statSync(join(backupDir, name)).isDirectory()) backups.push({ name, time });
  }
  const keep = keepBackups(backups, now);
  for (const { name } of backups) {
    if (keep.has(name)) continue;
    rmSync(join(backupDir, name), { recursive: true, force: true });
    deleted.push(name);
  }
  return { kept: backups.filter(backup => keep.has(backup.name)).map(backup => backup.name).sort(), deleted };
}

const text = html => String(html ?? "").replace(/<\/p>\s*<p>/g, "\n\n").replace(/<br\s*\/?>/g, "\n").replace(/<[^>]+>/g, "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").trim();

function sourceDocs(name) {
  const dir = join(root, "packs", "_source", name);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(file => file.endsWith(".json"))
    .flatMap(file => [JSON.parse(readFileSync(join(dir, file), "utf8"))].flat())
    .filter(doc => !doc._key?.startsWith("!folders!"));
}

/** Excel sheets of the vault-sourced lists, from the compendium sources (written by the importers just before). */
export function listSheets(vault) {
  const byName = (a, b) => a.name.localeCompare(b.name);
  const weapons = sourceDocs("weapons").filter(doc => doc.type === "weapon").sort(byName);
  const talents = sourceDocs("talents").sort(byName);
  const races = sourceDocs("races").sort(byName);
  const spells = sourceDocs("spells").sort((a, b) => a.system.element.localeCompare(b.system.element) || a.name.localeCompare(b.name));
  const monsterDocs = sourceDocs("monsters");
  const monsters = monsterDocs.filter(doc => doc.type === "npc").sort(byName);
  const attacks = actor => monsterDocs.filter(doc => doc._key?.startsWith(`!actors.items!${actor._id}.`) && doc.type === "weapon")
    .map(({ name, system: s }) => `${name}: ${s.attackMode} ${s.modifier >= 0 ? "+" : ""}${s.modifier} ${s.damage}`).join("\n");
  const traitDir = join(vault, "System Files", "Listen", "Weapon Traits");
  const traits = existsSync(traitDir) ? readdirSync(traitDir).filter(file => file.endsWith(".md") && !file.startsWith("_Index_")).sort()
    .map(file => [basename(file, ".md"), parseTraitNote(readFileSync(join(traitDir, file), "utf8"))]) : [];
  return [
    { name: "Weapons", rows: [["Name", "Attack", "Versatile", "Hands", "Range", "Hitrate", "Damage", "Traits"],
      ...weapons.map(({ name, system: s }) => [name, s.attackMode, s.versatile ? "yes" : "", s.hands, s.range, s.modifier, s.damage, s.traits])] },
    { name: "Weapon Traits", rows: [["Name", "Text"], ...traits] },
    { name: "Talents", rows: [["Name", "Bonus", "Description"], ...talents.map(({ name, system: s }) => [name, s.bonus, text(s.description)])] },
    { name: "Races", rows: [["Name", "Bonus", "Description"], ...races.map(({ name, system: s }) => [name, s.bonus, text(s.description)])] },
    { name: "Spells", rows: [["Element", "Name", "Category", "Cost", "Range", "Target", "Check", "Duration", "Effect", "Description"],
      ...spells.map(({ name, system: s }) => [s.element, name, s.category, s.cost, s.range, s.target, s.check, s.duration, s.effect, text(s.description)])] },
    { name: "Monsters", rows: [["Name", "Level", "Element", "Weakness", "HP", "Parry", "Movement (m)", "Str", "Dex", "Con", "Wil", "Prc", "Spd", "Int", "Cha", "Attacks"],
      ...monsters.map(actor => {
        const s = actor.system;
        const monster = actor.flags?.incarnos?.monster ?? {};
        return [actor.name, s.attributes.level.value, monster.element ?? "", monster.weakness ?? "", s.health.max, s.attributes.parry.value, s.attributes.movement.value,
          ...["str", "dex", "con", "wis", "prc", "spd", "int", "cha"].map(key => s.abilities[key].value), attacks(actor)];
      })] }
  ];
}

/**
 * Make one backup and thin out the old ones.
 * @returns {{name: string, path: string, files: number, sheets: Record<string, number>, kept: string[], deleted: string[]}}
 */
export function createBackup({ vault, backupDir = DEFAULT_BACKUP_DIR, now = new Date() }) {
  if (!existsSync(vault)) throw new Error(`Vault not found: ${vault}`);
  mkdirSync(backupDir, { recursive: true });
  let name = backupName(now);
  // Two runs in the same second: keep both.
  for (let t = now.getTime() + 1000; existsSync(join(backupDir, name)); t += 1000) name = backupName(new Date(t));
  const partial = join(backupDir, `${name}.partial`);
  rmSync(partial, { recursive: true, force: true });

  let files = 0;
  cpSync(vault, join(partial, "vault"), {
    recursive: true,
    filter: source => {
      const parts = relative(vault, source).split(sep);
      if (parts.some(part => SKIP.has(part))) return false;
      if (statSync(source).isFile()) files++;
      return true;
    }
  });
  const packSource = join(root, "packs", "_source");
  if (existsSync(packSource)) cpSync(packSource, join(partial, "foundry", "packs-source"), { recursive: true });
  // Token images the monster notes point at ("Token: tokens/monsters/…"), from Foundry's data folder.
  const tokens = join(root, "..", "..", "tokens");
  if (existsSync(tokens)) cpSync(tokens, join(partial, "foundry", "tokens"), { recursive: true });

  const sheets = listSheets(vault);
  writeFileSync(join(partial, "Incarnos Lists.xlsx"), buildXlsx(sheets));
  const counts = Object.fromEntries(sheets.map(sheet => [sheet.name, sheet.rows.length - 1]));
  writeFileSync(join(partial, "README.txt"), [
    `Incarnos backup ${name}`,
    `Vault: ${vault}`,
    "",
    `vault/                  text copy of the vault (${files} files, without .git, .obsidian and .trash)`,
    "foundry/packs-source/   compendium source JSON (Items, Actors, Critical Failure RollTables with results, Macros)",
    "foundry/tokens/         token images from Foundry's data folder (copy back to <Data>/tokens)",
    `Incarnos Lists.xlsx     ${Object.entries(counts).map(([sheet, count]) => `${sheet} ${count}`).join(", ")}`,
    "",
    "Restore notes: copy files from vault/ back into the vault (e.g. System Files/Listen/...), then press",
    "\"Update Foundry from vault\" in Obsidian. To restore a compendium as it was without the vault, copy",
    "foundry/packs-source/<name> to <system>/packs/_source/<name> and run `node tools/pack.mjs <name>` with the world closed.",
    "Critical failures: critical-failures/ (six tables); macros/ (Critical Failure prompt macro). New packs need a world relaunch, not F5.",
    ""
  ].join("\r\n"));
  renameSync(partial, join(backupDir, name));

  const { kept, deleted } = pruneBackups(backupDir, now.getTime());
  return { name, path: join(backupDir, name), files, sheets: counts, kept, deleted };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const vault = process.argv[2] ?? process.env.INCARNOS_VAULT ?? "C:/Users/mfgan/IncarnosPnp";
  const result = createBackup({ vault, backupDir: process.env.INCARNOS_BACKUP_DIR || DEFAULT_BACKUP_DIR });
  console.log(`Backup: ${result.path} (${result.files} vault files; kept ${result.kept.length}, deleted ${result.deleted.length})`);
}
