/**
 * Parser for the weapon notes in the Obsidian vault (the rules source of truth):
 * `System Files/Listen/Weapons/*.md` (TWeapons template) and `Weapon Traits/*.md` ("Name (args): text").
 * Turns them into the same rows as the old Weapons sheet, so `parseWeaponRows` builds the weapons.
 */

const FIELDS = { type: "Reichweite", hands: "Anzahl Hände", hitrate: "Hitrate", damage: "Damage", traits: "Traits" };

/** Splits on commas outside parentheses, keeping decimal commas: "A 4,5m (x, y), B" -> ["A 4,5m (x, y)", "B"]. */
export function splitTopLevel(text) {
  const parts = [];
  let depth = 0, current = "";
  const chars = [...text];
  for (const [index, char] of chars.entries()) {
    if (char === "(") depth++;
    if (char === ")") depth = Math.max(0, depth - 1);
    const decimal = /\d/.test(chars[index - 1] ?? "") && /\d/.test(chars[index + 1] ?? "");
    if (char === "," && depth === 0 && !decimal) { parts.push(current); current = ""; } else current += char;
  }
  parts.push(current);
  return parts.map(part => part.trim()).filter(Boolean);
}

/** "Deadly (dice, e.g. D4): When you crit, …" -> the text after the first colon. */
export function parseTraitNote(markdown) {
  const text = String(markdown ?? "").trim();
  const colon = text.indexOf(":");
  return colon < 0 ? text : text.slice(colon + 1).trim();
}

/**
 * One trait entry of a weapon note as a sheet trait line.
 * "[[Deadly]] D8" -> "Deadly D8: <note text>"; a trailing "(…)" fills the note's "(…)" placeholder
 * or, without one, replaces the text ("[[Parry]] (+1 Parry)" -> "Parry: +1 Parry").
 */
export function traitLine(entry, traits, warnings, weapon) {
  const link = entry.match(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/);
  if (!link) return entry;
  const name = link[1].trim();
  const prefix = entry.slice(0, link.index).trim();
  let rest = entry.slice(link.index + link[0].length).trim();
  const detailMatch = rest.match(/\((.*)\)\s*$/);
  const detail = detailMatch?.[1];
  if (detailMatch) rest = rest.slice(0, detailMatch.index).trim();
  let text = traits[name];
  if (text === undefined) { warnings.push(`${weapon}: no trait note "${name}"`); text = ""; }
  if (detail !== undefined) text = /\([^)]*\)/.test(text) ? text.replace(/\([^)]*\)/, detail) : detail;
  const label = [prefix, name, rest].filter(Boolean).join(" ");
  return text ? `${label}: ${text}` : label;
}

/**
 * @param {string} markdown  A weapon note.
 * @param {string} fallbackName  File name without extension.
 * @param {Record<string, string>} traits  Trait name -> text (from parseTraitNote).
 * @returns {{row: string[]|null, warnings: string[]}}  Row: Name | Weapon Type | Hands | Hitrate | Damage | Traits.
 */
export function parseWeaponNote(markdown, fallbackName, traits = {}) {
  const warnings = [];
  const text = String(markdown ?? "");
  const field = label => text.match(new RegExp(`^${label}:[ \\t]*(.*)$`, "m"))?.[1].trim() ?? "";
  const name = text.match(/^title:\s*#*\s*(.+)$/m)?.[1].trim() || fallbackName;
  if (!/^Typ:\s*Waffe/m.test(text)) return { row: null, warnings: [`${fallbackName}: not a weapon note (no "Typ: Waffe")`] };
  const values = Object.fromEntries(Object.entries(FIELDS).map(([key, label]) => [key, field(label)]));
  const traitLines = splitTopLevel(values.traits).map(entry => traitLine(entry, traits, warnings, name));
  return { row: [name, values.type, values.hands, values.hitrate, values.damage, traitLines.join("\n")], warnings };
}

/** Sheet-shaped grid (with header) from all weapon notes. */
export function weaponNotesToRows(notes, traits) {
  const warnings = [];
  const rows = [["Name", "Weapon Type", "Hands", "Hitrate", "Damage", "Traits"]];
  for (const { name, markdown } of notes) {
    const result = parseWeaponNote(markdown, name, traits);
    warnings.push(...result.warnings);
    if (result.row) rows.push(result.row);
  }
  return { rows, warnings };
}
