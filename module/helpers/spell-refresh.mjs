/** Compatibility exports; spell refresh is now the generic, customization-aware item sync. */
import { itemSourceUuid, planItemSync } from "./item-sync.mjs";

export { syncItemsFromCompendiums as refreshSpellsFromCompendium, registerItemSyncHooks as registerSpellRefreshHooks } from "./item-sync.mjs";

export const spellKey = spell => `${String(spell?.system?.element ?? "").trim().toLowerCase()}|${String(spell?.name ?? "").trim().toLowerCase()}`;

/** @deprecated Use planItemSync with an explicit source UUID. */
export function spellUpdate(owned, source) {
  const uuid = itemSourceUuid({ ...owned, type: "spell" }) ?? `Compendium.incarnos.spells.Item.${source._id}`;
  return planItemSync({ ...owned, type: "spell" }, source, uuid).update;
}
