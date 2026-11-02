/**
 * Parser for the spell notes in the Obsidian vault (the rules source of truth):
 * `System Files/Listen/Spells/<Element>/*.md` (TSpells template: title, "Typ: Spell" and the card fields in the
 * ad-check block, flavour text in the ad-example block). Each element folder has a note `<Element>.md` with
 * "Typ: Element" and its "Affinity:". The fields match the old Elements sheet cards, so spell automation
 * (module/helpers/spells.mjs) reads them the same way.
 */
import { parseCost } from "./spell-sheet.mjs";

/** Lines of the admonition block of the given type, without its title line. */
function block(markdown, type) {
  const match = markdown.match(new RegExp("```" + type + "\\s*\\n([\\s\\S]*?)\\n```"));
  return (match?.[1] ?? "").split("\n").filter(line => !/^title:/.test(line));
}

const noteName = (text, fallbackName) => text.match(/^title:\s*#*\s*(.+)$/m)?.[1].trim() || fallbackName;

/**
 * Field values of an ad-check block. A field runs until the next "Field:" line, so Effect can span lines.
 * @returns {Record<string, string>}
 */
function fields(lines) {
  const values = {};
  let current = null;
  for (const line of lines) {
    const field = line.match(/^(Typ|Affinity|Element|Icon|Category|Cost|Range|Target|Check|Duration|Effect):\s?(.*)$/);
    if (field) { current = field[1]; values[current] = field[2]; }
    else if (current) values[current] += `\n${line}`;
  }
  for (const key of Object.keys(values)) values[key] = values[key].trim();
  return values;
}

/**
 * @param {string} markdown  A spell note.
 * @param {string} fallbackName  File name without extension.
 * @param {string} folderElement  Name of the element folder the note is in (used when the note has no Element).
 * @returns {{spell: object|null, warnings: string[]}}
 */
export function parseSpellNote(markdown, fallbackName, folderElement = "") {
  const text = String(markdown ?? "").replace(/\r/g, "");
  if (!/^Typ:\s*Spell\b/m.test(text)) return { spell: null, warnings: [`${fallbackName}: not a spell note (no "Typ: Spell")`] };
  const name = noteName(text, fallbackName);
  const values = fields(block(text, "ad-check"));
  const element = values.Element || folderElement;
  const warnings = [];
  if (values.Element && folderElement && values.Element !== folderElement) warnings.push(`${name}: Element "${values.Element}" but the note is in the ${folderElement} folder`);
  const cost = values.Cost ?? "";
  const spell = {
    element, name, icon: values.Icon ?? "", category: values.Category ?? "", description: block(text, "ad-example").join("\n").trim(),
    cost, ...parseCost(cost),
    range: values.Range ?? "", target: values.Target ?? "", check: values.Check ?? "", duration: values.Duration ?? "", effect: values.Effect ?? ""
  };
  for (const field of ["cost", "range", "check", "effect"]) if (!spell[field]) warnings.push(`${element}: "${name}" has no ${field}`);
  return { spell, warnings };
}

/**
 * @param {string} markdown  An element note (`<Element>.md` in its spell folder).
 * @returns {{element: string, affinity: string}|null}  affinity as written, e.g. "Fire Affinity: You have resistance to fire dmg."
 */
export function parseElementNote(markdown, fallbackName) {
  const text = String(markdown ?? "").replace(/\r/g, "");
  if (!/^Typ:\s*Element\b/m.test(text)) return null;
  const element = noteName(text, fallbackName);
  const affinity = fields(block(text, "ad-check")).Affinity ?? "";
  return { element, affinity };
}
