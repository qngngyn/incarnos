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
  // Only the first title line (the ad-note heading); an empty one falls back to the file name.
  const name = text.match(/^title:[ \t]*#*[ \t]*(.*)$/m)?.[1].trim() || fallbackName;
  if (!/^Typ:\s*Waffe/m.test(text)) return { row: null, warnings: [`${fallbackName}: not a weapon note (no "Typ: Waffe")`] };
  const values = Object.fromEntries(Object.entries(FIELDS).map(([key, label]) => [key, field(label)]));
  if (/^\d+(?:[.,]\d+)?\s*m$/i.test(values.type)) values.type = `Ranged (${values.type})`; // "18m" = a ranged weapon
  // Traits on the "Traits:" line (comma list) or on the lines below it until the block ends; "- Name: text" bullets
  // are one trait each (their text may hold commas).
  const below = text.match(/^Traits:[ \t]*\r?\n([\s\S]*?)^```/m)?.[1] ?? "";
  const entries = [values.traits, ...below.split(/\r?\n/)].map(line => line.trim()).filter(Boolean)
    .flatMap(line => (/^[-*]\s+/.test(line) ? [line.replace(/^[-*]\s+/, "")] : splitTopLevel(line)));
  const traitLines = entries.map(entry => traitLine(entry, traits, warnings, name));
  // "2d8 + 1d8 vs Undead/Fiends": the leading roll is the damage, the conditional rest becomes a trait line.
  let damage = values.damage;
  const extra = damage.match(/^(\d*d\d+(?:\s*[+-]\s*\d+(?!\s*d))*)\s*(\S.*[a-z].*)$/i);
  if (extra) { damage = extra[1]; traitLines.push(`Bonus Damage: ${extra[2].replace(/^([+-])\s+/, "$1")}`); }
  return { row: [name, values.type, values.hands, values.hitrate, damage, traitLines.join("\n"), field("Icon"), noteDescription(text)], warnings };
}

/** Text of the "Beschreibung" block (ad-example), without empty heading lines. */
export function noteDescription(markdown) {
  const block = String(markdown ?? "").match(/^```ad-example[ \t]*\r?\ntitle:[^\n]*Beschreibung[^\n]*\r?\n([\s\S]*?)^```/m)?.[1] ?? "";
  return block.split(/\r?\n/).filter(line => !/^#+\s*$/.test(line.trim())).join("\n").trim();
}

/** Sheet-shaped grid (with header) from all weapon notes. */
export function weaponNotesToRows(notes, traits) {
  const warnings = [];
  const rows = [["Name", "Weapon Type", "Hands", "Hitrate", "Damage", "Traits", "Icon", "Description"]];
  for (const { name, markdown } of notes) {
    const result = parseWeaponNote(markdown, name, traits);
    warnings.push(...result.warnings);
    if (result.row) rows.push(result.row);
  }
  return { rows, warnings };
}
