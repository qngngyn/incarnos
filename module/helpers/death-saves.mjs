/** Hidden saves, GM reminders and the manual Roll / Show tool. */
import { isWriter, markDead, setConditionTokens } from "./conditions.mjs";
import { getActionState } from "./action-tracker.mjs";
import { escape, renderRollCard } from "./roll-card.mjs";
import { deathSaveCharacters, deathSaveResult, deathSaveTally, emptyDeathSaves, healthTransition, unshownDeathSaves } from "./death-save-rules.mjs";

const t = (key, data) => data ? game.i18n.format(`INCARNOS.DeathSave.${key}`, data) : game.i18n.localize(`INCARNOS.DeathSave.${key}`);
const gms = () => [...game.users].filter(user => user.isGM).map(user => user.id);
const activeGM = () => [...game.users].filter(user => user.active && user.isGM).sort((a, b) => a.id.localeCompare(b.id))[0];
const saves = actor => actor.getFlag("incarnos", "deathSaves") ?? emptyDeathSaves();
const queues = new WeakMap();
let dialog;

function queue(actor, task) {
  const next = (queues.get(actor) ?? Promise.resolve()).catch(() => {}).then(task);
  queues.set(actor, next);
  return next;
}

const dead = actor => actor.statuses?.has(globalThis.CONFIG?.specialStatusEffects?.DEFEATED ?? "dead");
export const canDeathSave = actor => actor?.type === "character" && actor.statuses?.has("dying") && !dead(actor);

export async function capDyingActions(actor) {
  if (actor?.type !== "character" || !actor.statuses?.has("dying")) return;
  const value = getActionState(actor).value;
  if (Number(actor.system.actionpoints?.value) > value) await actor.update({ "system.actionpoints.value": value });
}

async function resetOnHeal(actor) {
  await setConditionTokens(actor, "dying", 0);
  await setConditionTokens(actor, "unconscious", 0);
  await actor.setFlag("incarnos", "deathSaves", emptyDeathSaves());
}

/** Called by the elected writer for every HP source; Apply also marks damage at clamped 0 HP. */
export function handleDyingHealth(actor, before, after, options = {}) {
  if (!isWriter(actor) || actor.type !== "character") return Promise.resolve();
  return queue(actor, async () => {
    const transition = healthTransition({ type: actor.type, before, after,
      dying: options.incarnosDyingBefore ?? actor.statuses?.has("dying"), dead: dead(actor),
      bledOut: options.incarnosBledOut, damage: options.incarnosDamage });
    if (transition === "heal") return resetOnHeal(actor);
    if (transition === "failure" && canDeathSave(actor)) return recordSave(actor, null);
    if (transition !== "dying" || Number(actor.system.health?.value) > 0 || dead(actor)) return;
    if (!actor.statuses?.has("dying")) {
      await actor.setFlag("incarnos", "deathSaves", emptyDeathSaves());
      await actor.toggleStatusEffect("dying", { active: true });
    }
    if (!actor.statuses?.has("prone")) await actor.toggleStatusEffect("prone", { active: true });
    await capDyingActions(actor);
  });
}

export function renderDeathSave(data, { publicCard = false } = {}) {
  return renderRollCard({ icon: "fa-dice-d20", title: escape(t("title")), tags: escape(data.actorName),
    facts: escape(`${data.d20 === null ? t("damage") : `d20: ${data.d20}`} · ${t(data.outcome)} · ${deathSaveTally(data)}`),
    notes: [escape(t("tally", { successes: data.successes, failures: data.failures })), ...(data.d20 === 20 ? [escape(t("natural20"))] : [])],
    action: publicCard && data.outcome === "stabilized" && data.d20 !== null
      ? `<button type="button" data-incarnos-unconscious${data.unconscious ? " disabled" : ""}>${escape(t("unconscious"))}</button>` : "" });
}

async function recordSave(actor, d20) {
  const state = saves(actor);
  const result = deathSaveResult(state, d20);
  const data = { ...result, actorUuid: actor.uuid, actorName: actor.name, shown: false };
  await actor.setFlag("incarnos", "deathSaves", { successes: result.successes, failures: result.failures,
    rolls: [...(state.rolls ?? []), data] });
  // No Roll document is broadcast: even dice-animation modules only see the GM whisper.
  const message = await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: renderDeathSave(data),
    whisper: gms(), blind: true, flags: { incarnos: { deathSave: data } } }, { messageMode: "blindroll" });
  if (result.heal) {
    await actor.update({ "system.health.value": 1 }, { incarnosHandledHealth: true });
    await resetOnHeal(actor);
  } else if (result.outcome === "dead") {
    await markDead(actor);
  } else if (result.outcome === "stabilized") await setConditionTokens(actor, "dying", 0);
  return message;
}

/** Shared by the macro and reminder. Only the elected GM mutates saves. */
export async function rollDeathSave(actor) {
  if (!game.user.isGM || !canDeathSave(actor)) return false;
  if (activeGM()?.id !== game.user.id) return requestTool("roll", actor.uuid);
  return queue(actor, async () => {
    if (!canDeathSave(actor)) return false;
    const roll = await new Roll("1d20").evaluate();
    return recordSave(actor, roll.total);
  });
}

export async function remindDeathSave(actor) {
  if (!canDeathSave(actor)) return;
  return ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), whisper: gms(), blind: true,
    content: renderRollCard({ icon: "fa-dice-d20", title: escape(t("reminder", { actor: actor.name })),
      action: `<button type="button" data-incarnos-death-roll>${escape(t("rollHidden"))}</button>` }),
    flags: { incarnos: { deathSaveReminder: actor.uuid } } });
}

const showing = new Set();
export async function showDeathSave(message) {
  if (!game.user.isGM || !message?.flags?.incarnos?.deathSave) return false;
  if (activeGM()?.id !== game.user.id) return requestTool("show", message.id);
  if (showing.has(message.id)) return false;
  showing.add(message.id);
  try {
    const data = message.flags.incarnos.deathSave;
    if (data.shown || message.flags.incarnos.deathSavePublic) return false;
    // A public copy leaves the original hidden roll and its archive private.
    const existing = [...game.messages.values()].find(entry => entry.flags?.incarnos?.deathSavePublic === message.id);
    const shown = existing ?? await ChatMessage.create({ content: renderDeathSave(data, { publicCard: true }),
      whisper: [], blind: false, flags: { incarnos: { deathSavePublic: message.id, deathSave: { ...data, shown: true } } } },
    { messageMode: "public" });
    await message.update({ "flags.incarnos.deathSave.shown": true });
    return shown;
  } finally { showing.delete(message.id); }
}

export async function applyUnconscious(message) {
  if (!game.user.isGM || !message?.flags?.incarnos?.deathSavePublic) return false;
  if (activeGM()?.id !== game.user.id) return requestTool("unconscious", message.id);
  const data = message.flags.incarnos.deathSave;
  const actor = data?.actorUuid ? await fromUuid(data.actorUuid) : null;
  if (!actor) return false;
  return queue(actor, async () => {
    const current = message.flags.incarnos.deathSave;
    if (current.outcome !== "stabilized" || current.d20 === null || current.unconscious || dead(actor)
      || actor.type !== "character" || Number(actor.system.health?.value) > 0 || actor.statuses?.has("dying")) return false;
    await actor.toggleStatusEffect("unconscious", { active: true });
    const updated = { ...current, unconscious: true };
    await message.update({ "flags.incarnos.deathSave": updated, content: renderDeathSave(updated, { publicCard: true }) });
    return true;
  });
}

async function requestTool(action, target) {
  const gm = activeGM();
  if (!game.user.isGM || !gm) return false;
  return ChatMessage.create({ whisper: gms(), blind: true, content: `<p>${escape(t("request"))}</p>`,
    flags: { incarnos: { deathSaveRequest: { action, target } } } });
}

const requests = new Set();
export async function processDeathSaveRequest(message) {
  const data = message.flags?.incarnos?.deathSaveRequest;
  if (!data || activeGM()?.id !== game.user.id || requests.has(message.id) || !message.author?.isGM) return false;
  requests.add(message.id);
  try {
    if (data.action === "roll") return await rollDeathSave(await fromUuid(data.target));
    if (data.action === "show") return await showDeathSave(game.messages.get(data.target));
    if (data.action === "unconscious") return await applyUnconscious(game.messages.get(data.target));
    return false;
  } finally { await message.delete(); requests.delete(message.id); }
}

export const currentDeathSaveCharacters = () => deathSaveCharacters(globalThis.canvas?.scene?.tokens ?? [], game.combat?.combatants ?? []);

function dialogContent(tab) {
  const actors = currentDeathSaveCharacters();
  const results = unshownDeathSaves(game.messages.values());
  return `<nav class="tabs" aria-label="${escape(t("title"))}">${["roll", "show"].map(name =>
    `<button type="button" data-death-tab="${name}" class="${tab === name ? "active" : ""}">${escape(t(name))}</button>`).join("")}</nav>`
    + `<section${tab === "roll" ? "" : " hidden"}><label>${escape(t("character"))}</label><select name="actorUuid">`
    + actors.map(actor => `<option value="${escape(actor.uuid)}"${canDeathSave(actor) ? "" : " disabled"}>`
      + `${escape(actor.name)}${actor.statuses?.has("dying") ? ` — ${escape(t("dying"))}` : ""} · ${escape(t("tally", saves(actor)))}</option>`).join("")
    + `</select><button type="button" data-death-submit="roll"${actors.some(canDeathSave) ? "" : " disabled"}>${escape(t("rollHidden"))}</button>`
    + `${actors.length ? "" : `<p>${escape(t("noCharacters"))}</p>`}</section>`
    + `<section${tab === "show" ? "" : " hidden"}><label>${escape(t("results"))}</label><select name="resultId">`
    + results.map(message => { const data = message.flags.incarnos.deathSave;
      return `<option value="${escape(message.id)}">${escape(`${data.actorName} · ${data.d20 === null ? t("damage") : `d20: ${data.d20}`} · ${t(data.outcome)} · ${deathSaveTally(data)}`)}</option>`;
    }).join("") + `</select><button type="button" data-death-submit="show"${results.length ? "" : " disabled"}>${escape(t("show"))}</button>`
    + `${results.length ? "" : `<p>${escape(t("noResults"))}</p>`}</section>`;
}

/** One persistent ApplicationV2 dialog; refreshed after rolls, shows and scene/combat changes. */
export async function deathSave() {
  if (!game.user.isGM) return ui.notifications.warn(t("gmOnly"));
  if (dialog?.rendered) return dialog.bringToFront();
  let tab = "roll";
  const Dialog = foundry.applications.api.DialogV2;
  dialog = new Dialog({ window: { title: t("title") }, position: { width: 560 },
    content: dialogContent(tab), buttons: [{ action: "close", label: t("close") }] });
  const bind = () => {
    const root = dialog.element;
    for (const button of root.querySelectorAll("[data-death-tab]")) button.addEventListener("click", () => {
      tab = button.dataset.deathTab; refresh();
    });
    for (const button of root.querySelectorAll("[data-death-submit]")) button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        if (button.dataset.deathSubmit === "roll") await rollDeathSave(await fromUuid(root.querySelector('[name="actorUuid"]').value));
        else await showDeathSave(game.messages.get(root.querySelector('[name="resultId"]').value));
      } catch (error) { report(error); }
      finally { refresh(); }
    });
  };
  const refresh = () => {
    const content = dialog?.rendered && dialog.element.querySelector(".dialog-content");
    if (!content) return;
    const selected = [...content.querySelectorAll("select")].map(select => [select.name, select.value]);
    content.innerHTML = dialogContent(tab);
    for (const [name, value] of selected) {
      const select = content.querySelector(`select[name="${name}"]`);
      if ([...select.options].some(option => option.value === value && !option.disabled)) select.value = value;
    }
    bind();
  };
  dialog.addEventListener("render", bind);
  dialog.incarnosRefresh = refresh;
  return dialog.render({ force: true });
}

const report = error => { console.error("Incarnos | death save", error); ui.notifications.error(t("error")); };

export function registerDeathSaveHooks() {
  Hooks.on("renderChatMessageHTML", (message, html) => {
    if (message.flags?.incarnos?.deathSaveRequest) { html.style.display = "none"; return; }
    for (const button of html.querySelectorAll("[data-incarnos-death-roll], [data-incarnos-unconscious]")) {
      if (!game.user.isGM) { button.remove(); continue; }
      const unconscious = button.hasAttribute("data-incarnos-unconscious");
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          if (unconscious) await applyUnconscious(message);
          else await rollDeathSave(await fromUuid(message.flags?.incarnos?.deathSaveReminder));
        } catch (error) { report(error); }
        finally { button.disabled = unconscious && Boolean(message.flags?.incarnos?.deathSave?.unconscious); }
      });
    }
  });
  Hooks.on("createChatMessage", message => { void processDeathSaveRequest(message).catch(report); });
  for (const hook of ["createChatMessage", "updateChatMessage", "deleteChatMessage", "canvasReady", "updateCombat", "createToken", "deleteToken", "updateActor"]) {
    Hooks.on(hook, () => dialog?.incarnosRefresh?.());
  }
  Hooks.on("createActiveEffect", effect => {
    if (effect.statuses?.has("dying") && effect.parent?.type === "character" && isWriter(effect.parent)) {
      void capDyingActions(effect.parent).catch(report);
    }
  });
}
