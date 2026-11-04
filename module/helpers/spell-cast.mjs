/** Spell casting: pay the cost, place the area, roll attacks/saves/damage, and let the GM apply the results. */
import { getCastCost, spendCastCost } from "./spell-cost.mjs";
import { castSummon } from "./summons.mjs";
import { waitForContestAnimations } from "./contest-requests.mjs";
import {
  SPELL_STATS, getSpellAttackThreshold, getSpellAutomation, getSpellDamage,
  rollUnderSucceeds
} from "./spells.mjs";
import { renderSpellCard } from "./spell-card.mjs";
import { hasCriticalFailure } from "./critical-failure-rules.mjs";
import { getTalentRules } from "./talents.mjs";
import { modifierForRoller } from "./modifiers.mjs";
import { advantageFormula, applyAttackConditions, applyHealthChange, conditionAdvantage, consumeHindered, promptApplied } from "./conditions.mjs";

const castData = message => message.flags?.incarnos?.spellCast;
const applying = new Set();

/**
 * Cast a spell from an owned item. Spells without automation fields only pay their cost and post their card.
 * @param {Item} item
 */
export async function castSpell(item) {
  const actor = item.actor;
  const system = item.system;
  const auto = getSpellAutomation(system);
  const speaker = ChatMessage.getSpeaker({ actor });
  const rollMode = game.settings.get("core", "messageMode");
  if (!actor) {
    return ChatMessage.create({ speaker, rollMode, content: renderSpellCard({ name: item.name, img: item.img, system }) });
  }

  if (auto.summon) return castSummon(item, auto);

  for (const formula of [auto.damage, auto.heal].filter(Boolean)) {
    if (!Roll.validate(formula)) return ui.notifications.warn(`${item.name}: "${formula}" is not a valid roll formula.`);
  }
  const cost = await getCastCost(item);
  if (!cost) return;

  const casterToken = getCasterToken(actor);
  const healOnly = Boolean(auto.heal) && !auto.damage && !auto.attackStat;
  const resolves = Boolean(auto.attackStat || auto.saveStat || auto.damage || auto.heal || auto.conditions?.length);
  let targets = [];
  if (auto.areaShape && Number(auto.areaSize) > 0) {
    if (!canvas.ready) return ui.notifications.warn("Open a scene to place the spell's area.");
    if (auto.areaOrigin === "self" && !casterToken) return ui.notifications.warn(`${actor.name} needs a token on this scene to cast ${item.name}.`);
    const area = await placeSpellArea(item, auto, casterToken);
    if (!area) return;
    targets = getTokensInArea(area).filter(token => auto.areaShape === "rect" || healOnly || token !== casterToken);
  } else if (resolves) {
    targets = [...game.user.targets];
    if (!targets.length && casterToken && (/^self\b/i.test(system.target ?? "") || healOnly)) targets = [casterToken];
    if (!targets.length) return ui.notifications.warn(`Target the tokens ${item.name} affects first.`);
  }

  const paid = await spendCastCost(actor, cost, item.name);
  if (paid === false) return;

  const rollData = actor.getRollData();
  rollData.lvl ??= Number(actor.system.attributes?.level?.value ?? 0);
  const rolls = [];
  const roll = async (formula, options) => {
    const result = await new Roll(formula, rollData).evaluate(options);
    rolls.push(result);
    return result;
  };
  const multiAttack = Boolean(auto.attackStat && auto.attackCount > 1);
  const damageRoll = auto.damage && targets.length && !multiAttack ? await roll(auto.damage) : null;
  const healRoll = auto.heal && targets.length ? await roll(auto.heal) : null;

  const abilities = actor.system.abilities ?? {};
  const attackValue = auto.attackStat === "intcha"
    ? Math.max(Number(abilities.int?.value ?? 0), Number(abilities.cha?.value ?? 0))
    : Number(abilities[auto.attackStat]?.value ?? 0);

  // Conditions of the caster: Hidden gives advantage on the spell attack, Hindered disadvantage.
  const casterAdvantage = conditionAdvantage(actor.statuses ?? new Set(), "attack");
  const attackFormula = advantageFormula(casterAdvantage.delta);
  const results = [];
  // Single-attack spells share a maxed damage roll for targets hit critically.
  let critRoll = null;
  for (const token of targets) {
    const target = token.actor;
    const result = { name: token.name, img: token.document.texture?.src ?? target.img, uuid: target.uuid, hit: true, saved: false };
    // PvP rules: a player's spell hitting another player character deals half damage.
    result.pvp = Boolean(auto.damage) && actor.hasPlayerOwner && target.hasPlayerOwner && target.type === "character" && target !== actor;
    const attacks = multiAttack ? Array.from({ length: auto.attackCount }, () => ({ hit: true, saved: false })) : [result];
    for (const hit of attacks) {
      if (auto.attackStat) {
        const d20 = (await roll(attackFormula)).total;
        // Modifiers are written from the players' side; a monster caster rolls with the opposite sign.
        const threshold = getSpellAttackThreshold(attackValue, target.system.attributes?.parry?.value, modifierForRoller(auto.attackModifier, actor));
        hit.attack = { d20, threshold };
        hit.hit = rollUnderSucceeds(d20, threshold);
        hit.crit = d20 === 1;
      }
      if (auto.saveStat && hit.hit) {
        const ability = target.system.abilities?.[auto.saveStat] ?? {};
        // Talents such as Cold-Hearted give the target advantage on this save: 2d20, keep the lower.
        const advantage = getTalentRules(target.items).saveAdvantage[auto.saveStat] ?? null;
        const d20 = (await roll(advantage ? "2d20kl" : "1d20")).total;
        // "Target Save Wil+4" helps the players: a monster target saves at −4, a player character at +4.
        const threshold = Number(ability.save ?? ability.value ?? 0) + modifierForRoller(auto.saveModifier, target);
        hit.save = { d20, threshold, advantage };
        hit.saved = rollUnderSucceeds(d20, threshold);
      }
      let hitDamage = damageRoll;
      if (multiAttack && hit.hit && auto.damage) {
        hitDamage = await roll(auto.damage, hit.crit ? { maximize: true } : undefined);
        hit.damageRoll = { total: hitDamage.total, formula: hitDamage.formula, result: hitDamage.result };
      } else if (hit.crit && damageRoll) {
        if (!critRoll) critRoll = await new Roll(auto.damage, rollData).evaluate({ maximize: true });
        hitDamage = critRoll;
      }
      hit.damage = hitDamage
        ? getSpellDamage(hitDamage.total, { hit: hit.hit, saved: hit.saved, saveEffect: auto.saveEffect, pvp: result.pvp })
        : 0;
    }
    if (multiAttack) {
      result.attacks = attacks;
      result.hit = attacks.some(hit => hit.hit);
      result.crit = attacks.some(hit => hit.crit);
      result.saved = result.hit && attacks.filter(hit => hit.hit).every(hit => hit.saved);
      result.damage = attacks.reduce((total, hit) => total + hit.damage, 0);
    }
    result.heal = healRoll && result.hit ? healRoll.total : 0;
    // Conditions from the spell text (e.g. knocked prone, sleep tokens): on a hit, unless a save negates them.
    result.conditions = [];
    for (const condition of auto.conditions ?? []) {
      if (!result.hit || (condition.saveNegates && result.saved)) continue;
      // A plain number of tokens (Regenerating 2) needs no roll; dice (sleep tokens) are rolled and shown.
      const fixed = /^\d+$/.test(condition.formula ?? "") ? Number(condition.formula) : null;
      const tokenRoll = condition.formula && fixed === null ? await roll(condition.formula) : null;
      result.conditions.push({ id: condition.id, name: condition.name,
        ...(condition.timed !== undefined ? { timed: condition.timed } : {}),
        ...(fixed !== null ? { tokens: fixed } : {}),
        ...(tokenRoll ? { tokens: tokenRoll.total, roll: { formula: tokenRoll.formula, result: tokenRoll.result } } : {}),
        // Healing per turn (Regenerating) is fixed with the caster's level now: "1d6 + (@lvl * 1)" -> "1d6 + (2 * 1)".
        ...(condition.heal ? { heal: Roll.replaceFormulaData(condition.heal, rollData) } : {}) });
    }
    results.push(result);
  }

  // Hindered lasts for one attack.
  if (auto.attackStat && results.length) await consumeHindered(actor);

  const rollSummary = roll => roll && { total: roll.total, formula: roll.formula, result: roll.result };
  const attackName = auto.attackStat === "intcha" ? (Number(abilities.int?.value ?? 0) >= Number(abilities.cha?.value ?? 0) ? "Int" : "Cha") : SPELL_STATS[auto.attackStat];
  const card = pending => renderSpellCard({
    name: item.name, img: item.img, system, auto, paid, results, pending,
    criticalFailureLabel: game.i18n?.localize("INCARNOS.CriticalFailure.title"),
    damage: rollSummary(damageRoll), critDamage: rollSummary(critRoll), heal: rollSummary(healRoll),
    attackLabel: `Attack (${attackName} ${attackValue} + Parry modifier${casterAdvantage.delta ? `, ${casterAdvantage.delta > 0 ? "advantage" : "disadvantage"}: ${casterAdvantage.sources.join(", ")}` : ""})`
  });
  const chatData = {
    speaker,
    content: card(rolls.length > 0),
    rolls: rolls.map(result => result.toJSON()),
    sound: rolls.length ? CONFIG.sounds.dice : undefined,
    flags: { incarnos: { ...(hasCriticalFailure(results) ? { criticalFailureAttack: { actorUuid: actor.uuid, kind: "spell" } } : {}), spellCast: { itemName: item.name, autoConditions: true, resolved: !rolls.length, targets: results.map(({ name, uuid, damage, heal, conditions }) =>
      ({ name, uuid, damage, heal, conditions, appliedDamage: false, appliedHeal: false })) } } }
  };
  ChatMessage.applyMode(chatData, rollMode);
  const message = await ChatMessage.create(chatData);
  // Like weapon attacks: outcomes appear once the dice have landed.
  if (message && rolls.length) {
    await waitForContestAnimations([message.id]);
    // Once the dice have landed, the GM's client puts the spell's conditions on the targets (see registerSpellCastHooks).
    await message.update({ content: card(false), "flags.incarnos.spellCast.resolved": true });
  }
  return message;
}

/** The caster's token on this scene (linked or not), preferring a controlled one. */
function getCasterToken(actor) {
  if (actor.token?.object) return actor.token.object;
  const tokens = canvas.tokens?.placeables.filter(token => token.actor === actor || token.document.actorId === actor.id) ?? [];
  return tokens.find(token => token.controlled) ?? tokens[0] ?? null;
}

/**
 * Let the caster place the spell's area. Areas from the caster stay on their token; lines turn toward the cursor.
 * The Region is kept on the scene when the user may create Regions, otherwise only its preview is used.
 * @returns {Promise<RegionDocument|null>}
 */
async function placeSpellArea(item, auto, casterToken) {
  const unit = canvas.dimensions.distancePixels;
  const start = casterToken?.center ?? canvas.mousePosition ?? { x: 0, y: 0 };
  const shape = ["line", "rect"].includes(auto.areaShape)
    ? { type: "line", x: start.x, y: start.y, length: Number(auto.areaSize) * unit, width: Number(auto.areaWidth || 1.5) * unit, rotation: 0 }
    : { type: "circle", x: start.x, y: start.y, radius: Number(auto.areaSize) * unit };
  const data = {
    name: item.name,
    shapes: [shape],
    color: game.user.color?.css ?? "#ff6400",
    displayMeasurements: true,
    visibility: CONST.REGION_VISIBILITY.ALWAYS,
    flags: { incarnos: { spellArea: item.uuid } }
  };
  if (canvas.level?.id) data.levels = [canvas.level.id];

  const fromCaster = auto.areaOrigin === "self" && casterToken;
  const range = auto.areaShape === "rect" && casterToken
    ? Number(String(item.system.range ?? "").replace(",", ".").match(/^\s*([\d.]+)\s*m/i)?.[1]) : 0;
  ui.notifications.info(auto.areaShape === "rect"
    ? game.i18n.format("INCARNOS.SpellArea.placeRectangle", { name: item.name })
    : fromCaster && shape.type === "line"
      ? `Point ${item.name} with the mouse and left-click to cast (right-click cancels).`
      : `Left-click to place ${item.name} (right-click cancels).`);
  const preview = await canvas.regions.placeRegion(data, {
    create: false,
    allowRotation: shape.type === "line" && !fromCaster,
    preConfirm: range > 0 ? ({ shape: placed }) => {
      if (Math.hypot(placed.x - casterToken.center.x, placed.y - casterToken.center.y) <= range * unit) return;
      ui.notifications.warn(game.i18n.format("INCARNOS.SpellArea.outOfRange", { name: item.name, range }));
      return false;
    } : undefined,
    onMove: fromCaster ? ({ shape: placed, position }) => {
      const center = casterToken.center;
      const changes = { x: center.x, y: center.y };
      if (placed.type === "line") changes.rotation = Math.toDegrees(Math.atan2(position.y - center.y, position.x - center.x));
      placed.updateSource(changes);
      return false;
    } : undefined
  });
  canvas.tokens.activate();
  if (!preview) return null;
  if (preview.canUserModify(game.user, "create") && (game.user.isGM || !game.paused)) {
    return (await CONFIG.Region.documentClass.create(preview.toObject(), { parent: canvas.scene })) ?? preview;
  }
  return preview;
}

/** Tokens whose centre lies inside the area. Rule: area spells never hit invisible creatures (tokens hidden from players). */
export function getTokensInArea(area, tokens = canvas.tokens.placeables) {
  return tokens.filter(token => token.actor && !token.document.hidden
    && area.testPoint({ x: token.center.x, y: token.center.y, elevation: token.document.elevation ?? 0 }));
}

/** GM only: change HP for one result (or all pending ones) and mark them applied on the card. */
export async function applySpellResult(message, kind, index) {
  const cast = castData(message);
  if (!cast || !game.user.isGM || applying.has(message.id)) return;
  applying.add(message.id);
  try {
    const targets = foundry.utils.deepClone(cast.targets);
    const jobs = kind === "all"
      ? targets.flatMap((target, i) => [["damage", i], ["heal", i], ["conditions", i]])
      : [[kind, Number(index)]];
    for (const [type, i] of jobs) {
      const target = targets[i];
      // Conditions without damage (e.g. a spell that only knocks prone) have their own Apply.
      if (type === "conditions") {
        if (!target?.conditions?.length || target.appliedConditions || target.damage) continue;
        const actor = await fromUuid(target.uuid);
        if (!actor) continue;
        await applyAttackConditions(actor, target.conditions);
        target.appliedConditions = true;
        continue;
      }
      const flag = type === "heal" ? "appliedHeal" : "appliedDamage";
      if (!target || !target[type] || target[flag]) continue;
      const actor = await fromUuid(target.uuid);
      if (!actor?.system?.health) continue;
      // The damage of the spell that put the target to sleep doesn't halve those fresh sleep tokens.
      const keepSleep = type === "damage" && target.appliedConditions && target.conditions?.some(condition => condition.id === "asleep");
      // The target's owner may already have applied it from their side (remembered on the actor).
      await applyHealthChange(actor, resultKey(message, type, i), type, target[type], { incarnosKeepSleep: keepSleep });
      target[flag] = true;
      // Conditions of the hit (e.g. Burn tokens from a monster attack) land with the damage, after it.
      if (type === "damage" && target.conditions?.length && !target.appliedConditions && !promptApplied(actor, resultKey(message, "conditions", i))) {
        await applyAttackConditions(actor, target.conditions);
        target.appliedConditions = true;
      }
    }
    await message.update({ "flags.incarnos.spellCast.targets": targets });
  } finally {
    applying.delete(message.id);
  }
}

/** Key under which an applied result line is remembered on the target actor. */
const resultKey = (message, type, index) => `${message.id}-${type}-${index}`;

/**
 * The target's owner applies their own line (damage or healing) from a spell or attack card. The GM's card can't be
 * edited by players, so the applied state is remembered on the actor, which the card and the GM's Apply both check.
 */
export async function applyOwnResult(message, kind, index) {
  const cast = castData(message);
  const target = cast?.targets?.[Number(index)];
  if (!target || !target[kind] || target[kind === "heal" ? "appliedHeal" : "appliedDamage"]) return;
  const actor = await fromUuid(target.uuid);
  if (!actor?.isOwner) return;
  const keepSleep = kind === "damage" && target.appliedConditions && target.conditions?.some(condition => condition.id === "asleep");
  await applyHealthChange(actor, resultKey(message, kind, index), kind, target[kind], { incarnosKeepSleep: keepSleep });
  const conditionKey = resultKey(message, "conditions", index);
  if (kind === "damage" && target.conditions?.length && !target.appliedConditions && !promptApplied(actor, conditionKey)) {
    await applyAttackConditions(actor, target.conditions);
    await actor.setFlag("incarnos", `appliedPrompts.${conditionKey}`, true);
  }
  ui.chat?.updateMessage?.(message);
}

/** Put a resolved spell's conditions on its targets (once, by the first active GM). */
export async function applyCastConditions(message) {
  const cast = castData(message);
  if (!cast?.autoConditions || !cast.resolved || applying.has(message.id)) return;
  const targets = foundry.utils.deepClone(cast.targets);
  if (!targets.some(target => target.conditions?.length && !target.appliedConditions)) return;
  applying.add(message.id);
  try {
    for (const target of targets) {
      if (!target.conditions?.length || target.appliedConditions) continue;
      const actor = await fromUuid(target.uuid);
      if (!actor) continue;
      await applyAttackConditions(actor, target.conditions);
      target.appliedConditions = true;
    }
    await message.update({ "flags.incarnos.spellCast.targets": targets });
  } finally {
    applying.delete(message.id);
  }
}

const isFirstActiveGM = () => game.user.isGM
  && [...game.users].filter(user => user.active && user.isGM).sort((a, b) => a.id.localeCompare(b.id))[0]?.id === game.user.id;

/** Apply buttons: the GM applies any line (or all); a target's owner applies their own line. */
export function registerSpellCastHooks() {
  // Spell conditions (sleep tokens, prone) land automatically once the cast's dice have landed.
  const autoApply = message => {
    if (isFirstActiveGM()) void applyCastConditions(message).catch(error => console.error("Incarnos | spell conditions", error));
  };
  Hooks.on("createChatMessage", autoApply);
  Hooks.on("updateChatMessage", autoApply);
  Hooks.on("renderChatMessageHTML", (message, html) => {
    const cast = castData(message);
    if (!cast) return;
    for (const button of html.querySelectorAll("[data-incarnos-spell-apply]")) {
      const kind = button.dataset.incarnosSpellApply;
      const target = cast.targets[Number(button.dataset.index)];
      const targetActor = target?.uuid ? fromUuidSync(target.uuid) : null;
      const ownLine = kind !== "all" && !game.user.isGM && targetActor?.isOwner;
      if (!game.user.isGM && !ownLine) { button.remove(); continue; }
      const done = kind === "all"
        ? cast.targets.every(t => (!t.damage || t.appliedDamage) && (!t.heal || t.appliedHeal) && (!t.conditions?.length || t.appliedConditions))
        : target?.[{ heal: "appliedHeal", conditions: "appliedConditions" }[kind] ?? "appliedDamage"]
          || promptApplied(targetActor, resultKey(message, kind, Number(button.dataset.index)));
      if (done) {
        button.disabled = true;
        button.classList.add("isc-done");
        button.title = "Applied";
        button.innerHTML = kind === "all" ? '<i class="fas fa-check-double"></i> All applied' : '<i class="fas fa-check"></i>';
        continue;
      }
      button.addEventListener("click", async event => {
        event.preventDefault();
        button.disabled = true;
        try { await (game.user.isGM ? applySpellResult(message, kind, button.dataset.index) : applyOwnResult(message, kind, button.dataset.index)); }
        catch (error) { console.error(error); ui.notifications.error("The spell result could not be applied."); button.disabled = false; }
      });
    }
  });
}
