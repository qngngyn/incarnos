import { createHash } from "node:crypto";

/**
 * Parser for the "Incarnos Elements List" Google Sheet.
 * Each tab is one element. Spells are laid out as cards in a grid, three per row:
 *   row 0: category (offset 0) | name (offset 1)
 *   then:  "by <author>", flavour text, cost ("2 Actions, 10 IP"),
 *          range | target, check | duration, effect text (offset 0).
 */

export const SPELL_CATEGORY = /^(Attack|Heal|Buff|Debuff|Control|Utility|Movement|Everything)(\s*\/\s*(Attack|Heal|Buff|Debuff|Control|Utility|Movement|Everything))*$/i;
const CARD_WIDTH = 19;
const COST = /\b(\d+|X)\s*(Actions?|Reactions?)\b/i;
const AUTHOR = /^by\s/i;

/** Minimal RFC 4180 CSV parser (quoted cells may contain commas and newlines). */
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    }
    else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/**
 * "2 Actions, 10 IP" -> { actions: 2, actionType: "action", mp: 10 }
 * Variable IP costs ("X * 8 IP", "3 IP times 4d4") give mp 0; the cost text keeps the detail.
 */
export function parseCost(cost = "") {
  const action = cost.match(/(\d+)\s*(Action|Reaction)s?/i);
  const mp = cost.split(",").map(part => part.trim().match(/^(\d+)\s*(?:IP|MP|PP)$/i)).find(Boolean);
  return {
    actions: action ? Number(action[1]) : 0,
    actionType: action?.[2].toLowerCase() === "reaction" ? "reaction" : "action",
    // system.mp holds the Incarna (IP) cost; retain the legacy key in imported spell items.
    mp: mp ? Number(mp[1]) : 0
  };
}

const cellText = value => String(value ?? "").trim();

function isHeader(row, col) {
  return SPELL_CATEGORY.test(cellText(row[col])) && cellText(row[col + 1]) !== "";
}

/** Non-empty cells of one card row as [{ col, offset, text }]. */
function cardCells(row, start, end) {
  const cells = [];
  for (let col = start; col < end; col++) {
    const text = cellText(row[col]);
    if (text) cells.push({ col, offset: col - start, text });
  }
  return cells;
}

/**
 * Parse one element tab.
 * @param {string[][]} rows   Grid of cell values.
 * @param {string} element    Tab name, e.g. "Fire".
 * @returns {{element: string, affinity: string, spells: object[], warnings: string[]}}
 */
export function parseElementSheet(rows, element) {
  const warnings = [];
  const affinity = rows.flat().map(cellText).find(text => /Affinity/i.test(text)) ?? "";

  // Locate every card header and the column range its card occupies.
  const headers = [];
  rows.forEach((row = [], r) => {
    const cols = [];
    for (let c = 0; c < row.length; c++) if (isHeader(row, c)) cols.push(c);
    cols.forEach((c, i) => headers.push({ r, c, end: Math.min(cols[i + 1] ?? Infinity, c + CARD_WIDTH) }));
  });

  // Every cell a spell uses, so leftover sheet text is reported instead of silently lost.
  const used = new Set();
  const spells = [];
  for (const { r, c, end } of headers) {
    const category = cellText(rows[r][c]);
    const name = cellText(rows[r][c + 1]).replace(/\s+/g, " ");
    const nextHeader = headers.find(h => h.r > r && h.c === c)?.r ?? rows.length;

    const body = [];
    for (let i = r + 1; i < nextHeader; i++) {
      const cells = cardCells(rows[i] ?? [], c, end).filter(cell => !AUTHOR.test(cell.text));
      cells.forEach(cell => cell.key = `${i}:${cell.col}`);
      if (cells.length) body.push(cells);
    }

    used.add(`${r}:${c}`).add(`${r}:${c + 1}`);
    body.flat().forEach(cell => used.add(cell.key));

    const costIndex = body.findIndex(cells => COST.test(cells[0].text));
    if (costIndex < 0) {
      warnings.push(`${element}: "${name}" has no cost line, skipped`);
      continue;
    }

    const description = body.slice(0, costIndex).flat().map(cell => cell.text).join("\n\n");
    const cost = body[costIndex].map(cell => cell.text).join(", ");
    const [rangeRow = [], checkRow = [], ...effectRows] = body.slice(costIndex + 1);
    const spell = {
      element,
      name,
      category,
      description,
      cost,
      ...parseCost(cost),
      range: rangeRow[0]?.text ?? "",
      target: rangeRow.slice(1).map(cell => cell.text).join(" · "),
      check: checkRow[0]?.text ?? "",
      duration: checkRow.slice(1).map(cell => cell.text).join(" · "),
      effect: effectRows.map(cells => cells.map(cell => cell.text).join(" · ")).join("\n")
    };
    for (const field of ["range", "check", "effect"]) {
      if (!spell[field]) warnings.push(`${element}: "${name}" has no ${field}`);
    }
    spells.push(spell);
  }

  rows.forEach((row = [], r) => row.forEach((value, c) => {
    const text = cellText(value);
    if (!text || used.has(`${r}:${c}`) || AUTHOR.test(text) || text === affinity || text === element) return;
    warnings.push(`${element}: sheet text not in any spell: "${text.replace(/\s+/g, " ").slice(0, 60)}"`);
  }));

  return { element, affinity, spells, warnings };
}

/** Deterministic 16-character Foundry document ID, so re-imports keep the same IDs. */
export function stableId(key) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = createHash("sha1").update(key).digest();
  return Array.from(bytes.subarray(0, 16), byte => chars[byte % chars.length]).join("");
}

const escapeHtml = text => text.replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);

function stats(systemVersion) {
  return {
    coreVersion: "14.364",
    systemId: "incarnos",
    systemVersion,
    createdTime: null,
    modifiedTime: null,
    lastModifiedBy: null,
    compendiumSource: null,
    duplicateSource: null,
    exportSource: null
  };
}

/** Foundry source documents (one Folder + its spell Items) for a parsed element tab. */
export function elementToDocuments({ element, affinity, spells }, { img, sort = 0, systemVersion = "1.4.0" } = {}) {
  const folderId = stableId(`folder:spells:${element}`);
  const folder = {
    _id: folderId,
    _key: `!folders!${folderId}`,
    name: element,
    type: "Item",
    folder: null,
    sorting: "m",
    sort,
    color: null,
    description: affinity,
    flags: {},
    _stats: stats(systemVersion)
  };

  // IDs depend on element + name (not position), so adding a card to the sheet keeps the other IDs.
  const seen = new Map();
  const items = spells.map((spell, index) => {
    const repeat = seen.get(spell.name) ?? 0;
    seen.set(spell.name, repeat + 1);
    const id = stableId(`spell:${element}:${spell.name}${repeat ? `:${repeat}` : ""}`);
    const { element: _element, name, description, icon, ...fields } = spell;
    return {
      _id: id,
      _key: `!items!${id}`,
      name,
      type: "spell",
      img: icon || img || "icons/svg/book.svg",
      system: {
        description: description ? description.split(/\n{2,}/).map(p => `<p>${escapeHtml(p)}</p>`).join("") : "",
        passivesEnabled: true,
        passives: {},
        spellLevel: 1,
        element,
        ...fields
      },
      effects: [],
      folder: folderId,
      sort: (index + 1) * 100000,
      ownership: { default: 0 },
      flags: {},
      _stats: stats(systemVersion)
    };
  });

  return [folder, ...items];
}
