/**
 * Parser for the talent notes in the Obsidian vault (the rules source of truth): `System Files/Listen/Talents/*.md`
 * (TTalents template: title, "Typ: Talent", "Bonus:" lines in the ad-check block, flavour text in the ad-example block).
 * Race notes (`Listen/Races`, TRaces template, "Typ: Race") have the same layout and become "race" Items.
 * Flat stat bonuses in Bonus become item passives; everything else is read live by module/helpers/talents.mjs.
 */
import { stableId } from "./spell-sheet.mjs";
import { parseTalentPassives } from "../module/helpers/talents.mjs";

const escapeHtml = text => text.replace(/[&<>"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);

/** Lines of the admonition block of the given type, without its title line. */
function block(markdown, type) {
  const match = markdown.match(new RegExp("```" + type + "\\s*\\n([\\s\\S]*?)\\n```"));
  return (match?.[1] ?? "").split("\n").filter(line => !/^title:/.test(line));
}

/**
 * @param {string} markdown  A talent (or race) note.
 * @param {string} fallbackName  File name without extension.
 * @param {{kind?: "Talent"|"Race"}} [options]  The "Typ:" the note must have.
 * @returns {{talent: {name: string, icon: string, bonus: string, description: string}|null, warnings: string[]}}
 */
export function parseTalentNote(markdown, fallbackName, { kind = "Talent" } = {}) {
  const text = String(markdown ?? "").replace(/\r/g, "");
  if (!new RegExp(`^Typ:\\s*${kind}\\b`, "m").test(text)) return { talent: null, warnings: [`${fallbackName}: not a ${kind.toLowerCase()} note (no "Typ: ${kind}")`] };
  const name = text.match(/^title:\s*#*\s*(.+)$/m)?.[1].trim() || fallbackName;
  const card = block(text, "ad-check");
  const icon = card.find(line => /^Icon:/.test(line))?.slice(5).trim() ?? "";
  // Icon is metadata even if a note puts it after Bonus; never feed it to the live rules parser.
  const check = card.filter(line => !/^Icon:/.test(line));
  const start = check.findIndex(line => /^Bonus:/.test(line));
  const bonus = start < 0 ? "" : [check[start].replace(/^Bonus:\s*/, ""), ...check.slice(start + 1)].join("\n").trim();
  const description = block(text, "ad-example").join("\n").trim();
  return { talent: { name, icon, bonus, description }, warnings: bonus ? [] : [`${name}: no Bonus`] };
}

function stats(systemVersion) {
  return {
    coreVersion: "14.364", systemId: "incarnos", systemVersion,
    createdTime: null, modifiedTime: null, lastModifiedBy: null, compendiumSource: null, duplicateSource: null, exportSource: null
  };
}

/**
 * Foundry source documents: one talent (feature) or race Item per note, with stable IDs and its stat bonuses as passives.
 * @param {{systemVersion?: string, type?: "feature"|"race"}} [options]
 */
export function talentsToDocuments(talents, { systemVersion = "1.4.0", type = "feature" } = {}) {
  const race = type === "race";
  return talents.map((talent, index) => {
    const id = stableId(`${race ? "race" : "talent"}:${talent.name}`);
    const passives = Object.fromEntries(parseTalentPassives(talent.bonus)
      .map((passive, number) => [`bonus${number + 1}`, { stat: passive.stat, value: passive.value, description: passive.text }]));
    const description = talent.description.split(/\n\s*\n/).map(paragraph => `<p>${escapeHtml(paragraph.trim()).replace(/\n/g, "<br>")}</p>`).join("");
    return {
      _id: id, _key: `!items!${id}`, name: talent.name, type,
      img: talent.icon?.trim() || (race ? "icons/svg/mystery-man.svg" : "icons/svg/upgrade.svg"),
      system: { description: talent.description ? description : "", bonus: talent.bonus, passivesEnabled: true, passives },
      effects: [], folder: null, sort: (index + 1) * 100000,
      ownership: { default: 0 }, flags: {}, _stats: stats(systemVersion)
    };
  });
}
