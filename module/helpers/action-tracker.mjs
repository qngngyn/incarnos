/** Incarnos action resource, token segments and end-of-turn replenishment. */
const writes = new WeakMap();
const displays = new WeakMap();
const replenishedTurns = new WeakMap();
const canEdit = actor => Boolean(actor && (game.user.isGM || actor.testUserPermission(game.user, "OWNER")));

export function getActionState(actor) {
  const resource = actor?.system?.actionpoints ?? {};
  const maximum = Number(resource.max ?? 3);
  const max = Number.isFinite(maximum) ? Math.max(0, Math.floor(maximum)) : 3;
  const current = Number(resource.value ?? max);
  return { max, value: Number.isFinite(current) ? Math.min(max, Math.max(0, Math.floor(current))) : max };
}

/** Use token identity so another token of the same actor is not a participant. */
export function tokenParticipatesInCombat(token) {
  const combat = game.combat;
  const document = token?.document ?? token;
  return Boolean(combat?.started && document?.id
    && [...combat.combatants].some(combatant => combatant.tokenId === document.id
      && combatant.sceneId === document.parent?.id));
}

export function actorParticipatesInCombat(actor) {
  return Boolean(game.combat?.started && [...game.combat.combatants].some(combatant =>
    combatant.actor?.uuid === actor?.uuid && actor?.uuid));
}

/** Replace the former default without changing custom pools or item bonuses. */
export async function migrateDefaultActions() {
  const gm = [...game.users].filter(user => user.active && user.isGM).sort((a, b) => a.id.localeCompare(b.id))[0];
  if (gm?.id !== game.user.id) return;
  const actors = new Set([...game.actors]);
  for (const scene of game.scenes) {
    for (const token of scene.tokens) if (!token.actorLink && token.actor) actors.add(token.actor);
  }
  for (const actor of actors) {
    if (!["character", "npc"].includes(actor.type)) continue;
    const resource = actor.toObject().system.actionpoints;
    if (resource?.max != null && Number(resource.max) !== 4) continue;
    const value = Number(resource?.value ?? 3);
    await actor.update({ "system.actionpoints.max": 3,
      "system.actionpoints.value": Number.isFinite(value) ? Math.min(3, Math.max(0, value)) : 3 });
  }
}

export function actionTrackerVisible(token, user = game.user) {
  return Boolean(token.actor && ["character", "npc"].includes(token.actor.type) && token.isVisible
    && tokenParticipatesInCombat(token)
    && (user.isGM || token.actor.testUserPermission(user, "OWNER") || token.hover));
}

/** Serialize quick clicks so two spends cannot overwrite each other. */
export function changeActions(actor, action) {
  if (!canEdit(actor)) return Promise.resolve(false);
  const next = (writes.get(actor) ?? Promise.resolve()).catch(() => {}).then(async () => {
    if (!canEdit(actor)) return false;
    const { value, max } = getActionState(actor);
    const updated = action === "reset" ? max : action === "spend" ? Math.max(0, value - 1)
      : action === "restore" ? Math.min(max, value + 1) : value;
    if (updated !== value || Number(actor.system.actionpoints.value) !== updated) {
      await actor.update({ "system.actionpoints.value": updated });
    }
    return true;
  });
  writes.set(actor, next);
  return next;
}

export function drawActionTracker(token) {
  const previous = displays.get(token);
  const state = getActionState(token.actor);
  const signature = [state.value, state.max, token.w].join(":");
  if (previous && !previous.destroyed && previous.parent === token && previous.incarnosSignature === signature) {
    previous.visible = actionTrackerVisible(token);
    return;
  }
  if (previous && !previous.destroyed) previous.destroy({ children: true });
  displays.delete(token);
  if (!token.actor || !["character", "npc"].includes(token.actor.type) || token.destroyed) return;
  const { value, max } = state;
  if (!max) return;
  const container = new PIXI.Container();
  container.incarnosSignature = signature;
  const width = token.w;
  const gap = Math.max(2, width * 0.025);
  const height = Math.max(6, Math.min(14, width * 0.1));
  // Three columns keep 3, 6 and 9 actions equally legible above the token bars.
  // Large custom pools use a numeric counter rather than a tall stack.
  const count = max <= 9 ? max : 1;
  const rows = Math.ceil(count / 3);
  const columns = Math.min(3, count);
  const segmentWidth = (width - gap * (columns - 1)) / columns;
  container.position.set(0, -(rows * (height + gap)) - gap);
  container.visible = actionTrackerVisible(token);
  // A display-only child preserves normal token dragging and selection.
  container.eventMode = "none";
  for (let i = 0; i < count; i++) {
    const segment = new PIXI.Graphics();
    segment.lineStyle(1, 0x101510, 1).beginFill(i < value ? 0x39d353 : 0x273127, 0.95)
      .drawRoundedRect((i % 3) * (segmentWidth + gap), Math.floor(i / 3) * (height + gap), segmentWidth, height, 2).endFill();
    container.addChild(segment);
  }
  if (max > 9) {
    const label = new PIXI.Text(value + "/" + max, { fontSize: Math.max(10, height), fill: 0xffffff, fontWeight: "bold" });
    label.anchor.set(0.5, 0.5);
    label.position.set(width / 2, height / 2);
    container.addChild(label);
  }
  token.addChild(container);
  displays.set(token, container);
}

function reportActionError(error) {
  console.error("Incarnos action tracker", error);
  ui.notifications.error("Actions could not be updated.");
}

/** HUD columns can extend below the token; clear their actual rendered bounds. */
export function positionActionHUD(root, controls) {
  if (!root.isConnected || !controls.isConnected) return;
  const bounds = root.getBoundingClientRect();
  const scale = root.offsetHeight ? bounds.height / root.offsetHeight : 1;
  if (!bounds.height || !Number.isFinite(scale) || scale <= 0) return;
  let bottom = bounds.bottom;
  for (const element of root.querySelectorAll("*")) {
    if (element === controls || controls.contains(element)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width && rect.height) bottom = Math.max(bottom, rect.bottom);
  }
  controls.style.top = ((bottom - bounds.top) / scale + 12) + "px";
}

export function renderActionHUD(hud, html) {
  const actor = hud.actor;
  if (!canEdit(actor) || !["character", "npc"].includes(actor.type)) return;
  const root = html?.querySelector ? html : html?.[0];
  if (!root) return;
  root.querySelector(".incarnos-actions-hud")?.remove();
  if (!tokenParticipatesInCombat(hud.object)) return;
  const controls = document.createElement("div");
  controls.className = "incarnos-actions-hud";
  // The HUD is outside the system sheet and inherits Foundry's large token-HUD
  // controls. Keep its essential styles with its markup, even if a client has
  // cached the older system CSS or a module supplies stronger HUD selectors.
  Object.assign(controls.style, {
    position: "absolute", top: "calc(100% + 80px)", left: "50%",
    transform: "translateX(-50%)", margin: "0", display: "flex",
    flexDirection: "row", flexWrap: "nowrap", alignItems: "center", gap: "4px",
    padding: "4px 6px", width: "max-content", minWidth: "180px", height: "auto",
    background: "rgba(20, 24, 20, 0.95)", color: "#eee",
    border: "1px solid #566656", borderRadius: "4px", fontSize: "12px",
    lineHeight: "1.2", whiteSpace: "nowrap", pointerEvents: "auto", boxSizing: "border-box"
  });
  const counter = document.createElement("span");
  counter.className = "incarnos-action-count";
  const refresh = () => {
    const { value, max } = getActionState(actor);
    counter.textContent = "Actions " + value + "/" + max;
  };
  refresh();
  controls.append(counter);
  for (const [action, label, title] of [["spend", "-", "Spend one action"], ["restore", "+", "Restore one action"], ["reset", "Reset", "Restore all actions"]]) {
    const button = document.createElement("button");
    button.type = "button";
    Object.assign(button.style, {
      width: "auto", minWidth: "24px", height: "28px", flex: "0 0 auto",
      padding: "2px 6px", margin: "0", fontSize: "inherit", lineHeight: "normal",
      color: "#eee", background: "#273127", border: "1px solid #566656",
      borderRadius: "4px", boxSizing: "border-box"
    });
    button.textContent = label;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      button.disabled = true;
      try { await changeActions(actor, action); refresh(); }
      catch (error) { reportActionError(error); }
      finally { button.disabled = false; }
    });
    controls.append(button);
  }
  root.append(controls);
  // Measure after Foundry has positioned the HUD and laid out its controls.
  requestAnimationFrame(() => positionActionHUD(root, controls));
}

function refreshTrackers() {
  const hud = globalThis.canvas?.tokens?.hud;
  const counter = hud?.element?.querySelector(".incarnos-action-count");
  if (counter && hud.actor) {
    const { value, max } = getActionState(hud.actor);
    counter.textContent = "Actions " + value + "/" + max;
  }
  if (hud?.object && hud.element) renderActionHUD(hud, hud.element);
  for (const token of globalThis.canvas?.tokens?.placeables ?? []) drawActionTracker(token);
}

/** Only one client writes the outgoing combatant's resource after a forward turn. */
export async function replenishEndedTurn(combat, changed, options, userId) {
  if (!("turn" in changed || "round" in changed) || !options.incarnosEndedCombatantId) return;
  const gm = [...game.users].filter(user => user.active && user.isGM).sort((a, b) => a.id.localeCompare(b.id))[0];
  const actor = combat.combatants.get(options.incarnosEndedCombatantId)?.actor;
  if (!actor) return;
  // Without a GM, an online owner must perform the update, even if another
  // player advanced combat. Prefer the initiator when they own this actor.
  const owners = [...game.users].filter(user => user.active && actor.testUserPermission(user, "OWNER"));
  const owner = owners.find(user => user.id === userId) ?? owners.sort((a, b) => a.id.localeCompare(b.id))[0];
  if ((gm?.id ?? owner?.id) !== game.user.id) return;
  await changeActions(actor, "reset");
}

/** React to the committed transition on every client, including direct updates. */
export async function replenishCombatTurn(combat, prior, current) {
  if (!prior || !current || !(prior.round > 0) || prior.turn == null || current.turn == null) return;
  const forward = current.round > prior.round
    || (current.round === prior.round && current.turn > prior.turn);
  if (!forward || !prior.combatantId) return;
  const signature = [prior.round, prior.turn, prior.combatantId,
    current.round, current.turn, current.combatantId].join(":");
  if (replenishedTurns.get(combat) === signature) return;
  replenishedTurns.set(combat, signature);
  try {
    await replenishEndedTurn(combat, { round: current.round, turn: current.turn },
      { incarnosEndedCombatantId: prior.combatantId });
  } catch (error) {
    // Failed writes remain retryable; a stale failure cannot clear a newer turn.
    if (replenishedTurns.get(combat) === signature) replenishedTurns.delete(combat);
    throw error;
  }
}

export function registerActionTrackerHooks() {
  Hooks.on("renderTokenHUD", renderActionHUD);
  Hooks.on("drawToken", drawActionTracker);
  Hooks.on("refreshToken", drawActionTracker);
  Hooks.on("hoverToken", (token, hovered) => {
    const display = displays.get(token);
    if (display) display.visible = Boolean(tokenParticipatesInCombat(token) && token.isVisible && (canEdit(token.actor) || hovered));
  });
  Hooks.on("updateActor", refreshTrackers);
  Hooks.on("updateToken", refreshTrackers);
  Hooks.on("updateUser", refreshTrackers);
  Hooks.on("canvasReady", refreshTrackers);
  const refreshCombatUI = () => {
    refreshTrackers();
    for (const actor of game.actors ?? []) if (actor.sheet?.rendered) actor.sheet.render(false);
    for (const token of globalThis.canvas?.tokens?.placeables ?? []) {
      if (token.actor?.isToken && token.actor.sheet?.rendered) token.actor.sheet.render(false);
    }
  };
  for (const event of ["createCombat", "deleteCombat", "createCombatant", "updateCombatant", "deleteCombatant"]) Hooks.on(event, refreshCombatUI);
  Hooks.once("ready", () => { void migrateDefaultActions().catch(reportActionError); });
  Hooks.on("combatTurnChange", (combat, prior, current) => {
    void replenishCombatTurn(combat, prior, current).catch(reportActionError);
  });
  Hooks.on("updateCombat", () => {
    refreshCombatUI();
  });
}
