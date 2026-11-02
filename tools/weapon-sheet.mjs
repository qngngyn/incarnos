/**
 * Parser for the "Weapons" tab of the Races, Talents and Weapons sheet.
 * Columns: Name | Weapon Type ("Melee" or "Ranged (12m)") | Hands | Hitrate ("+2", "-") | Damage ("1d6", "-") | Traits (one per line).
 */
import { stableId } from "./spell-sheet.mjs";
import { getWeaponRules } from "../module/helpers/weapons.mjs";

const cell = value => String(value ?? "").trim();
const number = value => (/^[+-]?\d+$/.test(cell(value)) ? Number(cell(value)) : 0);

/**
 * @param {string[][]} rows  Grid including the header row.
 * @returns {{weapons: object[], warnings: string[]}}
 */
export function parseWeaponRows(rows) {
  const warnings = [];
  const header = (rows[0] ?? []).map(value => cell(value).toLowerCase());
  const column = name => header.findIndex(title => title.startsWith(name));
  const at = { name: column("name"), type: column("weapon type"), hands: column("hands"), hitrate: column("hitrate"), damage: column("damage"), traits: column("traits") };
  if (Object.values(at).some(index => index < 0)) throw new Error(`Unexpected header: ${rows[0]?.join(" | ")}`);

  const weapons = [];
  for (const row of rows.slice(1)) {
    const name = cell(row[at.name]).replace(/\s+/g, " ");
    if (!name) continue;
    const type = cell(row[at.type]);
    const ranged = /^ranged/i.test(type);
    if (!ranged && !/^melee/i.test(type)) warnings.push(`${name}: unknown weapon type "${type}", treated as melee`);
    const traits = cell(row[at.traits]).split("\n").map(line => line.trim()).filter(Boolean).join("\n");
    const damage = cell(row[at.damage]);
    const hitrate = cell(row[at.hitrate]);
    if (hitrate && hitrate !== "-" && !/^[+-]?\d+$/.test(hitrate)) warnings.push(`${name}: hitrate "${hitrate}" is not a number, using 0`);
    weapons.push({
      name,
      attackMode: ranged ? "ranged" : "melee",
      // Ranged weapons carry their range in the type column; melee weapons only when they have Reach.
      range: ranged ? (type.match(/\(([^)]+)\)/)?.[1] ?? "") : getWeaponRules({ traits }).reach,
      hands: Math.max(1, number(row[at.hands]) || 1),
      modifier: number(hitrate),
      damage: damage === "-" ? "" : damage,
      traits
    });
  }
  return { weapons, warnings };
}

function stats(systemVersion) {
  return {
    coreVersion: "14.364", systemId: "incarnos", systemVersion,
    createdTime: null, modifiedTime: null, lastModifiedBy: null, compendiumSource: null, duplicateSource: null, exportSource: null
  };
}

/** Foundry source documents: a Melee and a Ranged folder plus one weapon Item per row, with stable IDs. */
export function weaponsToDocuments(weapons, { icon = () => null, systemVersion = "1.4.0" } = {}) {
  const folders = ["Melee", "Ranged"].map((name, index) => {
    const id = stableId(`folder:weapons:${name}`);
    return { _id: id, _key: `!folders!${id}`, name, type: "Item", folder: null, sorting: "m", sort: (index + 1) * 100000, color: null, description: "", flags: {}, _stats: stats(systemVersion) };
  });
  const folderFor = mode => folders[mode === "ranged" ? 1 : 0]._id;
  const items = weapons.map((weapon, index) => {
    const id = stableId(`weapon:${weapon.name}`);
    const { name, ...system } = weapon;
    // "Parry: +1 Parry" becomes an item passive, so the owner's Parry rises while the weapon's passives are on.
    const parry = getWeaponRules(weapon).traits.find(trait => trait.name === "Parry")?.text.match(/([+-]\d+)\s*Parry/i);
    const passives = parry ? { parry: { stat: "attributes.parry.value", value: Number(parry[1]), description: "Parry trait" } } : {};
    return {
      _id: id, _key: `!items!${id}`, name, type: "weapon",
      img: icon(weapon) ?? (weapon.attackMode === "ranged" ? "icons/weapons/bows/bow-simple-small.webp" : "icons/svg/sword.svg"),
      system: { description: "", passivesEnabled: true, passives, quantity: 1, weight: 0, versatile: false, ...system },
      effects: [], folder: folderFor(weapon.attackMode), sort: (index + 1) * 100000,
      ownership: { default: 0 }, flags: {}, _stats: stats(systemVersion)
    };
  });
  return [...folders, ...items];
}
