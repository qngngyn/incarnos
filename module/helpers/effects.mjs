import { CONDITIONS } from "../data/conditions.mjs";
import { PASSIVE_STATS, getItemPassiveEntries } from "./passives.mjs";
import { BONUS_ITEM_TYPES, shortRule, talentRulePassives } from "./talents.mjs";

/** An effect's description, cut to its gist for the tooltip; status conditions without one use their rule from the vault. */
export function effectDescription(effect) {
  const own = String(effect?.description ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  if (own) return shortRule(own);
  return [...(effect?.statuses ?? [])].map(id => shortRule(CONDITIONS.find(condition => condition.id === id)?.description)).filter(Boolean).join(" · ");
}

/**
 * Manage Active Effect instances through the Actor Sheet via effect control buttons.
 * @param {MouseEvent|PointerEvent} event      The click event on the effect control
 * @param {Actor|Item} owner                   The owning document which manages this effect
 * @param {HTMLElement} [target]               The clicked control element
 */
export function onManageActiveEffect(event, owner, target) {
  event.preventDefault();

  const control = target ?? event.currentTarget;
  const li = control.closest("li");
  const effect = li?.dataset.effectId ? owner.effects.get(li.dataset.effectId) : null;
  const action = control.dataset.effectAction ?? control.dataset.action;

  switch (action) {
    case "create":
      return owner.createEmbeddedDocuments("ActiveEffect", [{
        name: "New Effect",
        icon: "icons/svg/aura.svg",
        origin: owner.uuid,
        duration: {
          rounds: li?.dataset.effectType === "temporary" ? 1 : undefined
        },
        disabled: li?.dataset.effectType === "inactive"
      }]);

    case "edit":
      return effect?.sheet.render({ force: true });

    case "delete":
      return effect?.delete();

    case "toggle":
      return effect?.update({ disabled: !effect.disabled });
  }
}

/**
 * Prepare the data structure for Active Effects which are currently applied to an Actor or Item.
 * @param {Collection<ActiveEffect>|ActiveEffect[]} effects    The Active Effect instances to prepare sheet data for
 * @param {Collection<Item>|Item[]} [items]                    Owned items with passive modifiers
 * @return {object}                                           Data for rendering
 */
export function prepareActiveEffectCategories(effects, items = []) {
  const categories = {
    temporary: {
      type: "temporary",
      label: "Temporary Effects",
      effects: []
    },
    passive: {
      type: "passive",
      label: "Passive Effects",
      effects: []
    },
    inactive: {
      type: "inactive",
      label: "Inactive Effects",
      effects: []
    }
  };

  for (const effect of effects) {
    // Plain row data, with the effect's description (or its condition's rule text) shown under the name.
    const row = {
      id: effect.id, name: effect.name, icon: effect.img ?? effect.icon, disabled: effect.disabled,
      duration: { label: effect.duration?.label ?? "" }, descriptionText: effectDescription(effect)
    };
    if (effect.disabled) categories.inactive.effects.push(row);
    else if (effect.isTemporary) categories.temporary.effects.push(row);
    else categories.passive.effects.push(row);
  }

  // Item passives are display entries only; their modifiers are applied by the Actor.
  // One row per item: its flat stat passives, plus for talents and races every other rule of the Bonus
  // (applied by Foundry or used at the table), so anything that changes stats or behaviour shows up here.
  for (const item of items) {
    const passives = getItemPassiveEntries([item]);
    const rules = BONUS_ITEM_TYPES.includes(item.type) ? talentRulePassives(item.system?.bonus) : [];
    if (!passives.length && !rules.length) continue;
    // Tooltip only, as short as possible: "+1 Dexterity", "Movement ×2". A hand-written passive note is kept in brackets
    // unless it just repeats the number ("+1 Dexterity" from the importer).
    const lines = [
      ...passives.map(passive => {
        const stat = `${passive.value < 0 ? "" : "+"}${passive.value} ${PASSIVE_STATS[passive.stat]}`;
        const note = passive.description && !/^[+-]?\d/.test(passive.description.trim()) ? ` (${shortRule(passive.description, 40)})` : "";
        return stat + note;
      }),
      ...rules.map(rule => rule.label)
    ];
    const effect = {
      isItemPassive: true,
      itemId: item.id,
      name: item.name,
      icon: passives[0]?.img ?? item.img ?? "icons/svg/aura.svg",
      sourceName: item.name,
      sourceLabel: { race: "Race", feature: "Talent" }[item.type] ?? "Item",
      // Flat stat passives can be switched off on the item; the Bonus rules always apply.
      disabled: passives.length ? !passives[0].active && !rules.length : false,
      duration: { label: "Permanent" },
      description: lines.join(" · ")
    };
    categories[effect.disabled ? "inactive" : "passive"].effects.push(effect);
  }

  return categories;
}
