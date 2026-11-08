/**
 * Item lists on the actor sheet: their order (the Item `sort` the owner sets by drag-and-drop) and the full text
 * shown under a row when its name is clicked.
 */
import { getTalentSummary } from "./talents.mjs";

const escape = text => String(text ?? "").replace(/[&<>"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);

/** Items in the order their owner sorted them (Item `sort`); unsorted ties keep their current order. */
export const sortItems = (items = []) => [...items].sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0));

/**
 * What the row's summary shows, by item type.
 * @param {Item|object} item
 * @param {{spellContent?: Function}} [helpers]  getSpellChatContent (the spell card body: tags, summary, effect, flavour).
 * @returns {{html: string, description: string}}  `html` is ready to show; `description` still needs enriching.
 */
export function itemSummaryParts(item, { spellContent } = {}) {
  const system = item?.system ?? {};
  switch (item?.type) {
    case "spell":
      return { html: spellContent ? spellContent(system) : "", description: "" };
    case "weapon": {
      const facts = [system.attackMode === "ranged" ? `Ranged${system.range ? ` (${system.range})` : ""}` : `Melee${system.range ? ` (reach ${system.range})` : ""}`,
        `${system.hands ?? 1} ${Number(system.hands) === 2 ? "hands" : "hand"}`,
        system.damage ? `Damage ${system.damage}` : ""].filter(Boolean).map(escape).join(" · ");
      const traits = String(system.traits ?? "").split("\n").map(line => line.trim()).filter(Boolean).map(line => {
        const colon = line.indexOf(":");
        return colon > 0 ? `<li><strong>${escape(line.slice(0, colon))}:</strong> ${escape(line.slice(colon + 1).trim())}</li>` : `<li>${escape(line)}</li>`;
      });
      return { html: `<p class="item-summary-facts">${facts}</p>${traits.length ? `<ul class="item-summary-traits">${traits.join("")}</ul>` : ""}`,
        description: String(system.description ?? "") };
    }
    case "feature":
    case "race":
      // Bonus lines (escaped) and the description, as on the talent column, but in full.
      return { html: "", description: getTalentSummary(system) };
    default:
      return { html: "", description: String(system.description ?? "") };
  }
}
