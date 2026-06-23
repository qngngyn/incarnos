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
 * @return {object}                                           Data for rendering
 */
export function prepareActiveEffectCategories(effects) {
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
    if (effect.disabled) categories.inactive.effects.push(effect);
    else if (effect.isTemporary) categories.temporary.effects.push(effect);
    else categories.passive.effects.push(effect);
  }

  return categories;
}
