import { actionById, actionName, actionMatchup, insightModifier } from "../data/actions.mjs";
import { CONTEST_STATS, getContestDefender, getContestDie, renderNewContestBoard, requestDefenderContest, rollBoardSide, showContestDialog, waitForContestAnimations } from "./contest-requests.mjs";
import { activeActionGM, ownsActionActor, requestCombatAction, actionChat } from "./action-effects.mjs";
import { applyDodge, applyActionCondition } from "./conditions.mjs";
import { renderCheckCard, escape } from "./roll-card.mjs";
import { rollUnderSucceeds } from "./spells.mjs";

/** Misc actions affect the actual targeted token actor, including unlinked NPC tokens. */
export function getActionTarget(actor, { enemy = false } = {}) {
  const targets = [...(game.user.targets ?? [])];
  if (targets.length > 1) return { error: game.i18n.localize("INCARNOS.Actions.targetOne") };
  const token = targets[0];
  if (!token?.actor || token.actor.uuid === actor.uuid) return { error: enemy
    ? game.i18n.localize("INCARNOS.Actions.enemy") : game.i18n.localize("INCARNOS.Actions.targetRequired") };
  const disposition = token.document?.disposition;
  const sourceDisposition = actor.token?.disposition ?? actor.getActiveTokens?.()[0]?.document?.disposition ?? (actor.type === "character" ? 1 : null);
  if (enemy && disposition && disposition === sourceDisposition) return { error: game.i18n.localize("INCARNOS.Actions.enemy") };
  return { actor: token.actor };
}

export async function useCombatAction(actor, actionId) {
  const action = actionById(actionId);
  if (!action) return null;
  if (!ownsActionActor(actor, game.user)) return ui.notifications.warn(game.i18n.localize("INCARNOS.Actions.notOwner"));
  if (action.kind === "contest") return startActionContest(actor, action);
  if (action.effect.dodge) {
    await applyDodge(actor);
    return actionChat(actor, action.id, game.i18n.format("INCARNOS.Actions.dodgeCard", { actor: actor.name }));
  }
  let target = null;
  if (action.id === "hinder" || action.effect.insight) {
    target = getActionTarget(actor, { enemy: Boolean(action.effect.insight) });
    if (target.error) return ui.notifications.warn(target.error);
  }
  if (action.id === "hinder") return requestCombatAction({ kind: "hinder", actorUuid: actor.uuid, targetUuid: target.actor.uuid });
  const stat = action.stats[0];
  const base = Number(actor.system.abilities?.[CONTEST_STATS[stat]]?.value);
  if (!Number.isFinite(base)) return ui.notifications.warn(game.i18n.localize("INCARNOS.Actions.invalidStat"));
  const level = target ? target.actor.system.attributes?.level?.value ?? target.actor.system.level?.value ?? target.actor.system.level ?? 1 : 1;
  const modifier = action.effect.insight ? insightModifier(level) : 0;
  const value = base + modifier;
  const roll = await new Roll("1d20", actor.getRollData()).evaluate();
  const success = rollUnderSucceeds(roll.total, value);
  const detail = action.effect.insight
    ? game.i18n.format("INCARNOS.Actions.insightCard", { target: target.actor.name })
    : game.i18n.format("INCARNOS.Actions.hideCard", { actor: actor.name });
  const card = pending => renderCheckCard({
    roller: { name: actor.name, img: actor.img }, kind: "ability", statLabel: stat, title: actionName(action),
    value, d20: roll.total, pending,
    bonus: action.effect.insight ? { value: modifier, source: game.i18n.format("INCARNOS.Actions.insightDifficulty", { level }) } : null,
    notes: !pending && success ? [detail] : []
  });
  const chatData = { speaker: ChatMessage.getSpeaker({ actor }), content: card(true), rolls: [roll.toJSON()], sound: CONFIG.sounds.dice };
  ChatMessage.applyMode(chatData, game.settings.get("core", "rollMode"));
  const message = await ChatMessage.create(chatData);
  if (success && action.effect.condition) await applyActionCondition(actor, action.effect.condition);
  if (message) {
    await waitForContestAnimations([message.id]);
    await message.update({ content: card(false) });
  }
  return message;
}

async function startActionContest(actor, action) {
  const defender = getContestDefender(actor);
  if (defender.error) return ui.notifications.warn(defender.error);
  if (!activeActionGM()) return ui.notifications.warn(game.i18n.localize("INCARNOS.Actions.needGM"));
  let stat = action.stats[0];
  if (action.stats.length > 1) {
    stat = await showContestDialog("prompt", {
      window: { title: game.i18n.format("INCARNOS.Actions.chooseStat", { action: actionName(action) }) },
      content: `<select name="stat">${action.stats.map((stat, index) => `<option value="${stat}"${index ? "" : " selected"}>${escape(stat)}</option>`).join("")}</select>`,
      ok: { label: game.i18n.localize("INCARNOS.Actions.roll"), callback: (event, button) => button.form.elements.stat.value },
      rejectClose: false, modal: true
    });
    if (!action.stats.includes(stat)) return null;
  }
  const value = Number(actor.system.abilities?.[CONTEST_STATS[stat]]?.value);
  const die = getContestDie(value);
  if (!Number.isInteger(die)) return ui.notifications.warn(game.i18n.localize("INCARNOS.Actions.invalidStat"));
  const attacker = { uuid: actor.uuid, name: actor.name, img: actor.img, stat, value, die, role: "attack" };
  const opponent = { uuid: defender.actor.uuid, name: defender.actor.name, img: defender.actor.img };
  const board = await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }), flavor: escape(actionMatchup(action, stat)),
    content: renderNewContestBoard({ stat, attacker, defender: opponent, actionId: action.id }),
    flags: { incarnos: { contestBoard: { round: 1, stat, attacker, defender: opponent, actionId: action.id } } }
  });
  const request = await requestDefenderContest({ attacker: actor, defender, attackMessage: board, stat });
  if (!request) { await board.update({ "flags.incarnos.contestBoard.cancelled": true }); return board; }
  await rollBoardSide(board, attacker);
  return board;
}
