/**
 * Potions (vault notes "Typ: Potion" in Welten/Incarnos/Listen/Shop): an "item" whose Effect heals HP and/or restores IP.
 * Drinking one is the Use Object action (1 AP by default): roll, apply to the drinker, use up one potion.
 */

/** Read the formulas out of an Effect line: "Heals 2d8 + 2 HP", "Restores 3d6 IP" (both may appear). */
export function parsePotionEffect(effect = "") {
  const text = String(effect ?? "");
  const formula = pattern => text.match(pattern)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
  return {
    heal: formula(/\bheals?\s+([\dd+\-*()\s]+?)\s*(?:HP|health)\b/i),
    incarna: formula(/\b(?:restores?|regains?|recovers?)\s+([\dd+\-*()\s]+?)\s*(?:IP|incarna)\b/i)
  };
}

/** Action cost from a Cost line ("1 Action (Use Object)", "2 AP"); a potion without one costs 1 (Use Object). */
export function parsePotionActions(cost = "") {
  const match = String(cost ?? "").match(/(\d+)\s*(?:actions?|AP)\b/i);
  return match ? Number(match[1]) : 1;
}

/** Whether an item is a drinkable potion (something to heal or restore). */
export const isPotion = item => item?.type === "item" && Boolean(item.system?.heal || item.system?.incarna);

/** IP after restoring: capped at the maximum. */
export const restoredPower = (power = {}, amount = 0) =>
  Math.min(Number(power.max ?? Infinity), Number(power.value ?? 0) + Math.max(0, Number(amount) || 0));

/**
 * Drink a potion: pay its actions (in combat), roll heal / IP, apply them to the drinker, use up one, post a card.
 * @returns {Promise<object|null>} the chat message, or null when nothing happened
 */
export async function drinkPotion(item, { payActions, applyHealthChange, renderRollCard, escape }) {
  const actor = item.actor;
  if (!actor) { ui.notifications.warn(`${item.name}: drag it onto a character to drink it.`); return null; }
  const quantity = Number(item.system.quantity ?? 1);
  if (quantity <= 0) { ui.notifications.warn(`${actor.name} has no ${item.name} left.`); return null; }
  for (const formula of [item.system.heal, item.system.incarna].filter(Boolean)) {
    if (!Roll.validate(formula)) { ui.notifications.warn(`${item.name}: "${formula}" is not a valid roll formula.`); return null; }
  }
  const actions = Number.isInteger(Number(item.system.actions)) ? Number(item.system.actions) : 1;
  if (await payActions(actor, actions, item.name) === false) return null;

  const rolls = [];
  const rows = [];
  if (item.system.heal) {
    const roll = await new Roll(item.system.heal).evaluate();
    rolls.push(roll);
    await applyHealthChange(actor, `potion-${item.id}-${foundry.utils.randomID()}`, "heal", roll.total);
    rows.push(`<p>Heals <b>${roll.total}</b> HP <small>(${escape(roll.formula)}: ${escape(roll.result)})</small></p>`);
  }
  if (item.system.incarna) {
    const roll = await new Roll(item.system.incarna).evaluate();
    rolls.push(roll);
    const before = Number(actor.system.power?.value ?? 0);
    const after = restoredPower(actor.system.power, roll.total);
    await actor.update({ "system.power.value": after });
    rows.push(`<p>Restores <b>${roll.total}</b> IP <small>(${escape(roll.formula)}: ${escape(roll.result)})</small>`
      + (after - before < roll.total ? ` · ${after - before} up to the maximum` : "") + "</p>");
  }
  // One potion is used up; the last one leaves the inventory.
  if (quantity <= 1) await item.delete();
  else await item.update({ "system.quantity": quantity - 1 });

  const left = Math.max(0, quantity - 1);
  const content = renderRollCard({ img: item.img, title: escape(item.name), tags: "Potion",
    facts: escape(`${actor.name} drinks it · ${left} left`),
    notes: rows });
  const chatData = { speaker: ChatMessage.getSpeaker({ actor }), content, rolls: rolls.map(roll => roll.toJSON()), sound: CONFIG.sounds.dice };
  ChatMessage.applyMode(chatData, game.settings.get("core", "messageMode"));
  return ChatMessage.create(chatData);
}
