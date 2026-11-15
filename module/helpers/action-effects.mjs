import { actionById } from "../data/actions.mjs";
import { applyActionCondition, conditionById } from "./conditions.mjs";
import { escape, renderRollCard } from "./roll-card.mjs";

export const activeActionGM = () => [...game.users].filter(user => user.active && user.isGM).sort((a, b) => a.id.localeCompare(b.id))[0];
export const ownsActionActor = (actor, user) => Boolean(actor && user && (user.isGM || actor.testUserPermission(user, "OWNER")));
const inFlight = new Set();
const text = (key, data) => game.i18n.format(`INCARNOS.Actions.${key}`, data);

/** Only the elected GM applies a winning board; claim it before changing the actor, including across reloads. */
export async function applyContestAction(board, choice = null) {
  const data = board?.flags?.incarnos?.contestBoard;
  const outcome = board?.flags?.incarnos?.contestOutcome;
  const action = actionById(data?.actionId);
  if (activeActionGM()?.id !== game.user.id || !action?.saves || data.cancelled || data.applied
    || outcome?.winner !== "attack" || !(outcome.attackTotal < outcome.saveTotal) || inFlight.has(board.id)) return false;
  if (action.effect.choice && !["prone", "push"].includes(choice)) return false;
  if (!action.effect.choice && choice) return false;
  inFlight.add(board.id);
  try {
    const attacker = await fromUuid(data.attacker?.uuid);
    const defender = await fromUuid(data.defender?.uuid);
    if (!attacker || !defender || attacker.uuid === defender.uuid || !ownsActionActor(attacker, board.author)) return false;
    const actor = action.effect.self ? attacker : defender;
    const id = action.effect.choice ? "prone" : action.effect.condition;
    const appliedText = choice === "push" ? text("pushedManual", { target: actor.name })
      : text(action.effect.remove ? "removed" : "applied", { effect: conditionById(id)?.name ?? id, target: actor.name });
    await board.update({ "flags.incarnos.contestBoard.applied": true,
      "flags.incarnos.contestBoard.choice": choice, "flags.incarnos.contestBoard.appliedText": appliedText });
    try {
      if (choice !== "push") {
        if (action.effect.remove) await actor.toggleStatusEffect(id, { active: false });
        else await applyActionCondition(actor, id, action.effect);
      }
    } catch (error) {
      await board.update({ "flags.incarnos.contestBoard.applied": false, "flags.incarnos.contestBoard.appliedText": "" });
      throw error;
    }
    return true;
  } finally { inFlight.delete(board.id); }
}

export function actionChat(actor, action, detail) {
  return ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }),
    content: renderRollCard({ icon: "fa-person-running", title: escape(game.i18n.localize(`INCARNOS.Actions.${action}`)),
      rows: [{ name: actor.name, img: actor.img, detail }] }) });
}

/** Requests carry document/action references only. Identity always comes from the ChatMessage author. */
export async function requestCombatAction(data) {
  const gm = activeActionGM();
  if (!gm) { ui.notifications.warn(game.i18n.localize("INCARNOS.Actions.needGM")); return null; }
  const message = await ChatMessage.create({
    whisper: [...new Set([gm.id, game.user.id])], content: `<p>${escape(game.i18n.localize("INCARNOS.Actions.request"))}</p>`,
    flags: { incarnos: { actionRequest: data } }
  });
  if (gm.id === game.user.id) await processCombatActionRequest(message, game.user.id);
  return message;
}

/** The elected GM validates the authenticated author, source ownership, action, target and one-use state. */
export async function processCombatActionRequest(message, userId) {
  const data = message?.flags?.incarnos?.actionRequest;
  if (!data || activeActionGM()?.id !== game.user.id || inFlight.has(message.id)) return false;
  inFlight.add(message.id);
  try {
    const user = game.users.get(userId);
    if (!user || message.author?.id !== userId || data.handled) return false;
    if (data.kind === "hinder") {
      const actor = await fromUuid(data.actorUuid);
      const target = await fromUuid(data.targetUuid);
      if (!ownsActionActor(actor, user) || !["character", "npc"].includes(actor.type)
        || target?.documentName !== "Actor" || actor.uuid === target.uuid) return false;
      await message.update({ "flags.incarnos.actionRequest.handled": true });
      await applyActionCondition(target, "hindered");
      await actionChat(actor, "hinder", text("hinderCard", { actor: actor.name, target: target.name }));
      return true;
    }
    if (data.kind === "shove" && ["prone", "push"].includes(data.choice)) {
      const board = game.messages.get(data.boardId);
      const contest = board?.flags?.incarnos?.contestBoard;
      if (contest?.actionId !== "shove") return false;
      const actor = await fromUuid(contest.attacker?.uuid);
      if (!ownsActionActor(actor, user)) return false;
      await message.update({ "flags.incarnos.actionRequest.handled": true });
      return await applyContestAction(board, data.choice);
    }
    return false;
  } catch (error) {
    console.error("Incarnos action request failed", error);
    return false;
  } finally {
    inFlight.delete(message.id);
    await message.delete();
  }
}

export function registerCombatActionHooks() {
  Hooks.on("renderChatMessageHTML", (message, html) => {
    if (message.flags?.incarnos?.actionRequest) { html.style.display = "none"; return; }
    const data = message.flags?.incarnos?.contestBoard;
    for (const button of html.querySelectorAll?.("[data-incarnos-shove]") ?? []) {
      button.style.display = "none";
      if (data?.actionId !== "shove" || data.applied || data.cancelled || message.flags.incarnos.contestOutcome?.winner !== "attack") { button.remove(); continue; }
      fromUuid(data.attacker?.uuid).then(actor => {
        if (!ownsActionActor(actor, game.user)) return button.remove();
        button.style.display = "";
        button.addEventListener("click", async () => {
          button.disabled = true;
          try { await requestCombatAction({ kind: "shove", boardId: message.id, choice: button.dataset.incarnosShove }); }
          finally { button.disabled = false; }
        });
      }).catch(() => button.remove());
    }
  });
  Hooks.on("createChatMessage", (message, options, userId) => { void processCombatActionRequest(message, userId); });
  Hooks.once("ready", async () => {
    if (activeActionGM()?.id !== game.user.id) return;
    for (const message of [...game.messages.values()]) {
      if (message.flags?.incarnos?.actionRequest && Date.now() - message.timestamp < 12 * 60 * 60 * 1000) {
        await processCombatActionRequest(message, message.author?.id);
      }
    }
  });
}
