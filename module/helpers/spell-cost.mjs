import { inCombat, payActions, refundActions } from "./action-tracker.mjs";
import { formatSpellCost, getVariableCost } from "./spells.mjs";
import { getTalentRules } from "./talents.mjs";
import { escape } from "./roll-card.mjs";

/** Cost to pay: fixed values or a variable-cost prompt. Checks IP; AP is checked when paying. */
export async function getCastCost(item, extraMp = 0, selected = null) {
  const { system, actor } = item;
  // system.mp holds the Incarna (IP) cost; keep this legacy data path for existing spell items.
  let cost = { actions: Number(system.actions ?? 0), mp: Number(system.mp ?? 0) };
  const variable = getVariableCost(system.cost);
  if (variable.actions || variable.mp) {
    const data = selected ?? await foundry.applications.api.DialogV2.input({
      window: { title: `Cast ${item.name}` },
      content: `<p>${escape(formatSpellCost(system.cost))}</p>
        <div class="form-group"><label>Actions</label><input type="number" name="actions" value="${cost.actions}" min="0" step="1"></div>
        <div class="form-group"><label>IP</label><input type="number" name="mp" value="${cost.mp}" min="0" step="1"></div>`,
      ok: { label: "Cast" },
      rejectClose: false
    });
    if (!data) return null;
    cost = { actions: variable.actions ? Math.max(0, Number(data.actions) || 0) : cost.actions, mp: variable.mp ? Math.max(0, Number(data.mp) || 0) : cost.mp };
  }
  cost.mp += extraMp;
  if (![cost.actions, cost.mp].every(value => Number.isSafeInteger(value) && value >= 0)) return null;
  // Abomination: no IP, spells take their IP cost from HP instead.
  const hpMagic = getTalentRules(actor.items).hpMagic;
  const pool = hpMagic ? "HP" : "IP";
  const available = Number((hpMagic ? actor.system.health : actor.system.power)?.value ?? 0);
  if (cost.mp > available) {
    ui.notifications.warn(`Not enough ${hpMagic ? "HP" : "Incarna"}: ${actor.name} has ${available} ${pool}; ${item.name} costs ${cost.mp} ${pool}.`);
    return null;
  }
  if (hpMagic) cost.hp = cost.mp;
  return cost;
}

/** Deduct IP (HP for Abomination) always and AP only during combat, where the action tracker counts them. Returns what was paid. */
export async function spendCastCost(actor, { actions, mp, hp }, label) {
  const paidActions = inCombat(actor) ? await payActions(actor, actions, label) : 0;
  if (paidActions === false) return false;
  const update = {};
  if (hp) update["system.health.value"] = Number(actor.system.health?.value ?? 0) - hp;
  else if (mp) update["system.power.value"] = Number(actor.system.power?.value ?? 0) - mp;
  try {
    if (!foundry.utils.isEmpty(update)) await actor.update(update);
  } catch (error) {
    await refundActions(actor, paidActions);
    throw error;
  }
  return hp ? { mp: 0, hp, actions: paidActions } : { mp, actions: paidActions };
}

export async function refundCastCost(actor, paid) {
  if (paid.hp) await actor.update({ "system.health.value": Number(actor.system.health?.value ?? 0) + paid.hp });
  else if (paid.mp) await actor.update({ "system.power.value": Number(actor.system.power?.value ?? 0) + paid.mp });
  await refundActions(actor, paid.actions);
}

