import { getSpellAutomation, getVariableCost } from "./spells.mjs";
import { getCastCost, spendCastCost, refundCastCost } from "./spell-cost.mjs";
import { getActionState, inCombat } from "./action-tracker.mjs";
import { renderSpellCard } from "./spell-card.mjs";
import { escape } from "./roll-card.mjs";
import { activeSummonGM, addSummonCombatant, removeSummonCombatants, sortSummonCombatants, syncSummoned, registerSummonedCounterHooks } from "./summon-lifecycle.mjs";

const text = (key, data = {}) => game.i18n.format(`INCARNOS.Summon.${key}`, data);
const inFlight = new Set();
let requests = Promise.resolve();

/** Only the system monster pack is eligible, with case-insensitive exact version names. */
export async function findSummonVersion(creature, ip = 0) {
  const pack = game.packs.get("incarnos.monsters");
  if (!pack) return null;
  const index = await pack.getIndex();
  const find = name => [...index].find(entry => entry.name.toLowerCase() === name.toLowerCase());
  const requested = ip ? `${creature} +${ip} IP` : creature;
  const entry = find(requested) ?? (ip ? find(creature) : null);
  if (!entry) return null;
  const actor = await pack.getDocument(entry._id);
  if (actor?.documentName !== "Actor" || !["npc", "monster"].includes(actor.type)) return null;
  return { actor, fallback: entry.name.toLowerCase() !== requested.toLowerCase(), requested };
}

export function summonSize(actor) {
  const width = Number(actor.prototypeToken?.width ?? 1), height = Number(actor.prototypeToken?.height ?? 1);
  return { width: Number.isInteger(width) && width > 0 ? width : 1, height: Number.isInteger(height) && height > 0 ? height : 1 };
}

/** Same Euclidean origin measurement as placed spell rectangles, in scene distance units. */
export function summonInRange(system, token, position, scene) {
  const range = Number(String(system.range ?? "").replace(",", ".").match(/^\s*([\d.]+)\s*m\b/i)?.[1]);
  if (!Number.isFinite(range) || !token || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return false;
  const unit = scene.grid.size / scene.grid.distance;
  const center = { x: token.x + token.width * scene.grid.size / 2, y: token.y + token.height * scene.grid.size / 2 };
  return Math.hypot(position.x - center.x, position.y - center.y) <= range * unit + 0.000001;
}

/** A square preview only: neither a persistent Region nor a token is created by the player. */
export async function placeSummon(item, version, casterToken) {
  const scene = canvas.scene;
  const size = summonSize(version.actor);
  ui.notifications.info(text("place", { name: version.actor.name }));
  const data = { name: item.name, color: game.user.color?.css ?? "#ff6400", visibility: CONST.REGION_VISIBILITY.ALWAYS,
    shapes: [{ type: "rectangle", x: casterToken.x, y: casterToken.y, width: size.width * scene.grid.size,
      height: size.height * scene.grid.size, rotation: 0, anchorX: 0, anchorY: 0 }] };
  if (canvas.level?.id) data.levels = [canvas.level.id];
  let preview;
  try {
    preview = await canvas.regions.placeRegion(data, {
      create: false, allowRotation: false,
      onMove: ({ shape, position }) => {
        const snapped = canvas.grid.getSnappedPoint(position, { mode: CONST.GRID_SNAPPING_MODES.TOP_LEFT_CORNER });
        shape.updateSource({ x: snapped.x, y: snapped.y });
        return false;
      },
      preConfirm: ({ shape }) => {
        if (summonInRange(item.system, casterToken, shape, scene) || game.user.isGM) return;
        ui.notifications.warn(text("outOfRange", { name: item.name, range: item.system.range }));
        return false;
      }
    });
  } finally { canvas.tokens.activate(); }
  const shape = preview?.shapes?.[0];
  if (!shape || canvas.scene !== scene) return null;
  const position = { x: shape.x, y: shape.y, sceneId: scene.id, levelId: canvas.level?.id ?? casterToken.level ?? null };
  if (!summonInRange(item.system, casterToken, position, scene)) {
    if (!game.user.isGM || !await foundry.applications.api.DialogV2.confirm({
      window: { title: text("placeAnyway") }, content: `<p>${escape(text("outOfRange", { name: item.name, range: item.system.range }))}</p>`,
      yes: { label: text("placeAnyway") }, rejectClose: false, modal: true
    })) return null;
    position.rangeOverride = true;
  }
  return position;
}

export async function castSummon(item, auto) {
  const gm = activeSummonGM();
  if (!gm) return ui.notifications.warn(text("needGM"));
  const actor = item.actor;
  const tokens = canvas.tokens?.placeables ?? [];
  const caster = actor.token ?? (tokens.find(token => token.controlled && token.actor?.uuid === actor.uuid)
    ?? tokens.find(token => token.actor?.uuid === actor.uuid))?.document;
  if (!canvas.ready || !caster || caster.parent !== canvas.scene) return ui.notifications.warn(text("needToken"));
  const summon = auto.summon;
  const choice = await foundry.applications.api.DialogV2.input({
    window: { title: text("choose", { name: item.name }) },
    content: `<div class="form-group"><label>${escape(text("tier"))}</label><select name="ip">${summon.tiers.map(tier =>
      `<option value="${tier.ip}">${escape(text("option", { tier: tier.ip ? `+${tier.ip} IP` : text("base"),
        total: Number(item.system.mp ?? 0) + tier.ip }))}${tier.effect ? ` — ${escape(tier.effect)}` : ""}</option>`).join("")}</select></div>`,
    ok: { label: text("cast") }, rejectClose: false, modal: true
  });
  if (!choice) return;
  const ip = Number(choice.ip);
  if (!summon.tiers.some(tier => tier.ip === ip)) return;
  const version = game.user.isGM ? await findSummonVersion(summon.creature, ip) : await requestSummonPreview(item, ip);
  if (!version) return ui.notifications.warn(text("missing", { name: summon.creature }));
  const cost = await getCastCost(item, ip);
  if (!cost) return;
  const position = await placeSummon(item, version, caster);
  if (!position) return;
  if (!activeSummonGM()) return ui.notifications.warn(text("needGM"));
  const message = await ChatMessage.create({ whisper: [...new Set([gm.id, game.user.id])], content: `<p>${escape(text("request"))}</p>`,
    flags: { incarnos: { summonRequest: { itemUuid: item.uuid, casterTokenUuid: caster.uuid, ip,
      selectedCost: { actions: cost.actions, mp: cost.mp - ip }, ...position } } } });
  if (activeSummonGM()?.id === game.user.id) await processSummonRequest(message, game.user.id);
  return message;
}

/** Players cannot read the private monster pack. Ask the GM for placement metadata only. */
async function requestSummonPreview(item, ip) {
  const gm = activeSummonGM();
  if (!gm) return null;
  const nonce = foundry.utils.randomID();
  let finish;
  const response = new Promise(resolve => { finish = resolve; });
  const hook = Hooks.on("updateChatMessage", (message, changes, options, userId) => {
    if (userId !== activeSummonGM()?.id || message.author?.id !== game.user.id
      || message.flags?.incarnos?.summonRequest?.nonce !== nonce) return;
    const preview = message.flags.incarnos.summonPreview;
    if (preview) finish(preview);
  });
  const timer = setTimeout(() => finish(null), 30000);
  try {
    await ChatMessage.create({ whisper: [...new Set([gm.id, game.user.id])], content: `<p>${escape(text("request"))}</p>`,
      flags: { incarnos: { summonRequest: { kind: "preview", nonce, itemUuid: item.uuid, ip } } } });
    const preview = await response;
    return preview?.name ? { actor: { name: preview.name, prototypeToken: { width: preview.width, height: preview.height } },
      fallback: preview.fallback, requested: preview.requested } : null;
  } finally { clearTimeout(timer); Hooks.off("updateChatMessage", hook); }
}

/** Identity, ownership and all game data are resolved by the GM, never accepted from request actor/token data. */
export async function validateSummonRequest(message, userId) {
  const data = message?.flags?.incarnos?.summonRequest;
  const user = game.users.get(userId);
  if (!data || data.handled || !user?.active || message.author?.id !== userId
    || !Number.isFinite(message.timestamp) || Math.abs(Date.now() - message.timestamp) > 120000) return null;
  const item = typeof data.itemUuid === "string" ? await fromUuid(data.itemUuid) : null;
  const actor = item?.actor;
  if (item?.documentName !== "Item" || item.type !== "spell" || !actor || item.parent !== actor
    || !(user.isGM || actor.testUserPermission(user, "OWNER"))) return null;
  const auto = getSpellAutomation(item.system);
  if (!auto.summon || !auto.summon.tiers.some(tier => tier.ip === data.ip)) return null;
  const version = await findSummonVersion(auto.summon.creature, data.ip);
  if (!version) return null;
  if (data.kind === "preview") return { data, user, item, actor, auto, version };
  if (data.kind != null) return null;
  const scene = game.scenes.get(data.sceneId);
  const caster = typeof data.casterTokenUuid === "string" ? await fromUuid(data.casterTokenUuid) : null;
  if (!scene || caster?.documentName !== "Token" || caster.parent !== scene || caster.actor?.uuid !== actor.uuid
    || (!user.isGM && user.viewedScene !== scene.id) || (game.paused && !user.isGM)) return null;
  if (data.levelId != null && !scene.levels?.get(data.levelId)) return null;
  const { width, height } = summonSize(version.actor);
  const bounds = scene.dimensions;
  if (!Number.isFinite(data.x) || !Number.isFinite(data.y) || data.x < bounds.sceneX || data.y < bounds.sceneY
    || data.x + width * scene.grid.size > bounds.sceneX + bounds.sceneWidth
    || data.y + height * scene.grid.size > bounds.sceneY + bounds.sceneHeight) return null;
  if (!summonInRange(item.system, caster, data, scene) && !(user.isGM && data.rangeOverride === true)) return null;
  const variable = getVariableCost(item.system.cost);
  if ((variable.actions || variable.mp) && (!data.selectedCost
    || ![data.selectedCost.actions, data.selectedCost.mp].every(value => Number.isSafeInteger(value) && value >= 0))) return null;
  // payActions runs on the GM: reject insufficient player AP before its GM override can appear.
  if (!user.isGM && inCombat(actor) && Number(item.system.actions ?? 0) > getActionState(actor).value) return null;
  return { data, user, item, actor, auto, scene, caster, version };
}

/** Import once per compendium version; add player owners without replacing existing ownership. */
export async function summonWorldActor(source, caster) {
  let folder = [...game.folders].find(folder => folder.type === "Actor" && folder.name === "Summons");
  if (!folder) folder = await Folder.create({ name: "Summons", type: "Actor" });
  let actor = [...game.actors].find(actor => actor.flags?.incarnos?.summonSource === source.uuid);
  if (!actor) {
    const data = game.actors.fromCompendium(source);
    data.folder = folder.id;
    data.flags ??= {};
    data.flags.incarnos = { ...data.flags.incarnos, summonSource: source.uuid };
    actor = await CONFIG.Actor.documentClass.create(data);
  }
  const ownership = { ...actor.ownership };
  for (const user of game.users) {
    if (!user.isGM && caster.testUserPermission(user, "OWNER")) ownership[user.id] = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  }
  await actor.update({ ownership, folder: folder.id });
  return actor;
}

export function summonTokenData(prototype, source, caster, spell, summon, position) {
  const data = foundry.utils.deepClone(prototype);
  delete data._id;
  delete data.actorData;
  delete data.delta;
  return { ...data, ...summonSize(source), name: source.name, actorId: caster.summonActorId, actorLink: false,
    x: position.x, y: position.y, level: position.levelId ?? data.level,
    disposition: CONST.TOKEN_DISPOSITIONS.FRIENDLY,
    flags: { ...data.flags, incarnos: { ...data.flags?.incarnos, summon: { casterUuid: caster.uuid, spell, turnsLeft: summon.turns } } } };
}

async function fulfillSummon(request) {
  const { data, user, item, actor, auto, scene, caster, version } = request;
  const cost = await getCastCost(item, data.ip, data.selectedCost);
  if (!cost || (!user.isGM && inCombat(actor) && cost.actions > getActionState(actor).value)) return false;
  const worldActor = await summonWorldActor(version.actor, actor);
  const prototype = (await worldActor.getTokenDocument({}, { parent: scene })).toObject();
  const tokenData = summonTokenData(prototype, version.actor, { uuid: actor.uuid, summonActorId: worldActor.id }, item.name, auto.summon, data);
  const paid = await spendCastCost(actor, cost, item.name);
  if (paid === false) return false;
  let token;
  try {
    [token] = await scene.createEmbeddedDocuments("Token", [tokenData]);
    if (!token) throw new Error("Summon token creation rejected");
    await syncSummoned(token);
    const combat = [...game.combats].find(combat => combat.started
      && [...combat.combatants].some(c => c.tokenId === caster.id && c.sceneId === scene.id));
    const casterCombatant = combat && [...combat.combatants].find(c => c.tokenId === caster.id && c.sceneId === scene.id);
    if (combat) {
      const added = await addSummonCombatant(combat, { tokenId: token.id, sceneId: scene.id, actorId: worldActor.id,
        initiative: casterCombatant.initiative, flags: { incarnos: { summonAfter: casterCombatant.id } } });
      if (!added.length) throw new Error("Summon combatant creation rejected");
    }
  } catch (error) {
    if (token) {
      for (const combat of game.combats) {
        const ids = [...combat.combatants].filter(c => c.tokenId === token.id && c.sceneId === scene.id).map(c => c.id);
        if (ids.length) await removeSummonCombatants(combat, ids);
      }
      await token.delete();
    }
    await refundCastCost(actor, paid);
    throw error;
  }
  const summary = { name: version.actor.name, ...summonSize(version.actor), turns: auto.summon.turns,
    corpse: auto.summon.corpse, warning: version.fallback ? text("fallback", { requested: version.requested, name: version.actor.name }) : "" };
  await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: renderSpellCard({ name: item.name,
    img: item.img, system: item.system, paid, summon: summary }) });
  return true;
}

export async function processSummonRequest(message, userId) {
  if (!message?.flags?.incarnos?.summonRequest || activeSummonGM()?.id !== game.user.id || inFlight.has(message.id)) return false;
  inFlight.add(message.id);
  const task = requests.catch(() => {}).then(async () => {
    try {
      const request = await validateSummonRequest(message, userId);
      if (!request) {
        if (message.flags.incarnos.summonRequest.kind === "preview") await message.update({ "flags.incarnos.summonPreview": { error: true } });
        if (message.author?.id) await ChatMessage.create({ whisper: [message.author.id], content: `<p>${escape(text("failed"))}</p>` });
        return false;
      }
      await message.update({ "flags.incarnos.summonRequest.handled": true });
      if (request.data.kind === "preview") {
        const version = request.version;
        await message.update({ "flags.incarnos.summonPreview": { name: version.actor.name, ...summonSize(version.actor),
          fallback: version.fallback, requested: version.requested } });
        return true;
      }
      const success = await fulfillSummon(request);
      if (!success) await ChatMessage.create({ whisper: [request.user.id], content: `<p>${escape(text("failed"))}</p>` });
      return success;
    } catch (error) {
      console.error("Incarnos | summon request", error);
      await ChatMessage.create({ whisper: [message.author.id], content: `<p>${escape(text("failed"))}</p>` });
      return false;
    } finally {
      await message.delete();
      inFlight.delete(message.id);
    }
  });
  requests = task;
  return task;
}

export function registerSummonHooks() {
  registerSummonedCounterHooks();
  Hooks.once("init", () => {
    const BaseCombat = CONFIG.Combat.documentClass;
    CONFIG.Combat.documentClass = class extends BaseCombat {
      _sortCombatants(a, b) { return sortSummonCombatants(a, b, (a, b) => super._sortCombatants(a, b)); }
    };
  });
  Hooks.on("createChatMessage", (message, options, userId) => { void processSummonRequest(message, userId); });
  Hooks.on("renderChatMessageHTML", (message, html) => {
    if (message.flags?.incarnos?.summonRequest) html.style.display = "none";
  });
}
