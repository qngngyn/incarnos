/**
 * Entertainer's Curse (Shadow + Blood signature spell).
 *
 * - Cast (spell-cast.mjs): every enemy on the stage gets Entertainer's Cursed (remembering the caster), and the caster
 *   remembers the stage in flags.incarnos.stageCurse.
 * - Each time a cursed creature loses HP, its caster gains 1 Applause token.
 * - At the start of the caster's next turn, the finale attacks every cursed creature for 1d4 per Applause + lvl × 4
 *   fire damage and ends the curse. No hit: the caster drinks alone and becomes Invulnerable for 3 turns.
 * - Afterparty (until the start of the caster's turn after that): every friendly creature at the bar (1.5m around the
 *   stage centre) heals 1d4 per Applause, once.
 * Everything that writes runs on the caster's writer client (the first active GM).
 */
import { advantageFormula, applyAttackConditions, applyHealthChange, conditionAdvantage, conditionTokens, isWriter,
  setConditionTokens, shadowcloneCheck, statusEffect } from "./conditions.mjs";
import { getSpellAttackThreshold, rollUnderSucceeds } from "./spells.mjs";
import { renderSpellCard } from "./spell-card.mjs";
import { relationTo } from "./spell-targets.mjs";

export const CURSE_ID = "entertainer-s-cursed";
export const BAR_RADIUS = 1.5;
export const ALONE_INVULNERABLE = 3;

/** The spell's text: enemies on a stage are cursed until a finale that pays out Applause. */
export const isStageCurse = system => /\bcursed until the finale\b/i.test(String(system?.effect ?? ""))
  && /\bapplause\b/i.test(String(system?.effect ?? ""));

/** Finale damage: 1d4 per Applause + lvl × 4 (no Applause: just lvl × 4). */
export const finaleFormula = (applause, lvl) => {
  const flat = Math.max(0, Number(lvl) || 0) * 4;
  return applause > 0 ? `${applause}d4 + ${flat}` : `${flat}`;
};

/** Afterparty healing: 1d4 per Applause, nothing without Applause. */
export const afterpartyFormula = applause => (applause > 0 ? `${applause}d4` : null);

/** At the bar: the token's centre within the bar's radius around the stage centre (half a square of leeway). */
export const atBar = (stage, center, pixelsPerMeter, gridMeters = 1.5) =>
  Math.hypot(center.x - stage.x, center.y - stage.y) <= (BAR_RADIUS + gridMeters / 2) * pixelsPerMeter + 1e-6;

/* -------------------------------------------- */

const stageOf = actor => actor?.getFlag?.("incarnos", "stageCurse") ?? null;

const tokenCenter = doc => {
  const size = doc.parent?.grid?.size ?? canvas?.grid?.size ?? 100;
  return { x: doc.x + (doc.width ?? 1) * size / 2, y: doc.y + (doc.height ?? 1) * size / 2 };
};

const pixelsPerMeter = scene => (scene?.grid?.size ?? 100) / (Number(scene?.grid?.distance) || 1.5);

/** The token of the caster on the stage's scene (for sides: friendly = same disposition). */
const casterTokenOn = (actor, scene) => scene?.tokens?.find(doc => doc.actor === actor || doc.actorId === actor.id) ?? null;

/** Cursed creatures of this caster on the scene: one entry per actor. */
function cursedBy(actor, scene) {
  const seen = new Set();
  return (scene?.tokens ?? []).filter(doc => {
    const target = doc.actor;
    if (!target || seen.has(target.uuid)) return false;
    if (statusEffect(target, CURSE_ID)?.getFlag("incarnos", "curseBy") !== actor.uuid) return false;
    seen.add(target.uuid);
    return true;
  });
}

// Applause is counted one after another, so two hits at once both count.
let applauseQueue = Promise.resolve();
const addApplause = caster => (applauseQueue = applauseQueue
  .then(() => setConditionTokens(caster, "applause", conditionTokens(caster, "applause") + 1))
  .catch(error => console.error("Incarnos | applause", error)));

/** Start of the caster's turn: the finale, or the end of the afterparty. */
export async function stageTurnStart(actor) {
  const stage = stageOf(actor);
  if (!stage) return;
  if (stage.phase === "finale") return runFinale(actor, stage);
  return endStage(actor, stage);
}

async function runFinale(actor, stage) {
  const scene = game.scenes.get(stage.sceneId);
  const casterDoc = casterTokenOn(actor, scene);
  const applause = conditionTokens(actor, "applause");
  const formula = finaleFormula(applause, stage.lvl);
  const advantage = conditionAdvantage(actor.statuses ?? new Set(), "attack");
  const rolls = [];
  const roll = async (f, options) => { const r = await new Roll(f).evaluate(options); rolls.push(r); return r; };
  const results = [];
  const cursed = cursedBy(actor, scene);
  for (const doc of cursed) {
    const target = doc.actor;
    const result = { name: doc.name, img: doc.texture?.src ?? target.img, uuid: target.uuid, hit: false, saved: false, damage: 0, heal: 0, conditions: [] };
    const d20 = (await roll(advantageFormula(advantage.delta))).total;
    const threshold = getSpellAttackThreshold(stage.attackValue, target.system.attributes?.parry?.value, 0);
    result.attack = { d20, threshold };
    result.hit = rollUnderSucceeds(d20, threshold);
    result.crit = d20 === 1;
    const clone = result.hit ? await shadowcloneCheck(target, roll) : null;
    if (clone) {
      result.clone = { d20: clone.d20, diverted: clone.diverted };
      if (clone.diverted) { result.hit = false; result.crit = false; }
    }
    if (result.hit) result.damage = (await roll(formula, result.crit ? { maximize: true } : undefined)).total;
    results.push(result);
  }
  const hits = results.filter(result => result.hit);
  // The finale's damage still counts for Applause (the targets are cursed while it lands).
  for (const [index, result] of results.entries()) {
    if (!result.damage) continue;
    const target = await fromUuid(result.uuid);
    if (target) await applyHealthChange(target, `stage-${stage.id}-finale-${index}`, "damage", result.damage);
  }
  await applauseQueue;
  for (const doc of cursed) await statusEffect(doc.actor, CURSE_ID)?.delete();

  const auto = { attackStat: "intcha", damage: formula, damageType: "fire" };
  const content = renderSpellCard({ name: `${stage.itemName}: Finale`, img: stage.img, system: {}, auto, results,
    attackLabel: `Attack (Int / Cha ${stage.attackValue} + Parry modifier)` });
  await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content,
    rolls: rolls.map(r => r.toJSON()), sound: rolls.length ? CONFIG.sounds.dice : undefined,
    flags: { incarnos: { spellCast: { itemName: stage.itemName, resolved: true, targets: results.map(({ name, uuid, damage }) =>
      ({ name, uuid, damage, heal: 0, conditions: [], appliedDamage: true, appliedHeal: true })) } } } });

  if (!hits.length) {
    // Nobody came to the party: drinking alone makes the caster Invulnerable instead of the afterparty.
    await applyAttackConditions(actor, [{ id: "invulnerable", tokens: ALONE_INVULNERABLE }]);
    await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }),
      content: `<p>${escapeText(game.i18n.format("INCARNOS.Stage.alone", { name: actor.name, turns: ALONE_INVULNERABLE }))}</p>` });
    return endStage(actor, stage);
  }
  await actor.setFlag("incarnos", "stageCurse", { ...stage, phase: "afterparty", healed: [] });
  // Friendlies already at the bar (the caster on the stage too) heal right away.
  if (scene && casterDoc) for (const doc of scene.tokens) await afterpartyCheck(actor, doc);
}

/** Afterparty: heal a friendly token at the bar once. */
async function afterpartyCheck(caster, doc) {
  const stage = stageOf(caster);
  if (stage?.phase !== "afterparty" || doc.parent?.id !== stage.sceneId || !doc.actor?.system?.health || doc.hidden) return;
  if (stage.healed?.includes(doc.actor.uuid)) return;
  const casterDoc = casterTokenOn(caster, doc.parent);
  const relation = relationTo({ actor: caster, token: casterDoc?.object ?? (casterDoc ? { id: casterDoc.id, document: casterDoc } : null) },
    doc.object ?? { id: doc.id, actor: doc.actor, document: doc });
  if (!["self", "ally"].includes(relation)) return;
  if (!atBar(stage, tokenCenter(doc), pixelsPerMeter(doc.parent), Number(doc.parent?.grid?.distance) || 1.5)) return;
  const formula = afterpartyFormula(conditionTokens(caster, "applause"));
  await caster.setFlag("incarnos", "stageCurse", { ...stage, healed: [...(stage.healed ?? []), doc.actor.uuid] });
  if (!formula) return;
  const heal = await new Roll(formula).evaluate();
  await applyHealthChange(doc.actor, `stage-${stage.id}-bar-${doc.actor.id}`, "heal", heal.total);
  await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: caster }), rolls: [heal.toJSON()],
    content: `<p>${escapeText(game.i18n.format("INCARNOS.Stage.afterparty", { name: doc.name, amount: heal.total, formula: heal.formula }))}</p>` });
}

/** The spell ends: Applause, the curse and the stage go away. */
async function endStage(actor, stage) {
  const scene = game.scenes.get(stage.sceneId);
  for (const doc of cursedBy(actor, scene)) await statusEffect(doc.actor, CURSE_ID)?.delete();
  await setConditionTokens(actor, "applause", 0);
  if (stage.regionUuid) await (await fromUuid(stage.regionUuid))?.delete().catch(() => null);
  await actor.unsetFlag("incarnos", "stageCurse");
}

const escapeText = text => String(text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const handledTurns = new WeakMap();

export function registerStageHooks() {
  // Applause: a cursed creature lost HP.
  Hooks.on("updateActor", (actor, changes, options) => {
    if (options.incarnosHealthBefore === undefined) return;
    if (!(Number(actor.system.health?.value ?? 0) < options.incarnosHealthBefore)) return;
    const by = statusEffect(actor, CURSE_ID)?.getFlag("incarnos", "curseBy");
    const caster = by ? fromUuidSync(by) : null;
    if (caster && isWriter(caster)) addApplause(caster);
  });
  // The finale at the start of the caster's next turn, the end of the afterparty one turn later.
  Hooks.on("combatTurnChange", (combat, prior, current) => {
    if (!current?.combatantId || !(current.round > 0)) return;
    const forward = !prior || current.round > prior.round || (current.round === prior.round && current.turn > prior.turn);
    const signature = `${current.round}:${current.turn}:${current.combatantId}`;
    if (!forward || handledTurns.get(combat) === signature) return;
    handledTurns.set(combat, signature);
    const actor = combat.combatants.get(current.combatantId)?.actor;
    if (actor && stageOf(actor) && isWriter(actor)) void stageTurnStart(actor).catch(error => console.error("Incarnos | Entertainer's Curse", error));
  });
  // Afterparty: a friendly walks up to the bar.
  Hooks.on("updateToken", (doc, changes) => {
    if (!("x" in changes || "y" in changes)) return;
    for (const caster of stageCasters()) {
      if (isWriter(caster)) void afterpartyCheck(caster, doc).catch(error => console.error("Incarnos | afterparty", error));
    }
  });
}

/** Actors with a running Entertainer's Curse in its afterparty (world actors and unlinked scene tokens). */
function stageCasters() {
  const actors = new Set(game.actors?.filter(actor => stageOf(actor)?.phase === "afterparty") ?? []);
  for (const doc of canvas?.scene?.tokens ?? []) if (doc.actor && stageOf(doc.actor)?.phase === "afterparty") actors.add(doc.actor);
  return actors;
}
