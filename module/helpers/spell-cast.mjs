/** Spell casting: pay the cost, place the area, roll attacks/saves/damage, and let the GM apply the results. */
import { checkCastCost, getCastCost, spendCastCost } from "./spell-cost.mjs";
import { castSummon } from "./summons.mjs";
import { waitForContestAnimations } from "./contest-requests.mjs";
import {
  SPELL_STATS, getSpellAttackThreshold, getSpellAutomation, getSpellChatContent, getSpellDamage, getSpellOptions, getSpellOptionSystem,
  rollUnderSucceeds
} from "./spells.mjs";
import { renderSpellCard } from "./spell-card.mjs";
import { escape } from "./roll-card.mjs";
import { hasCriticalFailure } from "./critical-failure-rules.mjs";
import { getTalentRules } from "./talents.mjs";
import { modifierForRoller } from "./modifiers.mjs";
import { advantageFormula, applyAttackConditions, applyHealthChange, asleepAfterDamage, conditionAdvantage, conditionTokens, consumeHindered, promptApplied, shadowcloneCheck } from "./conditions.mjs";
import { checkSpellTargets, describeSpellTargets, filterBySide, parseSpellTargets, relationTo } from "./spell-targets.mjs";
import { createRangeRing, gridOptions, parseSpellRange, showRangeIndicator, targetInRange } from "./spell-range.mjs";
import { encoreCost, lastSpellRecord, rememberSpell } from "./last-spell.mjs";
export { encoreCost, lastSpellRecord };

const castData = message => message.flags?.incarnos?.spellCast;
const applying = new Set();

/** A fresh choice for every cast; closing the dialog never starts a cast. */
async function chooseSpellOption(item, options) {
  const data = await foundry.applications.api.DialogV2.input({
    window: { title: game.i18n.format("INCARNOS.SpellOptions.choose", { name: item.name }) },
    content: options.map((option, index) => `<fieldset class="spell-option"><legend><label>
      <input type="radio" name="option" value="${index}"${index === 0 ? " checked" : ""}>${escape(option.name)}</label></legend>
      <p>${[option.range, option.target, option.check, option.duration].filter(Boolean).map(escape).join(" · ")}</p>
      <p>${escape(option.effect).replace(/\n/g, "<br>")}</p></fieldset>`).join(""),
    ok: { label: game.i18n.localize("INCARNOS.SpellOptions.cast") },
    rejectClose: false
  });
  if (!data || !/^\d+$/.test(String(data.option))) return null;
  return options[Number(data.option)] ?? null;
}

/** Encore ("Immediately copy a spell and pay the costs"): copies an ally's last spell. */
export const isEncoreSpell = system => /\bcopy a spell\b/i.test(String(system?.effect ?? ""));


/**
 * Cast a spell from an owned item. Spells without automation fields only pay their cost and post their card.
 * @param {Item} item
 * @param {{cost?: {actions: number, mp: number}, remember?: object}} [options]
 *   `cost`: a fixed cost instead of the spell's own (Encore); `remember`: the spell data to remember instead of the item's.
 */
export async function castSpell(item, { cost: fixedCost = null, remember = null } = {}) {
  const actor = item.actor;
  if (!fixedCost && actor && isEncoreSpell(item.system)) return castEncore(item);
  const options = getSpellOptions(item.system);
  const option = options.length ? await chooseSpellOption(item, options) : null;
  if (options.length && !option) return;
  const system = getSpellOptionSystem(item.system, option);
  let auto = getSpellAutomation(item.system, option);
  // Shadowstrike: "In Shadowform: Deals 4d8 + (lvl *2)" replaces the damage while the caster is in Shadowform.
  if (auto.shadowformDamage && actor?.statuses?.has("shadowform")) auto = { ...auto, damage: auto.shadowformDamage };
  const speaker = ChatMessage.getSpeaker({ actor });
  const rollMode = game.settings.get("core", "messageMode");
  if (!actor) {
    return ChatMessage.create({ speaker, rollMode, content: renderSpellCard({ name: item.name, img: item.img, system, option }) });
  }

  // Summons: the GM's client places the creature and remembers the spell. An Encore copy places the same version.
  if (auto.summon) return castSummon(item, auto, fixedCost && remember?.uuid ? { sourceItemUuid: remember.uuid, ip: remember.summonIp ?? 0, cost: fixedCost, record: remember } : null);

  for (const formula of [auto.damage, auto.heal].filter(Boolean)) {
    if (!Roll.validate(formula)) return ui.notifications.warn(`${item.name}: "${formula}" is not a valid roll formula.`);
  }
  const cost = fixedCost ? checkCastCost(item, fixedCost) : await getCastCost(item);
  if (!cost) return;

  const casterToken = getCasterToken(actor);
  const healOnly = Boolean(auto.heal) && !auto.damage && !auto.attackStat;
  const resolves = Boolean(auto.attackStat || auto.saveStat || auto.damage || auto.heal || auto.conditions?.length);
  // Who the spell may hit (Target line): side, how many, and whether the caster counts.
  const targetRule = parseSpellTargets(system.target);
  const caster = { actor, token: casterToken };
  // "Up to 5 Enemies" with "Self (6m radius)": the radius is the range for picked targets, not an area hitting everyone.
  const pickInRadius = targetRule.kind === "pick" && auto.areaShape === "circle" && auto.areaOrigin === "self";
  let targets = [];
  if (auto.areaShape && Number(auto.areaSize) > 0 && !pickInRadius) {
    if (!canvas.ready) return ui.notifications.warn("Open a scene to place the spell's area.");
    if (auto.areaOrigin === "self" && !casterToken) return ui.notifications.warn(`${actor.name} needs a token on this scene to cast ${item.name}.`);
    const area = await placeSpellArea(item, auto, casterToken, system);
    if (!area) return;
    // "Enemies" / "Friendlies" / "Allies": everyone of that side in the area; otherwise everyone inside.
    targets = targetRule.kind === "all" ? filterBySide(targetRule, getTokensInArea(area), caster)
      : getTokensInArea(area).filter(token => auto.areaShape === "rect" || healOnly || token !== casterToken);
  } else if (resolves) {
    // A Self spell (Shadowform, Inner Focus) always lands on the caster, whatever else is targeted. "Sight" spells
    // for a whole side (Shadowclones: "All allies in sight") take every visible token of that side on the scene.
    targets = targetRule.kind === "self" && casterToken ? [casterToken]
      : targetRule.kind === "all" && /\bsight\b/i.test(system.range ?? "") && canvas?.ready
        ? filterBySide(targetRule, (canvas.tokens?.placeables ?? []).filter(token => token.actor && !token.document.hidden), caster)
        : [...game.user.targets];
    if (!targets.length && casterToken && (/^self\b/i.test(system.target ?? "") || healOnly)) targets = [casterToken];
    if (!targets.length) return ui.notifications.warn(`Target the tokens ${item.name} affects first.`);
    const problem = checkSpellTargets(targetRule, targets.map(token => ({
      relation: relationTo(caster, token),
      asleep: Boolean(token.actor?.statuses?.has("asleep")),
      shadowmarked: Boolean(token.actor?.statuses?.has("shadowmarked")),
      downed: Number(token.actor?.system?.health?.value) <= 0 || ["dying", "unconscious"].some(id => token.actor?.statuses?.has(id))
    })));
    if (problem && !(await allowWrongTargets(item, targetRule, problem))) return;
    // Range ("12m", "Touch"; "Up to 5 Enemies" in "Self (6m radius)": the radius): a ring around the caster and a
    // green/red ring around each target. A target out of range stops a player's cast; the GM may cast anyway.
    const range = pickInRadius ? { meters: Number(auto.areaSize), touch: false } : parseSpellRange(system.range);
    if (range && casterToken && canvas?.ready) {
      const options = gridOptions();
      const checked = targets.filter(token => token !== casterToken)
        .map(token => ({ token, ok: targetInRange(range, casterToken, token, options) }));
      showRangeIndicator(casterToken, range, checked);
      if (checked.some(entry => !entry.ok) && !(await allowOutOfRange(item, range))) return;
    }
  }

  const paid = await spendCastCost(actor, cost, item.name);
  if (paid === false) return;
  // Remember the spell and its own cost for Encore (an Encore copy remembers the copied spell).
  const data = remember?.data ?? item.toObject?.();
  if (data) await rememberSpell(actor, lastSpellRecord(data, remember?.cost ?? cost, { uuid: remember?.uuid ?? item.uuid, summonIp: remember?.summonIp }));

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
  // Save-gated extra damage (Who let the apes out: "+2d4 when launched"), one roll for all targets like the damage.
  const bonusRoll = auto.bonusDamage && targets.length ? await roll(auto.bonusDamage.formula) : null;

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
        // Shadowclone: on a d20 of 9 or lower the clone is attacked instead; the target takes nothing from this attack.
        const clone = await shadowcloneCheck(target, roll);
        if (clone) {
          hit.clone = { d20: clone.d20, diverted: clone.diverted };
          if (clone.diverted) { hit.hit = false; hit.crit = false; }
        }
      }
      if (auto.saveStat && hit.hit) {
        const ability = target.system.abilities?.[auto.saveStat] ?? {};
        // Talents such as Cold-Hearted give the target advantage on this save: 2d20, keep the lower.
        const talentAdvantage = getTalentRules(target.items).saveAdvantage[auto.saveStat] ?? null;
        // Blinded targets save with disadvantage; it cancels a talent's advantage.
        const saveCondition = conditionAdvantage(target.statuses ?? new Set(), "save");
        const saveDelta = (talentAdvantage ? 1 : 0) + saveCondition.delta;
        const advantage = saveDelta > 0 ? talentAdvantage : null;
        const d20 = (await roll(advantageFormula(saveDelta))).total;
        // "Target Save Wil+4" helps the players: a monster target saves at −4, a player character at +4.
        const threshold = Number(ability.save ?? ability.value ?? 0) + modifierForRoller(auto.saveModifier, target);
        hit.save = { d20, threshold, advantage, ...(saveDelta < 0 ? { disadvantage: saveCondition.sources.join(", ") } : {}) };
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
      // Rise and Shine: the target's sleep tokens add to the damage; a hit that wakes it (the damage takes its last
      // tokens) deals the wake-up damage instead.
      const sleep = conditionTokens(target, "asleep");
      if (hit.hit && hitDamage && sleep > 0 && auto.wakeDamage && asleepAfterDamage(sleep) === 0) {
        const wakeRoll = await roll(auto.wakeDamage, hit.crit ? { maximize: true } : undefined);
        hit.damage = getSpellDamage(wakeRoll.total, { hit: true, saved: hit.saved, saveEffect: auto.saveEffect, pvp: result.pvp });
        hit.wake = { formula: wakeRoll.formula, result: wakeRoll.result, total: wakeRoll.total };
      } else if (hit.hit && hitDamage && sleep > 0 && auto.plusSleepTokens) {
        hit.damage += getSpellDamage(sleep, { hit: true, saved: hit.saved, saveEffect: auto.saveEffect, pvp: result.pvp });
        hit.sleepBonus = sleep;
      }
    }
    if (multiAttack) {
      result.attacks = attacks;
      result.hit = attacks.some(hit => hit.hit);
      result.crit = attacks.some(hit => hit.crit);
      result.saved = result.hit && attacks.filter(hit => hit.hit).every(hit => hit.saved);
      result.damage = attacks.reduce((total, hit) => total + hit.damage, 0);
      // The card shows the clone once: diverted if any of the attacks went to the clone.
      const clones = attacks.filter(hit => hit.clone);
      if (clones.length) result.clone = clones.find(hit => hit.clone.diverted)?.clone ?? clones[0].clone;
    }
    if (bonusRoll && result.hit && !(auto.bonusDamage.saveNegates && result.saved)) {
      result.bonusDamage = { amount: getSpellDamage(bonusRoll.total, { pvp: result.pvp }), formula: bonusRoll.formula, result: bonusRoll.result };
      result.damage = (result.damage ?? 0) + result.bonusDamage.amount;
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
        ...(condition.heal ? { heal: Roll.replaceFormulaData(condition.heal, rollData) } : {}),
        // Taunted remembers its taunter.
        ...(condition.id === "taunted" ? { by: actor.name } : {}) });
    }
    results.push(result);
  }

  // Hindered lasts for one attack.
  if (auto.attackStat && results.length) await consumeHindered(actor);

  const rollSummary = roll => roll && { total: roll.total, formula: roll.formula, result: roll.result };
  const attackName = auto.attackStat === "intcha" ? (Number(abilities.int?.value ?? 0) >= Number(abilities.cha?.value ?? 0) ? "Int" : "Cha") : SPELL_STATS[auto.attackStat];
  const card = pending => renderSpellCard({
    name: item.name, img: item.img, system, option, auto, paid, results, pending,
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
/**
 * Encore: target one ally within range; copy the spell that ally cast last, then target what the copy should hit.
 * The copy is cast by the Encore caster (own stats) for the copied spell's actions and its IP + 2.
 */
async function castEncore(item) {
  const actor = item.actor;
  const casterToken = getCasterToken(actor);
  const rule = parseSpellTargets(item.system.target);
  const allies = [...game.user.targets];
  const problem = checkSpellTargets(rule, allies.map(token => ({ relation: relationTo({ actor, token: casterToken }, token) })));
  if (problem && !(await allowWrongTargets(item, rule, problem))) return;
  const range = parseSpellRange(item.system.range);
  if (range && casterToken && canvas?.ready && allies.length) {
    const checked = allies.map(token => ({ token, ok: targetInRange(range, casterToken, token, gridOptions()) }));
    showRangeIndicator(casterToken, range, checked);
    if (checked.some(entry => !entry.ok) && !(await allowOutOfRange(item, range))) return;
  }
  const ally = allies[0]?.actor;
  if (!ally) return ui.notifications.warn(game.i18n.format("INCARNOS.Encore.noAlly", { name: item.name }));
  const last = ally.getFlag?.("incarnos", "lastSpell");
  if (!last?.data) return ui.notifications.warn(game.i18n.format("INCARNOS.Encore.nothing", { ally: ally.name }));
  const cost = encoreCost(last);
  const data = foundry.utils.deepClone(last.data);
  delete data._id;
  data.name = `${item.name}: ${last.name}`;
  const copy = new CONFIG.Item.documentClass(data, { parent: actor });
  const cast = () => castSpell(copy, { cost, remember: { data: last.data, cost: last.cost, uuid: last.uuid, summonIp: last.summonIp } });
  const copied = { spell: last.name, ally: ally.name, actions: cost.actions, ip: cost.mp };

  const { DialogV2 } = foundry.applications.api;

  // 1. "Spell copied": cast it?
  const want = await DialogV2.confirm({
    window: { title: game.i18n.localize("INCARNOS.Encore.copiedTitle") },
    content: `<p>${escape(game.i18n.format("INCARNOS.Encore.copied", copied))}</p><p>${escape(game.i18n.localize("INCARNOS.Encore.castIt"))}</p>`,
    yes: { label: game.i18n.localize("Yes") }, no: { label: game.i18n.localize("No") }, rejectClose: false
  });
  if (!want) return;

  // 2. The spell itself with its price; targeting starts here as for any cast (the ally's target is cleared and the
  // targeting tool switched on). Self and area spells need no targets: Cast casts them or starts the area placement.
  const needsTargets = encoreNeedsTargets(data.system);
  if (needsTargets) {
    canvas?.tokens?.setTargets?.([]);
    await ui.controls?.activate?.({ control: "tokens", tool: "target" })?.catch?.(() => {});
  }
  // Laid out like the spell's row and opened text on the character sheet (heading font, orange-edged text box).
  const go = await DialogV2.confirm({
    window: { title: data.name },
    classes: ["incarnos-encore"],
    position: { width: 460 },
    content: `<div class="encore-head"><img src="${escape(data.img ?? "")}" alt="" width="32" height="32">`
      + `<h4>${escape(last.name)}</h4><span class="encore-cost">${escape(game.i18n.format("INCARNOS.Encore.cost", copied))}</span></div>`
      + `<div class="encore-text">${getSpellChatContent(data.system)}</div>`
      + (needsTargets ? `<p class="encore-hint">${escape(game.i18n.format("INCARNOS.Encore.targetHint", copied))}</p>` : ""),
    yes: { label: game.i18n.localize("INCARNOS.Encore.cast") }, no: { label: game.i18n.localize("Cancel") }, rejectClose: false
  });
  if (needsTargets) await ui.controls?.activate?.({ control: "tokens", tool: "select" })?.catch?.(() => {});
  if (!go) return;
  // 3. Cast: the copy runs like any cast (cast choices, area placement, target and range checks, rolls).
  return cast();
}

/** Whether Encore's copy needs targets picked first: targeted spells and spells with cast choices; not Self or areas. */
export function encoreNeedsTargets(system = {}) {
  if (getSpellOptions(system).length) return true;
  const rule = parseSpellTargets(system.target);
  if (rule.kind !== "pick" && rule.kind !== "all") return false;
  const auto = getSpellAutomation(system);
  const radiusRange = rule.kind === "pick" && auto.areaShape === "circle" && auto.areaOrigin === "self";
  return !(auto.areaShape && Number(auto.areaSize) > 0 && !radiusRange);
}

/** A target out of range: players are stopped (nothing paid); the GM may cast anyway. */
async function allowOutOfRange(item, range) {
  const message = game.i18n.format("INCARNOS.SpellRange.out", { name: item.name,
    range: range.touch ? game.i18n.localize("INCARNOS.SpellRange.touch") : `${range.meters} m` });
  if (!game.user.isGM) { ui.notifications.warn(message); return false; }
  return Boolean(await foundry.applications.api.DialogV2.confirm({
    window: { title: game.i18n.localize("INCARNOS.SpellTargets.castAnyway") },
    content: `<p>${escape(message)}</p>`,
    yes: { label: game.i18n.localize("INCARNOS.SpellTargets.castAnyway") }, no: { label: game.i18n.localize("Cancel") }
  }));
}

/** Wrong targets: players are stopped (nothing paid); the GM may cast anyway. */
async function allowWrongTargets(item, rule, problem, range = 0) {
  const message = game.i18n.format(problem === "range" ? "INCARNOS.SpellTargets.range" : "INCARNOS.SpellTargets.wrong",
    { name: item.name, targets: describeSpellTargets(rule), range });
  if (!game.user.isGM) { ui.notifications.warn(message); return false; }
  return Boolean(await foundry.applications.api.DialogV2.confirm({
    window: { title: game.i18n.localize("INCARNOS.SpellTargets.castAnyway") },
    content: `<p>${escape(message)}</p>`,
    yes: { label: game.i18n.localize("INCARNOS.SpellTargets.castAnyway") }, no: { label: game.i18n.localize("Cancel") }
  }));
}

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
async function placeSpellArea(item, auto, casterToken, system = item.system) {
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
  const orthogonal = auto.areaShape === "line" && /orthogonal/i.test(system.target ?? "") && casterToken;
  const range = auto.areaOrigin === "placed" && casterToken
    ? Number(String(system.range ?? "").replace(",", ".").match(/^\s*([\d.]+)\s*m(?!\s*radius)/i)?.[1]) : 0;
  ui.notifications.info(orthogonal
    ? game.i18n.format("INCARNOS.SpellArea.placeOrthogonal", { name: item.name })
    : auto.areaShape === "rect"
    ? game.i18n.format("INCARNOS.SpellArea.placeRectangle", { name: item.name })
    : fromCaster && shape.type === "line"
      ? `Point ${item.name} with the mouse and left-click to cast (right-click cancels).`
      : `Left-click to place ${item.name} (right-click cancels).`);
  // The placed point (a line's middle for orthogonal lines) must lie within range of the caster's centre.
  const placedInRange = placed => {
    const angle = (placed.rotation ?? 0) * Math.PI / 180;
    const offset = orthogonal ? Number(placed.length) / 2 : 0;
    const x = placed.x + Math.cos(angle) * offset;
    const y = placed.y + Math.sin(angle) * offset;
    return Math.hypot(x - casterToken.center.x, y - casterToken.center.y) <= range * unit + 1e-6;
  };
  // While placing: a ring around the caster shows the range, green while the area is in range, red when not.
  const ring = range > 0 ? createRangeRing(casterToken, { meters: range, touch: false }, { fromCenter: true }) : null;
  ring?.setOk(placedInRange(shape));
  const preview = await canvas.regions.placeRegion(data, {
    create: false,
    allowRotation: shape.type === "line" && !fromCaster && !orthogonal,
    onChange: ring ? ({ shape: placed }) => ring.setOk(placedInRange(placed)) : undefined,
    preConfirm: range > 0 ? ({ shape: placed }) => {
      if (placedInRange(placed)) return;
      ui.notifications.warn(game.i18n.format("INCARNOS.SpellArea.outOfRange", { name: item.name, range }));
      return false;
    } : undefined,
    onMove: fromCaster ? ({ shape: placed, position }) => {
      const center = casterToken.center;
      const changes = { x: center.x, y: center.y };
      if (placed.type === "line") changes.rotation = Math.toDegrees(Math.atan2(position.y - center.y, position.x - center.x));
      placed.updateSource(changes);
      return false;
    } : orthogonal ? ({ shape: placed, position }) => {
      const angle = Math.atan2(position.y - casterToken.center.y, position.x - casterToken.center.x) + Math.PI / 2;
      placed.updateSource({ x: position.x - Math.cos(angle) * placed.length / 2,
        y: position.y - Math.sin(angle) * placed.length / 2, rotation: angle * 180 / Math.PI });
      return false;
    } : undefined
  });
  ring?.destroy();
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
