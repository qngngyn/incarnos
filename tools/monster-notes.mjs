/**
 * Parser for the monster notes in the Obsidian vault (the rules source of truth):
 * `Welten/Incarnos/Custom Monsters/<Type>/**.md` (TMonster template: "Level N" title, a "### Stats:" block with
 * Element, Weakness, HP, Parry, Speed, Token, Traits; optional IP, Race, Talents, Spells, Disposition;
 * an "Attacks:" and an "Actions:" block, the stat table and
 * the German description blocks). Each monster becomes an NPC actor: attacks that read (modifier written for the heroes)
 * `Name: Melee|Ranged [(range)] [modifier] <damage>[, traits]` become weapons. Optional race/talent/spell names
 * resolve to compendium item copies; subdirectories become folders (maximum depth 4). Other abilities stay text.
 */
import { stableId } from "./spell-sheet.mjs";
import { splitTopLevel, traitLine } from "./weapon-notes.mjs";

const STATS = ["str", "dex", "con", "wis", "prc", "spd", "int", "cha"];
const ATTACK = /^(.+?):\s*(Melee|Ranged)\s*(?:\(([^)]*)\))?\s*([+-]\s*\d+)?\s+(\d*d\d+(?:\s*[+-]\s*\d+)?)\s*(.*)$/i;

const escapeHtml = text => String(text).replace(/[&<>"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
/** Obsidian markup as plain text: links lose their brackets, embedded images become a hint. */
const plain = text => String(text).replace(/!\[\[[^\]]*\]\]/g, "(image in the vault note)").replace(/\[\[([^\]|#]+)(?:[|#]([^\]]*))?\]\]/g, (_, name, alias) => alias || name);
const paragraphs = text => text.split(/\n\s*\n/).map(part => part.trim()).filter(Boolean)
  .map(part => `<p>${escapeHtml(plain(part)).replace(/\n/g, "<br>")}</p>`).join("");
const number = text => Number(String(text).replace(",", "."));
// Resolve the link target rather than its display label.
const itemName = text => String(text).replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, "$1").trim();
// Case- and quote-insensitive item lookup (the spell note `Hurl "Bolder"` is linked as [[Hurl Bolder]]).
const lookupKey = name => String(name).toLowerCase().replace(/["“”„]/g, "").replace(/\s+/g, " ").trim();
const itemNames = text => [...new Set(splitTopLevel(text).map(itemName).filter(Boolean))];

/** Lines of the first admonition block whose title matches, without the title line. */
function block(markdown, titlePattern) {
  // The block ends at the next fence at the start of a line (an empty block has none before it).
  const match = markdown.match(new RegExp("`{3,4}ad-\\w+\\s*\\ntitle:\\s*(?:#+\\s*)?" + titlePattern + "[^\\n]*\\n([\\s\\S]*?)^`{3,4}", "m"));
  return match ? match[1].trim() : "";
}

/** Movement in metres from "7 (10,5m)", "3m" or "5" squares (1 square = 1,5 m). */
export function speedMetres(speed) {
  const text = String(speed ?? "");
  const metres = text.match(/(\d+(?:[.,]\d+)?)\s*m\b/);
  if (metres) return number(metres[1]);
  const squares = text.match(/\d+(?:[.,]\d+)?/);
  return squares ? number(squares[0]) * 1.5 : 0;
}

/**
 * One attack line as a weapon, or null when it is not a plain weapon attack (e.g. a cone with a save).
 * @param {Record<string, string>} traits  Weapon trait name -> text, for "[[Reach]] (3m)".
 */
export function parseAttackLine(line, traits = {}, warnings = [], monster = "") {
  const match = line.replace(/^-\s*/, "").match(ATTACK);
  if (!match) return null;
  const [, rawName, mode, modeRange = "", hitrate = "0", damage, restRaw] = match;
  const name = rawName.replace(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g, "$1").trim();
  const rest = restRaw.replace(/^,\s*/, "").trim();
  const entries = splitTopLevel(rest);
  const reach = rest.match(/\[\[Reach\]\]\s*\(([^)]*)\)/i)?.[1];
  return {
    name,
    attackMode: mode.toLowerCase() === "ranged" ? "ranged" : "melee",
    modifier: Number(hitrate.replace(/\s/g, "")),
    damage: damage.replace(/\s/g, ""),
    range: modeRange || reach || "",
    traits: entries.map(entry => plain(traitLine(entry, traits, warnings, `${monster} ${name}`))).join("\n")
  };
}

/**
 * @param {string} markdown  A monster note.
 * @param {string} fallbackName  File name without extension (monster notes have no name in the note).
 * @param {{traits?: Record<string, string>}} [options]
 * @returns {{monster: object|null, warnings: string[]}}
 */
export function parseMonsterNote(markdown, fallbackName, { traits = {} } = {}) {
  const text = String(markdown ?? "").replace(/\r/g, "");
  if (!/title:\s*#*\s*Stats:/i.test(text)) return { monster: null, warnings: [`${fallbackName}: not a monster note (no Stats block)`] };
  const warnings = [];
  const field = name => (text.match(new RegExp(`^${name}:[ \\t]*(.*)$`, "m"))?.[1] ?? "").trim();
  const statsText = block(text, "Stats:");
  const optional = name => (statsText.match(new RegExp(`^${name}:[ \\t]*(.*)$`, "mi"))?.[1] ?? "").trim();
  const level = Number(text.match(/title:\s*Level\s*(\d+)/i)?.[1] ?? 0);
  const table = text.match(/\|\s*Str[^\n]*\n\|[-\s|]+\n(\|[^\n]*)/);
  const values = table ? table[1].split("|").slice(1, -1).map(cell => Number(cell.trim())) : [];
  const hp = Number(field("HP").match(/\d+/)?.[0] ?? NaN);
  if (!values.some(value => value > 0) || !Number.isFinite(hp)) return { monster: null, warnings: [`${fallbackName}: incomplete (needs HP and the stat table), skipped`] };
  const abilities = Object.fromEntries(STATS.map((key, index) => [key, Number.isFinite(values[index]) && values[index] > 0 ? values[index] : 5]));

  // Traits: from "Traits:" to the attacks block.
  const traitsText = (text.match(/^Traits:[ \t]*(.*)\n([\s\S]*?)(?=`{3}ad-warning)/m) ?? []).slice(1).join("\n").trim();
  const weapons = [];
  const special = [];
  for (const raw of block(text, "Attacks:").split("\n").map(line => line.trim()).filter(Boolean)) {
    const weapon = parseAttackLine(raw, traits, warnings, fallbackName);
    if (weapon) { weapons.push(weapon); continue; }
    // "- …" lines explain the attack above them, unless they name their own attack ("- Feuerblitz: …");
    // anything else is a special attack or ability.
    const named = /^-\s*[^:\s][^:]{0,30}:/.test(raw) && raw.replace(/^-\s*/, "").split(":")[0].trim().split(/\s+/).length <= 4;
    if (/^-/.test(raw) && !named && weapons.length && !special.length) weapons.at(-1).notes = [weapons.at(-1).notes, raw.replace(/^-\s*/, "")].filter(Boolean).join("\n");
    else special.push(raw);
  }
  const description = block(text, "Beschreibung:").replace(/^###\s*$/m, "").trim();
  const full = block(text, "Volle Beschreibung:").trim();
  return {
    monster: {
      name: fallbackName, level, element: field("Element").replace(/^-$/, ""), weakness: field("Weakness").replace(/^-$/, ""),
      hp, parry: Number(field("Parry").match(/\d+/)?.[0] ?? 10), speed: field("Speed"), movement: speedMetres(field("Speed")),
      ip: /^\d+$/.test(optional("IP")) ? Number(optional("IP")) : 0,
      race: itemName(optional("Race")), talents: itemNames(optional("Talents")), spells: itemNames(optional("Spells")),
      disposition: ({ neutral: 0, friendly: 1, hostile: -1 })[optional("Disposition").toLowerCase()] ?? -1,
      size: /^[1-9]\d*$/.test(field("Size")) ? Number(field("Size")) : 1,
      token: field("Token"), abilities, traits: traitsText, weapons, special: special.join("\n"),
      actions: block(text, "Actions:").trim(), description, fullDescription: full
    },
    warnings
  };
}

function stats(systemVersion) {
  return {
    coreVersion: "14.364", systemId: "incarnos", systemVersion,
    createdTime: null, modifiedTime: null, lastModifiedBy: null, compendiumSource: null, duplicateSource: null, exportSource: null
  };
}

const feature = (id, actorId, name, text, sort, systemVersion) => ({
  _id: id, _key: `!actors.items!${actorId}.${id}`, name, type: "feature", img: "icons/svg/aura.svg",
  system: { description: paragraphs(text), bonus: "", passivesEnabled: true, passives: {} },
  effects: [], folder: null, sort, ownership: { default: 0 }, flags: {}, _stats: stats(systemVersion)
});

/**
 * Foundry source documents: nested folders (up to depth 4), NPCs with weapons, text features and optional
 * race/talent/spell copies. Embedded items use `!actors.items!<actor>.<item>` keys.
 * @param {{monster: object, type: string, folderPath?: string}[]} entries
 * @param {{systemVersion?: string, sources?: object, warnings?: string[]}} options Item source arrays by pack name.
 */
export function monstersToDocuments(entries, { systemVersion = "1.4.0", sources = {}, warnings = [] } = {}) {
  const docs = [];
  const folders = new Map();
  const folderPath = entry => (entry.folderPath ?? entry.type).split("/").filter(Boolean).slice(0, 4).join("/");
  const paths = new Set();
  for (const entry of entries) {
    const parts = folderPath(entry).split("/").filter(Boolean);
    parts.forEach((_, index) => paths.add(parts.slice(0, index + 1).join("/")));
  }
  for (const path of [...paths].sort()) {
    const id = stableId(`folder:monsters:${path}`);
    folders.set(path, id);
    const parts = path.split("/");
    const name = parts.pop();
    docs.push({ _id: id, _key: `!folders!${id}`, name, type: "Actor", folder: folders.get(parts.join("/")) ?? null, sorting: "a", sort: 0, color: null, description: "", flags: {}, _stats: stats(systemVersion) });
  }
  const indices = Object.fromEntries(["races", "talents", "spells"].map(pack => [pack,
    new Map((sources[pack] ?? []).filter(doc => doc._key === `!items!${doc._id}`)
      .map(doc => [lookupKey(doc.name), doc]))]));
  entries.forEach((entry, index) => {
    const { monster: m, type } = entry;
    const actorId = stableId(`monster:${type}/${m.name}`);
    const items = [];
    m.weapons.forEach((weapon, i) => {
      const id = stableId(`monster:${type}/${m.name}:attack:${weapon.name}:${i}`);
      items.push({
        _id: id, _key: `!actors.items!${actorId}.${id}`, name: weapon.name, type: "weapon",
        img: weapon.attackMode === "ranged" ? "icons/svg/target.svg" : "icons/svg/sword.svg",
        system: {
          description: weapon.notes ? paragraphs(weapon.notes) : "", passivesEnabled: true, passives: {}, quantity: 1, weight: 0,
          versatile: false, attackMode: weapon.attackMode, range: weapon.range, hands: 1, modifier: weapon.modifier, damage: weapon.damage, traits: weapon.traits
        },
        effects: [], folder: null, sort: (i + 1) * 100000, ownership: { default: 0 }, flags: {}, _stats: stats(systemVersion)
      });
    });
    const texts = [["Traits", m.traits], ["Special Attacks", m.special], ["Actions", m.actions]].filter(([, text]) => text);
    texts.forEach(([name, text], i) => items.push(feature(stableId(`monster:${type}/${m.name}:${name}`), actorId, name, text, (i + 1) * 100000, systemVersion)));
    for (const [pack, names] of [["races", m.race ? [m.race] : []], ["talents", m.talents ?? []], ["spells", m.spells ?? []]]) {
      for (const name of names) {
        const source = indices[pack].get(lookupKey(name));
        if (!source) { warnings.push(`${m.name}: unknown ${pack} item "${name}"`); continue; }
        const id = stableId(`monster:${type}/${m.name}:item:${source._id}`);
        if (items.some(item => item._id === id)) continue;
        const uuid = `Compendium.incarnos.${pack}.Item.${source._id}`;
        const copy = structuredClone(source);
        // The note's stats, HP, Parry and Speed already include race/talent bonuses: switch their flat passives off
        // so they don't count twice. Rule text (save bonuses, advantage, darkvision) still applies.
        if (pack !== "spells") copy.system = { ...copy.system, passivesEnabled: false };
        items.push({ ...copy, _id: id, _key: `!actors.items!${actorId}.${id}`, folder: null,
          sort: (items.length + 1) * 100000,
          flags: { ...copy.flags, core: { ...copy.flags?.core, sourceId: uuid },
            incarnos: { ...copy.flags?.incarnos, sourceUuid: uuid } },
          _stats: { ...stats(systemVersion), ...copy._stats, compendiumSource: uuid } });
      }
    }

    const header = [m.element && `Element: ${m.element}`, m.weakness && `Weakness: ${m.weakness}`, m.speed && `Speed: ${m.speed}`].filter(Boolean).join(" · ");
    const biography = [header ? `<p><strong>${escapeHtml(header)}</strong></p>` : "", paragraphs(m.description), paragraphs(m.fullDescription)].join("");
    const img = m.token || "icons/svg/mystery-man.svg";
    docs.push({
      _id: actorId, _key: `!actors!${actorId}`, name: m.name, type: "npc", img,
      system: {
        health: { value: m.hp, min: 0, max: m.hp, bonus: 0 },
        power: { value: m.ip ?? 0, min: 0, max: m.ip ?? 0, bonus: 0 },
        attributes: { level: { value: m.level }, parry: { value: m.parry, bonus: 0 }, movement: { value: m.movement, bonus: 0 } },
        abilities: Object.fromEntries(Object.entries(m.abilities).map(([key, value]) => [key, { value, bonus: 0 }])),
        biography
      },
      prototypeToken: { name: m.name, width: m.size ?? 1, height: m.size ?? 1, texture: { src: img }, disposition: m.disposition ?? -1, actorLink: false },
      items: items.map(item => item._id), effects: [], folder: folders.get(folderPath(entry)) ?? null, sort: (index + 1) * 100000,
      ownership: { default: 0 }, flags: { incarnos: { monster: { element: m.element, weakness: m.weakness, level: m.level } } },
      _stats: stats(systemVersion)
    });
    docs.push(...items);
  });
  return docs;
}
