/** Manual critical failure prompts. One GM writes each draw; requests use server-authored chat documents. */
import { escape, renderRollCard } from "./roll-card.mjs";
import { criticalFailureSeverity, criticalFailureTableName } from "./critical-failure-rules.mjs";

const dataOf = message => message?.flags?.incarnos?.criticalFailure;
const promptOf = message => message?.flags?.incarnos?.criticalFailurePrompt;
const activeGM = () => [...game.users].filter(user => user.active && user.isGM).sort((a, b) => a.id.localeCompare(b.id))[0];
const busy = new Set();
const severityBusy = new Set();
const t = (key, data) => data ? game.i18n.format(`INCARNOS.CriticalFailure.${key}`, data) : game.i18n.localize(`INCARNOS.CriticalFailure.${key}`);
const kindLabel = kind => t(kind === "spell" ? "spell" : "weapon");
const severityFor = promptId => [...game.messages.values()].find(message => dataOf(message)?.promptId === promptId);
const canRollPrompt = (actor, user, data) => canRollCriticalFailure(actor, user, data) && (user.isGM || data.userId === user.id);

export const criticalFailureOwner = actor => [...game.users].filter(user => user.active && !user.isGM
  && actor.testUserPermission(user, "OWNER")).sort((a, b) => Number(b.character?.uuid === actor.uuid)
    - Number(a.character?.uuid === actor.uuid) || a.id.localeCompare(b.id))[0];

export const canRollCriticalFailure = (actor, user, data) => Boolean(actor && user && data?.state === "pending"
  && (user.isGM || actor.testUserPermission(user, "OWNER")));

/** Safe, small subset of markdown for the vault's text results. No executable HTML from flags. */
const resultHTML = text => escape(text).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  .replace(/\*([^*]+)\*/g, "<em>$1</em>").replace(/\n/g, "<br>");

export function renderCriticalFailure(data) {
  const severity = criticalFailureSeverity(data.d10);
  if (!severity) throw new Error("Invalid critical failure severity");
  return renderRollCard({
    icon: "fa-dice-d20", title: escape(t("title")), tags: escape(`${data.actorName} · ${kindLabel(data.kind)}`),
    chip: `<span class="isc-chip" style="color:${severity.color};border-color:${severity.color}">${escape(`${severity.name} (${severity.chance} %)` )}</span>`,
    facts: `d10: ${data.d10}`,
    notes: data.result ? [`<span>${resultHTML(data.result)}</span>`] : [],
    action: `<button type="button" class="isc-critical-failure" data-incarnos-critical-draw${data.state !== "pending" ? " disabled" : ""}>`
      + `<i class="fas fa-dice"></i> ${escape(t(data.state === "done" ? "rolled" : data.state === "rolling" ? "rolling" : "draw"))}</button>`
  });
}

export function renderCriticalFailurePrompt(data) {
  const player = [...game.users].find(user => user.id === data.userId);
  return renderRollCard({
    icon: "fa-dice-d20", title: escape(t("title")),
    notes: [escape(t("prompt", { actor: data.actorName, kind: kindLabel(data.kind), player: player?.name ?? data.userId }))],
    action: `<button type="button" class="isc-critical-failure"${data.state === "pending" ? " data-incarnos-critical-prompt" : " disabled"}>`
      + `<i class="fas fa-dice"></i> ${escape(t(data.state === "pending" ? "severity" : "rolled"))}</button>`
  });
}

/** Always opens a dialog; no attack hook ever calls this automatically. */
export async function criticalFailure({ kind = "weapon", actor } = {}) {
  if (!["weapon", "spell"].includes(kind)) throw new Error("Invalid critical failure kind");
  actor ??= globalThis.canvas?.tokens?.controlled?.[0]?.actor;
  const actors = actor ? [actor] : [...game.actors].filter(candidate => candidate.type === "character"
    && (game.user.isGM || candidate.testUserPermission(game.user, "OWNER")));
  if (!actors.length) return ui.notifications.warn(t("noActor"));
  const choice = await foundry.applications.api.DialogV2.prompt({
    window: { title: t("title") }, position: { width: 360 }, rejectClose: false,
    content: `<div class="form-group"><label>${escape(t("actor"))}</label><select name="actor">`
      + actors.map(candidate => `<option value="${escape(candidate.uuid)}">${escape(candidate.name)}</option>`).join("") + "</select></div>"
      + `<div class="form-group"><label>${escape(t("kind"))}</label><select name="kind">`
      + ["weapon", "spell"].map(value => `<option value="${value}"${value === kind ? " selected" : ""}>${escape(kindLabel(value))}</option>`).join("") + "</select></div>",
    ok: { label: t("severity"), callback: (event, button) => ({
      actor: actors.find(candidate => candidate.uuid === button.form.elements.actor.value), kind: button.form.elements.kind.value
    }) }
  });
  if (!choice) return;
  actor = choice.actor;
  if (!canRollCriticalFailure(actor, game.user, { state: "pending" })) return ui.notifications.warn(t("notOwner"));
  criticalFailureTableName("small", choice.kind); // Validate the chosen kind before rolling.
  const player = game.user.isGM ? criticalFailureOwner(actor) : null;
  if (!player) return rollCriticalFailureSeverity(actor, choice.kind);
  const data = { actorUuid: actor.uuid, actorName: actor.name, kind: choice.kind, userId: player.id, state: "pending" };
  const message = await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }), content: renderCriticalFailurePrompt(data), whisper: [player.id, game.user.id],
    flags: { incarnos: { criticalFailurePrompt: data } }
  });
  ui.notifications.info(t("asked", { player: player.name }));
  return message;
}

/** The dialog and persisted button share a guard; closing the dialog leaves the whisper usable. */
export async function rollCriticalFailureSeverity(actor, kind, promptId) {
  criticalFailureTableName("small", kind);
  if (!canRollCriticalFailure(actor, game.user, { state: "pending" })) return false;
  const validPrompt = () => {
    const data = promptOf(game.messages.get(promptId));
    return canRollPrompt(actor, game.user, data) && data.actorUuid === actor.uuid && data.kind === kind && !severityFor(promptId);
  };
  if (promptId && (severityBusy.has(promptId) || !validPrompt())) return false;
  if (promptId) severityBusy.add(promptId);
  try {
    const roll = await new Roll("1d10").evaluate();
    if (promptId && !validPrompt()) return false;
    const data = { actorUuid: actor.uuid, actorName: actor.name, kind, d10: roll.total, state: "pending", ...(promptId ? { promptId } : {}) };
    return await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }), content: renderCriticalFailure(data), rolls: [roll.toJSON()],
      sound: CONFIG.sounds.dice, flags: { incarnos: { criticalFailure: data } }
    }, { messageMode: "public" });
  } finally {
    if (promptId) severityBusy.delete(promptId);
  }
}

export async function promptCriticalFailureSeverity(message) {
  const data = promptOf(message);
  if (data?.state !== "pending" || data.userId !== game.user.id || severityFor(message.id)) return false;
  const actor = await fromUuid(data.actorUuid);
  if (!canRollPrompt(actor, game.user, data)) return false;
  return foundry.applications.api.DialogV2.prompt({
    window: { title: t("title") }, position: { width: 360 }, rejectClose: false,
    content: `<p>${escape(t("promptDialog", { kind: kindLabel(data.kind) }))}</p>`,
    ok: { label: t("severity"), callback: () => rollCriticalFailureSeverity(actor, data.kind, message.id) }
  });
}

/** Players post their own severity card; only the elected GM updates the original whisper. */
export async function settleCriticalFailurePrompt(message) {
  if (activeGM()?.id !== game.user.id) return false;
  const severity = dataOf(message);
  const prompt = severity?.promptId ? game.messages.get(severity.promptId) : null;
  const data = promptOf(prompt);
  if (data?.state !== "pending" || data.actorUuid !== severity.actorUuid || data.kind !== severity.kind
    || !criticalFailureSeverity(severity.d10) || !(message.author?.isGM || message.author?.id === data.userId)) return false;
  const done = { ...data, state: "done" };
  await prompt.update({ "flags.incarnos.criticalFailurePrompt": done, content: renderCriticalFailurePrompt(done) });
  return true;
}

/** Only the elected writer may draw. The persisted reservation survives reloads and concurrent clicks. */
export async function resolveCriticalFailure(message, user) {
  const gm = activeGM();
  if (gm ? gm.id !== game.user.id : message?.author?.id !== game.user.id) return false;
  if (!message || busy.has(message.id)) return false;
  busy.add(message.id);
  try {
    const data = dataOf(message);
    const actor = data?.actorUuid ? await fromUuid(data.actorUuid) : null;
    if (!canRollCriticalFailure(actor, user, data)) return false;
    const severity = criticalFailureSeverity(data.d10);
    if (!severity) return false;
    const name = criticalFailureTableName(severity.id, data.kind);
    const pack = game.packs.get("incarnos.critical-failures");
    if (!pack) throw new Error(t("missingPack"));
    const index = await pack.getIndex();
    const entry = index.find(entry => entry.name === name);
    if (!entry) throw new Error(`${t("missingPack")}: ${name}`);
    const table = await pack.getDocument(entry._id);
    // Recheck after asynchronous lookups in case GM leadership or the persisted state changed.
    if (activeGM()?.id !== gm?.id || dataOf(message)?.state !== "pending") return false;
    const reserved = { ...data, state: "rolling" };
    await message.update({ "flags.incarnos.criticalFailure": reserved, content: renderCriticalFailure(reserved) });
    const draw = await table.draw({ displayChat: false, recursive: false });
    if (draw.results.length !== 1) throw new Error("Expected one critical failure result");
    const done = { ...reserved, state: "done", result: draw.results[0].description, tableUuid: table.uuid };
    await message.update({
      "flags.incarnos.criticalFailure": done, content: renderCriticalFailure(done),
      rolls: [...message.rolls.map(roll => roll.toJSON()), draw.roll.toJSON()]
    });
    return true;
  } finally {
    busy.delete(message.id);
  }
}

/** A player's request cannot impersonate another user: Foundry supplies request.author. */
export async function processCriticalFailureRequest(request) {
  if (activeGM()?.id !== game.user.id) return false;
  const id = request.flags?.incarnos?.criticalFailureRequest?.messageId;
  const user = request.author;
  if (!id || !user) return false;
  return resolveCriticalFailure(game.messages.get(id), user);
}

export async function requestCriticalFailureDraw(message) {
  const data = dataOf(message);
  const actor = data?.actorUuid ? await fromUuid(data.actorUuid) : null;
  if (!canRollCriticalFailure(actor, game.user, data)) return false;
  const gm = activeGM();
  if (gm?.id === game.user.id || (!gm && message.author?.id === game.user.id)) return resolveCriticalFailure(message, game.user);
  if (!gm) { ui.notifications.warn(t("needGM")); return false; }
  await ChatMessage.create({
    content: `<p>${escape(t("request"))}</p>`, whisper: [gm.id, game.user.id],
    flags: { incarnos: { criticalFailureRequest: { messageId: message.id } } }
  });
  return true;
}

/** Wire persisted table buttons and explicitly marked natural-20 attack buttons on every render. */
export async function bindCriticalFailureButtons(message, html) {
  if (message.flags?.incarnos?.criticalFailureRequest) { html.style.display = "none"; return; }
  for (const button of html.querySelectorAll("[data-incarnos-critical-draw], [data-incarnos-critical-start], [data-incarnos-critical-prompt]")) {
    button.disabled = true;
    const start = button.hasAttribute("data-incarnos-critical-start");
    const prompt = button.hasAttribute("data-incarnos-critical-prompt");
    const data = prompt ? promptOf(message) : start ? message.flags?.incarnos?.criticalFailureAttack : dataOf(message);
    const actor = data?.actorUuid ? await fromUuid(data.actorUuid) : null;
    const allowed = prompt ? canRollPrompt(actor, game.user, data) && !severityFor(message.id)
      : canRollCriticalFailure(actor, game.user, start ? { state: "pending" } : data);
    if (!allowed) { if (prompt || start || data?.state === "pending") button.remove(); continue; }
    button.disabled = false;
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        if (prompt) await rollCriticalFailureSeverity(actor, data.kind, message.id);
        else if (start) await criticalFailure({ kind: data.kind, actor });
        else await requestCriticalFailureDraw(message);
      } catch (error) {
        console.error("Incarnos | critical failure", error);
        ui.notifications.error(error.message);
      } finally {
        button.disabled = prompt ? promptOf(message)?.state !== "pending" || Boolean(severityFor(message.id))
          : !start && dataOf(message)?.state !== "pending";
      }
    });
  }
}

export function registerCriticalFailureHooks() {
  const report = error => { console.error("Incarnos | critical failure", error); ui.notifications.error(error.message); };
  Hooks.on("renderChatMessageHTML", (message, html) => { void bindCriticalFailureButtons(message, html).catch(report); });
  Hooks.on("createChatMessage", message => {
    void promptCriticalFailureSeverity(message).catch(report);
    void settleCriticalFailurePrompt(message).catch(report);
    void processCriticalFailureRequest(message).catch(report);
  });
  Hooks.once("ready", async () => {
    for (const message of game.messages.values()) {
      await settleCriticalFailurePrompt(message).catch(report);
      await processCriticalFailureRequest(message).catch(report);
    }
  });
}
