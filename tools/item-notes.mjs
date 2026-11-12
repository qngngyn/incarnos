/**
 * Parser for item notes in the Obsidian vault (TItems layout): `Welten/Incarnos/Listen/Shop/*.md` and
 * `Welten/Incarnos/Custom Items/*.md` with "Typ: Potion" or "Typ: Item".
 * The ad-check block holds Icon, Cost, Effect, Price and Bonus; the ad-example block is the description.
 * Effect "Heals 2d8 + 2 HP" / "Restores 3d6 IP" becomes a potion's heal / incarna formulas (module/helpers/potions.mjs).
 * "Bonus:" lines (one per line below it, as in talents: "+1 Attack", "+2 Parry") become the item's passives.
 */
import { stableId } from "./spell-sheet.mjs";
import { parsePotionActions, parsePotionEffect } from "../module/helpers/potions.mjs";
import { parseTalentPassives } from "../module/helpers/talents.mjs";

const escapeHtml = text => text.replace(/[&<>"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);

function block(markdown, type) {
  const match = markdown.match(new RegExp("```" + type + "\\s*\\n([\\s\\S]*?)\\n```"));
  return (match?.[1] ?? "").split("\n").filter(line => !/^title:/.test(line));
}

/** Item kinds that become compendium items, and the folder each goes into. */
export const ITEM_KINDS = { Potion: "Potions", Item: "Equipment" };

/**
 * @returns {{item: {kind, name, icon, cost, effect, price, bonus, passives, description, heal, incarna, actions}|null,
 *   warnings: string[]}}  item is null (without a warning) for notes that are no item of a known kind, e.g. the shop's price list.
 */
export function parseItemNote(markdown, fallbackName) {
  const text = String(markdown ?? "").replace(/\r/g, "");
  const kind = text.match(/^Typ:\s*(\w+)/m)?.[1];
  if (!kind || !ITEM_KINDS[kind]) return { item: null, warnings: [] };
  const name = text.match(/^title:\s*#*\s*(.+)$/m)?.[1].trim() || fallbackName;
  const card = block(text, "ad-check");
  const field = key => card.find(line => new RegExp(`^${key}:`).test(line))?.replace(new RegExp(`^${key}:\\s*`), "").trim() ?? "";
  const effect = field("Effect");
  const { heal, incarna } = kind === "Potion" ? parsePotionEffect(effect) : { heal: "", incarna: "" };
  const warnings = kind === "Potion" && !heal && !incarna
    ? [`${name}: Effect "${effect}" names no healing ("Heals 2d8 HP") or IP ("Restores 3d6 IP")`] : [];
  // Bonus: the text after "Bonus:" and every line below it in the stat block.
  const start = card.findIndex(line => /^Bonus:/.test(line));
  const bonus = start < 0 ? "" : [card[start].replace(/^Bonus:\s*/, ""), ...card.slice(start + 1)].join("\n").trim();
  const passives = parseTalentPassives(bonus);
  if (bonus && !passives.length) warnings.push(`${name}: Bonus "${bonus}" has no stat bonus Foundry knows (e.g. "+1 Attack", "+2 Parry")`);
  return { item: { kind, name, icon: field("Icon"), cost: field("Cost"), effect, price: field("Price"), bonus, passives,
    description: block(text, "ad-example").join("\n").trim(), heal, incarna, actions: parsePotionActions(field("Cost")) }, warnings };
}

const stats = systemVersion => ({ coreVersion: "14.364", systemId: "incarnos", systemVersion,
  createdTime: null, modifiedTime: null, lastModifiedBy: null, compendiumSource: null, duplicateSource: null, exportSource: null });

/** Foundry source documents: a folder per kind and one "item" Item per note, with stable IDs. */
export function itemsToDocuments(items, { systemVersion = "1.4.0" } = {}) {
  const docs = [];
  for (const [index, [kind, folderName]] of Object.entries(ITEM_KINDS).entries()) {
    const entries = items.filter(item => item.kind === kind).sort((a, b) => a.name.localeCompare(b.name));
    if (!entries.length) continue;
    const folderId = stableId(`folder:items:${kind}`);
    docs.push({ _id: folderId, _key: `!folders!${folderId}`, name: folderName, type: "Item", folder: null, sorting: "a",
      sort: (index + 1) * 100000, color: null, description: "", flags: {}, _stats: stats(systemVersion) });
    for (const [number, item] of entries.entries()) {
      const id = stableId(`item:${kind}:${item.name}`);
      const flavour = item.description
        ? item.description.split(/\n\s*\n/).map(paragraph => `<p>${escapeHtml(paragraph.trim()).replace(/\n/g, "<br>")}</p>`).join("") : "";
      const facts = `<p><b>Effect:</b> ${escapeHtml(item.effect)}`
        + (item.bonus ? `<br><b>Bonus:</b> ${escapeHtml(item.bonus).replace(/\n/g, ", ")}` : "")
        + (item.cost ? `<br><b>Cost:</b> ${escapeHtml(item.cost)}` : "")
        + (item.price ? `<br><b>Price:</b> ${escapeHtml(item.price)}` : "") + "</p>";
      const passives = Object.fromEntries((item.passives ?? []).filter(passive => passive.stat)
        .map((passive, n) => [`bonus${n + 1}`, { stat: passive.stat, value: passive.value, description: passive.text }]));
      docs.push({ _id: id, _key: `!items!${id}`, name: item.name, type: "item",
        img: item.icon || (kind === "Potion" ? "icons/consumables/potions/bottle-round-corked-red.webp" : "icons/svg/item-bag.svg"),
        system: { description: flavour + facts, passivesEnabled: true, passives, quantity: 1, weight: 0, formula: "",
          effect: item.effect, heal: item.heal, incarna: item.incarna, actions: item.actions, price: item.price },
        effects: [], folder: folderId, sort: (number + 1) * 100000, ownership: { default: 0 }, flags: {}, _stats: stats(systemVersion) });
    }
  }
  return docs;
}
