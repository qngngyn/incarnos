/** Incarnos action resource, token segments and end-of-turn replenishment. */
const writes = new WeakMap();
const displays = new WeakMap();
const tokenControls = new Map();
const ACTION_HUD_STYLE = {
  display: "flex", flexDirection: "row", flexWrap: "nowrap", alignItems: "center",
  justifyContent: "center", gap: "3px", margin: "0", padding: "2px 4px",
  width: "max-content", minWidth: "0", height: "auto",
  background: "rgba(20, 24, 20, 0.95)", color: "#eee",
  border: "1px solid #566656", borderRadius: "4px", fontSize: "10px",
  lineHeight: "1.2", whiteSpace: "nowrap", pointerEvents: "auto", boxSizing: "border-box"
};
const ACTION_BUTTON_STYLE = {
  width: "auto", minWidth: "18px", height: "20px", flex: "0 0 auto",
  padding: "0 4px", margin: "0", fontSize: "inherit", lineHeight: "normal",
  color: "#eee", background: "#273127", border: "1px solid #566656",
  borderRadius: "4px", boxSizing: "border-box"
};

const replenishedTurns = new WeakMap();
const canEdit = actor => Boolean(actor && (game.user.isGM || actor.testUserPermission(game.user, "OWNER")));

export function getActionState(actor) {
  const resource = actor?.system?.actionpoints ?? {};
  const maximum = Number(resource.max ?? 3);
  const max = Number.isFinite(maximum) ? Math.max(0, Math.floor(maximum)) : 3;
  const current = Number(resource.value ?? max);
  return { max, value: Number.isFinite(current) ? Math.min(max, Math.max(0, Math.floor(current))) : max };
}

/** Any started encounter counts, even when game.combat points at an empty one. */
export function inCombat(actor) {
  return Boolean(actor?.uuid && game.combats?.some(combat => combat.started
    && combat.combatants.some(combatant => combatant.actor?.uuid === actor.uuid)));
}

/** Share the tracker write queue with automatic payments and turn replenishment. */
function queueActions(actor, task) {
  if (!canEdit(actor)) return Promise.resolve(false);
  const next = (writes.get(actor) ?? Promise.resolve()).catch(() => {}).then(() => canEdit(actor) ? task() : false);
  writes.set(actor, next);
  return next;
}

/**
 * Pay only in a started combat this actor participates in. Strict false blocks the action;
 * 0 is a successful free action. A GM override spends the remaining AP, stopping at zero.
 */
export function payActions(actor, count, label) {
  if (!inCombat(actor) || count === 0) return Promise.resolve(0);
  if (!Number.isInteger(count) || count < 0) return Promise.resolve(false);
  return queueActions(actor, async () => {
    if (!inCombat(actor)) return 0;
    const { value } = getActionState(actor);
    if (count > value) {
      const warning = game.i18n.format("INCARNOS.Actions.insufficient", { actor: actor.name, left: value, label, cost: count });
      if (!game.user.isGM) { ui.notifications.warn(warning); return false; }
      const useAnyway = await foundry.applications.api.DialogV2.confirm({
        window: { title: game.i18n.localize("INCARNOS.Actions.useAnyway") },
        content: `<p>${foundry.utils.escapeHTML(warning)}</p>`,
        yes: { label: game.i18n.localize("INCARNOS.Actions.useAnyway") },
        rejectClose: false, modal: true
      });
      if (!useAnyway) return false;
      if (!inCombat(actor)) return 0;
    }
    const paid = Math.min(count, getActionState(actor).value);
    if (paid) await actor.update({ "system.actionpoints.value": getActionState(actor).value - paid });
    return paid;
  });
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
  return queueActions(actor, async () => {
    const { value, max } = getActionState(actor);
    const updated = action === "reset" ? max : action === "spend" ? Math.max(0, value - 1)
      : action === "restore" ? Math.min(max, value + 1) : value;
    if (updated !== value || Number(actor.system.actionpoints.value) !== updated) {
      await actor.update({ "system.actionpoints.value": updated });
    }
    return true;
  });
}

export function drawActionTracker(token) {
  drawPersistentActionHUD(token);
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
  // Fit every action segment into one row across the token width.
  // Large custom pools use a numeric counter.
  const count = max <= 9 ? max : 1;
  const segmentWidth = (width - gap * (count - 1)) / count;
  container.position.set(0, -height - gap * 2);
  container.visible = actionTrackerVisible(token);
  // A display-only child preserves normal token dragging and selection.
  container.eventMode = "none";
  for (let i = 0; i < count; i++) {
    const segment = new PIXI.Graphics();
    segment.lineStyle(1, 0x101510, 1).beginFill(i < value ? 0x39d353 : 0x273127, 0.95)
      .drawRoundedRect(i * (segmentWidth + gap), 0, segmentWidth, height, 2).endFill();
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

/** HTML controls avoid the token canvas hit area clipping clicks below its bounds. */
export function drawPersistentActionHUD(token) {
  const allowed = !token.destroyed && token.isVisible && canEdit(token.actor)
    && tokenParticipatesInCombat(token)
    && ["character", "npc"].includes(token.actor?.type);
  let controls = tokenControls.get(token);
  if (!allowed) {
    controls?.remove();
    tokenControls.delete(token);
    return;
  }
  if (!controls) {
    controls = document.createElement("div");
    controls.className = "incarnos-persistent-actions-hud";
    Object.assign(controls.style, ACTION_HUD_STYLE, {
      position: "fixed", zIndex: "30", transform: "translateX(-50%)",
      transformOrigin: "top center"
    });
    for (const [action, label, title] of [["spend", "-", "Spend one action"], ["restore", "+", "Restore one action"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.title = title;
      button.setAttribute("aria-label", title);
      Object.assign(button.style, ACTION_BUTTON_STYLE);
      for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "dblclick", "contextmenu"]) {
        button.addEventListener(type, event => { event.stopPropagation(); if (type === "contextmenu") event.preventDefault(); });
      }
      button.addEventListener("click", async event => {
        event.preventDefault(); event.stopPropagation();
        button.disabled = true;
        try { await changeActions(token.actor, action); }
        catch (error) { reportActionError(error); }
        finally { button.disabled = false; }
      });
      controls.append(button);
    }
    document.body.append(controls);
    tokenControls.set(token, controls);
  }
  positionPersistentActionHUD(token, controls);
}

function positionPersistentActionHUD(token, controls) {
  const hud = globalThis.canvas?.tokens?.hud;
  const view = globalThis.canvas?.app?.view;
  const screen = globalThis.canvas?.app?.renderer?.screen;
  const visible = !token.destroyed && token.isVisible && canEdit(token.actor)
    && tokenParticipatesInCombat(token)
    && !(hud?.rendered && hud.object === token);
  controls.style.display = visible && view && screen ? "flex" : "none";
  if (!visible || !view || !screen) return;
  const bounds = view.getBoundingClientRect();
  const scale = (canvas.stage?.scale?.x ?? 1) * (canvas.dimensions?.uiScale ?? 1) * bounds.width / screen.width;
  controls.style.transform = `translateX(-50%) scale(${scale})`;
  const point = token.worldTransform.apply({ x: token.w / 2, y: token.h + 6 });
  controls.style.left = (bounds.left + point.x * bounds.width / screen.width) + "px";
  controls.style.top = (bounds.top + point.y * bounds.height / screen.height) + "px";
}

export function updatePersistentActionHUDs() {
  for (const [token, controls] of tokenControls) {
    if (token.destroyed || !canEdit(token.actor)) {
      controls.remove(); tokenControls.delete(token);
    } else positionPersistentActionHUD(token, controls);
  }
}

function clearPersistentActionHUDs() {
  for (const controls of tokenControls.values()) controls.remove();
  tokenControls.clear();
}

function reportActionError(error) {
  console.error("Incarnos action tracker", error);
  ui.notifications.error("Actions could not be updated.");
}

/** Center compact action controls directly below the primary resource (HP). */
export function positionActionHUD(root, controls) {
  if (!root.isConnected || !controls.isConnected) return;
  const bounds = root.getBoundingClientRect();
  const scale = root.offsetHeight ? bounds.height / root.offsetHeight : 1;
  if (!bounds.height || !Number.isFinite(scale) || scale <= 0) return;
  const hp = root.querySelector('.attribute.bar1 input');
  const rect = hp?.getBoundingClientRect();
  if (rect?.width && rect?.height) {
    const gap = Math.max(0, (rect.top - bounds.bottom) / scale);
    controls.style.top = ((rect.bottom - bounds.top) / scale + gap) + "px";
    controls.style.left = ((rect.left + rect.width / 2 - bounds.left) / scale) + "px";
    controls.style.width = "max-content";
  } else {
    controls.style.top = (bounds.height / scale + 4) + "px";
  }
}

export function renderActionHUD(hud, html) {
  updatePersistentActionHUDs();
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
  Object.assign(controls.style, ACTION_HUD_STYLE, {
    position: "absolute", top: "calc(100% + 4px)", left: "50%",
    transform: "translateX(-50%)"
  });
  for (const [action, label, title] of [["spend", "-", "Spend one action"], ["restore", "+", "Restore one action"]]) {
    const button = document.createElement("button");
    button.type = "button";
    Object.assign(button.style, ACTION_BUTTON_STYLE);
    button.textContent = label;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.addEventListener("click", async event => {
      event.preventDefault(); event.stopPropagation();
      button.disabled = true;
      try { await changeActions(actor, action); }
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
  Hooks.on("canvasReady", () => {
    canvas.app.ticker.remove(updatePersistentActionHUDs);
    canvas.app.ticker.add(updatePersistentActionHUDs);
    refreshTrackers();
  });
  Hooks.on("canvasTearDown", () => {
    canvas.app?.ticker.remove(updatePersistentActionHUDs);
    clearPersistentActionHUDs();
  });
  Hooks.on("destroyToken", token => {
    tokenControls.get(token)?.remove(); tokenControls.delete(token);
  });
  Hooks.on("closeTokenHUD", updatePersistentActionHUDs);
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
