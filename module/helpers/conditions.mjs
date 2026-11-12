/**
 * Incarnos conditions as Foundry status effects. The list comes from the vault (System Files/Listen/Conditions,
 * imported into module/data/conditions.mjs by tools/import-conditions.mjs).
 *
 * Automation:
 * Tokens are the stack counter of the "Status Icon Counters" module (left click adds, right click removes); no popups.
 * - Burn, Poisoned, Bleed, Regenerating: at the start of the actor's turn they lose 1 token and offer their damage
 *   (1 per token) or healing (the amount the source fixed) in a private chat prompt the owner applies. Bleed is
 *   removed by any healing.
 * - Asleep: every action point spent removes 1 token; damage halves them (min. 2).
 * - Hidden: advantage on attacks and Parry. Hindered: disadvantage on the next attack, then it ends.
 *   Prone: a Parry roll shows both cases, against melee (disadvantage) and against ranged (advantage).
 * - Grappled: players can't move the token (the GM still can).
 * Intimidated, Taunted and Mounted stay as text (they depend on who the other creature is).
 */
import { CONDITIONS } from "../data/conditions.mjs";
import { getActionState } from "./action-tracker.mjs";
import { amount, chip, escape, renderRollCard } from "./roll-card.mjs";
import { getHealthAfter } from "./spells.mjs";
import { gridOptions, squaresBetween, tokenDistance } from "./spell-range.mjs";
import { deathSaveReminderHTML, handleDyingHealth } from "./death-saves.mjs";
import { npcHealthTransition } from "./death-save-rules.mjs";

export const DAMAGE_TOKEN_CONDITIONS = ["burn", "poisoned", "bleed"];
export const conditionById = id => CONDITIONS.find(condition => condition.id === id);

/* -------------------------------------------- */
/*  Rules (pure)                                */
/* -------------------------------------------- */

/** Start of turn with damage tokens: 1 damage per token, then one token less. */
export const tickDamageTokens = tokens => ({ damage: Math.max(0, tokens), remaining: Math.max(0, tokens - 1) });

/** Barrier: an HP loss is ignored completely while the creature has a Barrier (unless the update says to skip it). */
export const barrierAbsorbs = (before, after, hasBarrier, ignore = false, damage = false) =>
  Boolean(hasBarrier) && !ignore && (Number(after) < Number(before) || Boolean(damage));

/** Invulnerable: no HP loss at all (and no damage instance at 0 HP) while the creature has it. */
export const invulnerableBlocks = (before, after, invulnerable, damage = false) =>
  Boolean(invulnerable) && (Number(after) < Number(before) || Boolean(damage));

/** AP at the start of a turn: Stunned leaves none, Paralyzed takes 1. */
export const actionsAfterTurnStart = (value, { stunned = false, paralyzed = false } = {}) =>
  stunned ? 0 : Math.max(0, Number(value) - (paralyzed ? 1 : 0));

/** Asleep: every action point spent removes one sleep token. */
export const asleepAfterActions = (tokens, spent) => Math.max(0, tokens - Math.max(0, spent));

/**
 * Prone Parry without asking: roll enough d20s and read both cases. Against melee it is disadvantage, against ranged
 * advantage; Hidden and Dodge each add advantage to both.
 * @param {number[]} dice  d20 results (2 plus the number of advantage sources).
 * @param {number|boolean} advantage  Number of advantage sources (legacy Hidden boolean also works).
 * @returns {{melee: number, ranged: number}}
 */
export function proneParry(dice, advantage = 0) {
  const extra = Number(advantage);
  return { melee: extra ? Math.min(...dice.slice(0, extra)) : Math.max(...dice), ranged: Math.min(...dice) };
}

/** Damage while asleep: lose half the sleep tokens, rounded down, but at least 2 (9 -> 4, 3 -> 1, 2 -> 0). */
export const asleepAfterDamage = tokens => Math.max(0, Math.min(Math.floor(tokens / 2), tokens - 2));

/**
 * Advantage from conditions: +1 advantage, −1 disadvantage; they cancel.
 * @param {Set<string>|string[]} statuses
 * @param {"attack"|"parry"} kind
 * @param {"melee"|"ranged"|null} [against]  For Parry: the kind of attack being parried (Prone).
 * @returns {{delta: number, sources: string[]}}
 */
export function conditionAdvantage(statuses, kind, against = null, { dodge = false } = {}) {
  const has = id => (statuses instanceof Set ? statuses.has(id) : statuses?.includes?.(id));
  let delta = 0;
  const sources = [];
  if (has("hidden")) { delta += 1; sources.push("Hidden"); }
  if (kind === "parry" && dodge) { delta += 1; sources.push("Dodge"); }
  if (kind === "attack" && has("hindered")) { delta -= 1; sources.push("Hindered"); }
  // Blinded: disadvantage on attacks, Parry rolls and saving throws.
  if (["attack", "parry", "save"].includes(kind) && has("blinded")) { delta -= 1; sources.push("Blinded"); }
  if (kind === "parry" && has("prone") && against) { delta += against === "ranged" ? 1 : -1; sources.push("Prone"); }
  return { delta, sources };
}

const ALIASES = { poison: "poisoned", bleeding: "bleed", burning: "burn", sleep: "asleep" };

/**
 * Conditions an attack applies on a hit: weapon trait lines that are only a condition, with dice for token
 * conditions ("Burn D4", "Poisoned d4", "Prone"). Trait lines with a description ("Name: text") never count,
 * so a trait that merely mentions a condition doesn't apply it.
 * @returns {{id: string, name: string, dice: string|null}[]}
 */
export function parseAttackConditions(traits = "") {
  const found = [];
  for (const entry of String(traits ?? "").split(/\n|,/).map(part => part.trim()).filter(Boolean)) {
    const match = entry.match(/^([A-Za-z]+)(?:\s+(\d*[dD]\d+|\d+))?$/);
    const id = match && (ALIASES[match[1].toLowerCase()] ?? match[1].toLowerCase());
    const condition = id && conditionById(id);
    if (condition && !found.some(item => item.id === id)) found.push({ id, name: condition.name,
      dice: condition.tokens && (id !== "immobilized" || match[2]) ? (match[2] ?? "1").toLowerCase() : null,
      ...(id === "immobilized" ? { timed: Boolean(match[2]) } : {}) });
  }
  return found;
}

/** d20 formula for an advantage delta: 2d20kl for advantage, 2d20kh for disadvantage. */
export const advantageFormula = delta => (delta > 0 ? `${delta + 1}d20kl` : delta < 0 ? `${1 - delta}d20kh` : "1d20");

/* -------------------------------------------- */
/*  Foundry                                     */
/* -------------------------------------------- */

/** Spare statuses for conditions that don't exist yet; rename the effect on the actor when you use one. */
export const SPARE_STATUSES = [
  { id: "custom-1", name: "Custom 1", img: "icons/svg/card-joker.svg" },
  { id: "custom-2", name: "Custom 2", img: "icons/svg/aura.svg" },
  { id: "custom-3", name: "Custom 3", img: "icons/svg/hazard.svg" }
];

/**
 * Fixed order of the conditions in the token HUD, one group per row of 7 (css/incarnos.css):
 * 1. position, movement and sight · 2. mind and actions · 3. over time and protection · 4. summoned and down
 * (then Defeated and the spare statuses). A condition missing here (new in the vault) follows alphabetically.
 */
export const CONDITION_ORDER = [
  "prone", "grappled", "immobilized", "mounted", "hidden", "hindered", "blinded",
  "taunted", "frenzied", "intimidated", "asleep", "paralyzed", "stunned", "charged", "shadowmarked",
  "burn", "poisoned", "bleed", "regenerating", "barrier", "shadowform", "shadowclone",
  "summoned", "dying", "unconscious", "invulnerable", "entertainer-s-cursed", "applause"
];

export const sortConditions = conditions => [...conditions].sort((a, b) => {
  const rank = id => (CONDITION_ORDER.includes(id) ? CONDITION_ORDER.indexOf(id) : CONDITION_ORDER.length);
  return rank(a.id) - rank(b.id) || a.name.localeCompare(b.name);
});

/**
 * Replace Foundry's default status effects. The token HUD sorts by `order`: the Incarnos conditions come first
 * (CONDITION_ORDER), then Defeated (for the combat tracker) and the three spare statuses.
 */
export function statusEffectList() {
  return [
    ...sortConditions(CONDITIONS).map(({ id, name, img, description }, index) => ({ id, name, img, description, order: index + 1 })),
    { id: "dead", name: "Defeated", img: "icons/svg/skull.svg", order: 100 },
    ...SPARE_STATUSES.map((status, index) => ({ ...status, order: 101 + index }))
  ];
}

export function configureStatusEffects() {
  CONFIG.statusEffects = statusEffectList();
  CONFIG.specialStatusEffects.DEFEATED = "dead";
}

/** Status ids that are not in the current list (e.g. Foundry's defaults from before): effects made only of these go. */
export const unknownStatusEffect = (effect, knownIds) => effect.statuses?.size > 0 && [...effect.statuses].every(id => !knownIds.has(id));

/**
 * Once per world (GM): remove status effects left over from Foundry's default list (Stunned, Bleeding, Burning, …)
 * from world actors and from unlinked tokens on every scene. Other active effects stay.
 */
export async function removeOldStatusEffects() {
  if (!game.user.isGM || game.settings.get("incarnos", "statusEffectsMigrated") >= 1) return;
  const known = new Set(CONFIG.statusEffects.map(status => status.id));
  const actors = [...game.actors, ...game.scenes.contents.flatMap(scene => scene.tokens.filter(token => !token.actorLink && token.actor).map(token => token.actor))];
  let removed = 0;
  for (const actor of actors) {
    const ids = actor.effects.filter(effect => unknownStatusEffect(effect, known)).map(effect => effect.id);
    if (!ids.length) continue;
    await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
    removed += ids.length;
  }
  await game.settings.set("incarnos", "statusEffectsMigrated", 1);
  if (removed) ui.notifications.info(`Incarnos: removed ${removed} old status effect${removed === 1 ? "" : "s"} from before the Incarnos conditions.`);
}

export const statusEffect = (actor, id) => actor?.effects?.find(effect => effect.statuses?.has(id));

/**
 * Tokens of a condition = the stack counter of the "Status Icon Counters" module (left click on the status adds one,
 * right click removes one). Its value lives in flags.statuscounter.value; a status without a value counts as 1.
 */
export function conditionTokens(actor, id) {
  const effect = statusEffect(actor, id);
  if (!effect) return 0;
  const value = effect.statusCounter?.displayValue ?? effect.getFlag("statuscounter", "value") ?? 1;
  return Math.max(0, Number(value) || 0);
}

/** Set an actor's tokens of a condition (the status counter); 0 removes the condition. */
export async function setConditionTokens(actor, id, count) {
  if (!conditionById(id)) return;
  let effect = statusEffect(actor, id);
  if (count <= 0) return effect?.delete();
  if (!effect) {
    await actor.toggleStatusEffect(id, { active: true });
    // Foundry's activation API can return true instead of an ActiveEffect.
    // Always use the actor's current document, including its cached status counter.
    effect = statusEffect(actor, id);
  }
  if (!effect) return;
  // The module keeps the counter badge in step; without it the value is stored where the module would read it.
  if (effect.statusCounter?.setValue) return effect.statusCounter.setValue(count);
  return effect.update({ "flags.statuscounter.value": count, "flags.statuscounter.visible": count > 1 });
}

/** Add tokens (a number or a formula like "1d4") to an actor's condition. Returns the tokens added. */
export async function addConditionTokens(actor, id, amountOrFormula) {
  const added = typeof amountOrFormula === "number" ? amountOrFormula
    : (await new Roll(String(amountOrFormula)).evaluate()).total;
  await setConditionTokens(actor, id, conditionTokens(actor, id) + Math.max(0, added));
  return added;
}

/** The one client that writes for an actor: the first active GM, else an active owner (as the action tracker does). */
export function isWriter(actor) {
  const gm = [...game.users].filter(user => user.active && user.isGM).sort((a, b) => a.id.localeCompare(b.id))[0];
  if (gm) return gm.id === game.user.id;
  const owner = [...game.users].filter(user => user.active && actor.testUserPermission(user, "OWNER")).sort((a, b) => a.id.localeCompare(b.id))[0];
  return owner?.id === game.user.id;
}

/** Regenerating without a source formula (set by hand) heals 1d6 + the creature's own level. */
export const defaultRegenFormula = level => `1d6 + ${Math.max(0, Number(level) || 0)}`;

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Expire action conditions after the next turn and count down source-timed Immobilized. HUD durations stay manual. */
export async function endOfTurn(actor, turn = null) {
  for (const effect of [...(actor.effects ?? [])]) {
    if (effect.getFlag("incarnos", "untilEndOfTurn") === true
      && (!turn || effect.getFlag("incarnos", "appliedTurn") !== turn)) await effect.delete();
  }
  if (statusEffect(actor, "immobilized")?.getFlag("incarnos", "timed") === true) {
    await setConditionTokens(actor, "immobilized", conditionTokens(actor, "immobilized") - 1);
  }
  // Blinded, Shadowmarked, Shadowform count their turns down at the end of the holder's turn.
  // One gained during the holder's own turn (Invulnerable from the finale at its start) skips that turn's tick,
  // so "3 turns" are 3 full turns.
  for (const id of TURN_COUNTDOWN_CONDITIONS) {
    const effect = statusEffect(actor, id);
    if (!effect) continue;
    if (effect.getFlag("incarnos", "skipTick") === true) { await effect.unsetFlag("incarnos", "skipTick"); continue; }
    await setConditionTokens(actor, id, conditionTokens(actor, id) - 1);
  }
  // Charged's extra action lasts only for the turn it was gained in.
  if (actor.getFlag?.("incarnos", "extraActions")) await actor.unsetFlag("incarnos", "extraActions");
}

/** Conditions whose tokens are turns, counted down at the end of the holder's turn; a new source keeps the longer one. */
export const TURN_COUNTDOWN_CONDITIONS = ["blinded", "shadowmarked", "shadowform", "shadowclone", "invulnerable"];

/**
 * Frenzied: for each action, a random creature within reach to attack; nobody in reach → the nearest to move to.
 * @param {{name: string}[]} inReach  Creatures within reach (not the frenzied one).
 * @param {number} actions  Actions this turn.
 * @param {{name: string}|null} nearest  The nearest creature when nobody is in reach.
 * @param {() => number} [random]
 * @returns {{attacks: string[], moveTo: string|null}}
 */
export function frenziedPlan(inReach, actions, nearest = null, random = Math.random) {
  if (!inReach.length) return { attacks: [], moveTo: nearest?.name ?? null };
  return { attacks: Array.from({ length: Math.max(0, actions) }, () => inReach[Math.floor(random() * inReach.length)].name), moveTo: null };
}

/** GM-only section of the start-of-turn card for a Frenzied creature: whom each action attacks. */
function frenziedReminderHTML(actor) {
  const token = actor.getActiveTokens?.()[0];
  const others = (globalThis.canvas?.tokens?.placeables ?? []).filter(other => other !== token && other.actor && !other.document.hidden);
  const options = gridOptions();
  const inReach = token ? others.filter(other => squaresBetween(token, other, options.gridSize) <= 0) : [];
  const nearest = token && others.length
    ? others.map(other => ({ other, d: tokenDistance(token, other, options) })).sort((a, b) => a.d - b.d)[0].other : null;
  const plan = frenziedPlan(inReach, getActionState(actor).value, nearest);
  const text = plan.attacks.length
    ? game.i18n.format("INCARNOS.Conditions.frenziedAttacks", { name: actor.name, list: plan.attacks.map((name, index) => `${index + 1}. ${name}`).join(", ") })
    : game.i18n.format(plan.moveTo ? "INCARNOS.Conditions.frenziedMove" : "INCARNOS.Conditions.frenziedNobody", { name: actor.name, target: plan.moveTo ?? "" });
  return `<p><strong>${escape(game.i18n.localize("INCARNOS.Conditions.frenziedTitle"))}</strong> ${escape(text)}</p>`;
}

/** Shadowclone: an attack against the holder hits the clone instead on a d20 of this or lower. */
export const SHADOWCLONE_DIVERT = 9;

/**
 * Shadowclone check for an attack against an actor: a d20, and whether the clone takes the attack.
 * @param {Actor} actor  The attacked creature.
 * @param {Function} [roll]  formula => evaluated Roll (the attack's own roller, so the die shows with the attack).
 * @returns {Promise<{d20: number, diverted: boolean, roll: Roll}|null>}  null when the actor has no clone.
 */
export async function shadowcloneCheck(actor, roll = formula => new Roll(formula).evaluate()) {
  if (!actor?.statuses?.has("shadowclone")) return null;
  const result = await roll("1d20");
  return { d20: result.total, diverted: result.total <= SHADOWCLONE_DIVERT, roll: result };
}

/** Add actions for this turn only (Charged, Shadowclone): the AP maximum rises with them until the turn ends. */
export async function grantExtraAction(actor, count = 1) {
  await actor.setFlag("incarnos", "extraActions", (Number(actor.getFlag("incarnos", "extraActions")) || 0) + count);
  await actor.update({ "system.actionpoints.value": getActionState(actor).value + count }, { incarnosParalyzed: true });
}

/**
 * Start of a combatant's turn, as one private chat window (owners and GMs):
 * - token conditions count down: Burn, Poisoned, Bleed deal 1 damage per token (or their source's roll) at once;
 *   Regenerating heals the amount its source fixed (Leaf wind: "1d6 + (2 * 1)"), or 1d6 + own level, with an Apply button;
 * - every other active condition is listed with what it does (Asleep with its tokens, Prone, Grappled, …).
 */
export async function startOfTurn(actor) {
  await consumeDodge(actor);
  // Stunned (no actions) and Paralyzed (1 action less) take effect this turn, after the AP refill at the end of the last
  // turn, then end; neither stacks.
  // Charged: one token gives 1 additional action this turn (the AP maximum rises for this turn only).
  const charged = conditionTokens(actor, "charged");
  if (statusEffect(actor, "charged") && charged > 0) {
    await grantExtraAction(actor, 1);
    await setConditionTokens(actor, "charged", charged - 1);
  }
  const paralyzed = statusEffect(actor, "paralyzed");
  const stunned = statusEffect(actor, "stunned");
  if (paralyzed || stunned) {
    const value = actionsAfterTurnStart(getActionState(actor).value, { stunned: Boolean(stunned), paralyzed: Boolean(paralyzed) });
    await actor.update({ "system.actionpoints.value": value }, { incarnosParalyzed: true });
    await stunned?.delete();
    await paralyzed?.delete();
  }
  const entries = [];
  for (const id of DAMAGE_TOKEN_CONDITIONS) {
    const tokens = conditionTokens(actor, id);
    if (!statusEffect(actor, id) || tokens <= 0) continue;
    // A source with its own damage per turn (Bloody Claws: "2d6 … for 3 turns") rolls it; tokens count the turns left.
    const formula = statusEffect(actor, id).getFlag("incarnos", "damage");
    if (formula) {
      const roll = await new Roll(String(formula)).evaluate();
      entries.push({ condition: id, kind: "damage", amount: roll.total, formula: `${roll.formula} = ${roll.result}`,
        text: `${roll.total} damage (${roll.formula}). ${tokens - 1 ? `${plural(tokens - 1, "turn")} left.` : "It ends."}` });
      await setConditionTokens(actor, id, tokens - 1);
      continue;
    }
    const tick = tickDamageTokens(tokens);
    entries.push({ condition: id, kind: "damage", amount: tick.damage,
      text: `${tick.damage} damage (1 per token). ${tick.remaining ? `${plural(tick.remaining, "token")} left.` : "It ends."}` });
    await setConditionTokens(actor, id, tick.remaining);
  }
  const regen = conditionTokens(actor, "regenerating");
  if (statusEffect(actor, "regenerating") && regen > 0) {
    const stored = statusEffect(actor, "regenerating").getFlag("incarnos", "heal");
    const formula = stored || defaultRegenFormula(actor.system.attributes?.level?.value);
    const roll = await new Roll(String(formula)).evaluate();
    entries.push({ condition: "regenerating", kind: "heal", amount: roll.total, formula: `${roll.formula} = ${roll.result}`,
      text: `Heals ${roll.total} (${roll.formula}${stored ? "" : ", your level"}). ${regen - 1 ? `${plural(regen - 1, "turn")} left.` : "It ends."}` });
    await setConditionTokens(actor, "regenerating", regen - 1);
  }
  // Everything else that is active right now, as a reminder.
  const infos = [];
  for (const condition of CONDITIONS) {
    if (DAMAGE_TOKEN_CONDITIONS.includes(condition.id) || condition.id === "regenerating" || !statusEffect(actor, condition.id)) continue;
    const tokens = condition.tokens && (condition.id !== "immobilized" || statusEffect(actor, condition.id).getFlag("incarnos", "timed") === true)
      ? conditionTokens(actor, condition.id) : 0;
    infos.push({ condition: condition.id, text: `${tokens ? `${plural(tokens, "token")}. ` : ""}${condition.description}` });
  }
  if (paralyzed) infos.unshift({ condition: "paralyzed", text: "You lose 1 action this turn. Paralyzed ends." });
  if (stunned) infos.unshift({ condition: "stunned", text: "You lose all your actions this turn. Stunned ends." });
  if (charged > 0) infos.splice(0, infos.length, ...infos.filter(info => info.condition !== "charged"));
  if (charged > 0) infos.unshift({ condition: "charged", text: `You have 1 additional action this turn. ${charged - 1 ? `${plural(charged - 1, "token")} left.` : "Charged ends."}` });
  // Taunted names its taunter when a spell put it on.
  const taunter = statusEffect(actor, "taunted")?.getFlag("incarnos", "by");
  const taunted = infos.find(info => info.condition === "taunted");
  if (taunted && taunter) taunted.text = `Your attacks must be targeted against ${taunter}. Ends at the end of this turn.`;
  if (!entries.length && !infos.length) return;
  const notes = statusEffect(actor, "burn") ? ["Burn: 1 AP to put out the flames (or water) removes all Burn tokens."] : [];
  // Burn, Poisoned and Bleed hit by themselves (no Apply button); only bleeding to 0 HP kills (other 0 HP: the table's rules).
  let bledOut = false;
  for (const entry of entries.filter(entry => AUTO_DAMAGE_CONDITIONS.includes(entry.condition) && entry.amount > 0)) {
    const before = Number(actor.system.health?.value ?? 0);
    const after = getHealthAfter(actor.system.health, entry.amount, "damage");
    const options = { incarnosHandledHealth: true, incarnosDamage: true,
      incarnosDyingBefore: actor.statuses?.has("dying"), incarnosBledOut: entry.condition === "bleed" && after <= 0 };
    const hadBarrier = Boolean(statusEffect(actor, "barrier"));
    await actor.update({ "system.health.value": after }, options);
    // A Barrier may have ignored the damage: go by the HP the actor really has now.
    const actual = Number(actor.system.health?.value ?? 0);
    const absorbed = hadBarrier && actual >= before;
    await handleDyingHealth(actor, before, actual, absorbed ? { ...options, incarnosDamage: false, incarnosBledOut: false } : options);
    entry.applied = true;
    if (absorbed) entry.text += " A Barrier ignored it.";
    if (entry.condition === "bleed" && Number(actor.system.health?.value) <= 0) bledOut = true;
  }
  if (bledOut) {
    await markDead(actor);
    notes.unshift(`${actor.name} bled out and is dead.`);
  }
  // Barrier (still up after this turn's damage): its source's healing per turn (Bubblebarrier 1d4), then one turn less.
  const barrier = conditionTokens(actor, "barrier");
  if (statusEffect(actor, "barrier") && barrier > 0) {
    const heal = statusEffect(actor, "barrier").getFlag("incarnos", "heal");
    if (heal) {
      const roll = await new Roll(String(heal)).evaluate();
      entries.push({ condition: "barrier", kind: "heal", amount: roll.total, formula: `${roll.formula} = ${roll.result}`,
        text: `Heals ${roll.total} (${roll.formula}). ${barrier - 1 ? `${plural(barrier - 1, "turn")} left.` : "The Barrier ends."}` });
    }
    await setConditionTokens(actor, "barrier", barrier - 1);
  }
  // Everything for this turn goes into one card; the GM's reminders (death save, Frenzied) are sections only GMs see.
  const deathSave = deathSaveReminderHTML(actor);
  const gmOnly = [deathSave, statusEffect(actor, "frenzied") ? frenziedReminderHTML(actor) : ""].filter(Boolean);
  return postHealthPrompt(actor, "Start of turn", entries, notes, infos, { gmOnly, deathSaveReminder: deathSave ? actor.uuid : null });
}

/** Damage-over-time conditions whose damage is dealt at once at the start of the turn instead of offered with Apply. */
export const AUTO_DAMAGE_CONDITIONS = ["burn", "poisoned", "bleed"];

/** Dead: Foundry's defeated status (skull overlay) on the actor and every combatant of it marked defeated. */
export async function markDead(actor) {
  await setConditionTokens(actor, "dying", 0);
  const dead = CONFIG.specialStatusEffects?.DEFEATED ?? "dead";
  if (!actor.statuses?.has(dead)) await actor.toggleStatusEffect(dead, { active: true, overlay: true });
  for (const combat of game.combats ?? []) {
    for (const combatant of combat.combatants ?? []) {
      if (combatant.actor === actor && !combatant.defeated) await combatant.update({ defeated: true });
    }
  }
}

/** Undo Dead: the skull and the combatants' defeated mark go away (an NPC healed back above 0 HP). */
export async function unmarkDead(actor) {
  const dead = CONFIG.specialStatusEffects?.DEFEATED ?? "dead";
  if (actor.statuses?.has(dead)) await actor.toggleStatusEffect(dead, { active: false });
  for (const combat of game.combats ?? []) {
    for (const combatant of combat.combatants ?? []) {
      if (combatant.actor === actor && combatant.defeated) await combatant.update({ defeated: false });
    }
  }
}

/** Users who see a private prompt for an actor: its owners and the GMs. */
const promptRecipients = actor => [...game.users].filter(user => user.isGM || actor.testUserPermission(user, "OWNER")).map(user => user.id);

/**
 * Private chat prompt for HP changes the owner applies themselves (with an Apply button per line).
 * @param {Actor} actor
 * @param {string} title
 * @param {{kind: "damage"|"heal", amount: number, text: string, condition?: string, formula?: string}[]} entries
 * @param {string[]} [notes]
 * @param {{condition: string, text: string}[]} [infos]  Other active conditions, listed without a button.
 * @param {{gmOnly?: string[], deathSaveReminder?: string|null}} [extra]  HTML sections only GMs see (removed for others
 *   when the card is shown), and the actor whose death save the reminder's button rolls.
 */
export async function postHealthPrompt(actor, title, entries, notes = [], infos = [], { gmOnly = [], deathSaveReminder = null } = {}) {
  const content = renderRollCard({
    icon: "fa-hourglass-start", title: escape(title), tags: escape(actor.name),
    rows: [
      ...entries.map((entry, index) => ({
        img: conditionById(entry.condition)?.img, name: conditionById(entry.condition)?.name ?? entry.kind,
        chips: [chip(entry.kind === "heal" ? "Heal" : "Damage", { tone: entry.kind === "heal" ? "good" : "bad", title: entry.formula || entry.text })],
        detail: entry.text,
        // Already dealt (Bleed): a check mark instead of the Apply button.
        values: entry.amount ? [amount(entry.amount, { kind: entry.kind }) + (entry.applied
          ? '<span class="isc-apply isc-done" title="Dealt automatically"><i class="fas fa-check"></i></span>' : healthPromptButton(entry, index))] : []
      })),
      ...infos.map(info => ({ img: conditionById(info.condition)?.img, name: conditionById(info.condition)?.name ?? info.condition, detail: info.text, values: [] }))
    ],
    notes: notes.map(note => `<span>${escape(note)}</span>`),
    action: gmOnly.map(html => `<div class="isc-gm-only" data-incarnos-gm-only>${html}</div>`).join("")
  });
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }), content, whisper: promptRecipients(actor),
    flags: { incarnos: { healthPrompt: { actorUuid: actor.uuid, entries }, ...(deathSaveReminder ? { deathSaveReminder } : {}) } }
  });
}

const healthPromptButton = (entry, index) => `<button type="button" class="isc-apply isc-apply-${entry.kind}" data-incarnos-health-apply="${index}" `
  + `title="${entry.kind === "heal" ? `Heal ${entry.amount}` : `Take ${entry.amount} damage`}"><i class="fas ${entry.kind === "heal" ? "fa-heart-circle-plus" : "fa-heart-crack"}"></i></button>`;

/** Applied prompt lines are remembered on the actor (owners can't edit the GM's chat message). */
export const promptApplied = (actor, key) => Boolean(actor?.getFlag("incarnos", "appliedPrompts")?.[key]);

/** Apply one HP line of a chat prompt to an actor and remember it. */
export async function applyHealthChange(actor, key, kind, amountValue, options = {}) {
  if (!actor?.system?.health || promptApplied(actor, key)) return false;
  const before = Number(actor.system.health.value ?? 0);
  const after = getHealthAfter(actor.system.health, amountValue, kind);
  const handleHere = actor.type === "character" && isWriter(actor);
  const healthOptions = { ...options, incarnosHealthBefore: before, incarnosDamage: kind === "damage" && amountValue > 0,
    incarnosDyingBefore: actor.statuses?.has("dying"), incarnosHandledHealth: handleHere };
  const hadBarrier = healthOptions.incarnosDamage && Boolean(statusEffect(actor, "barrier"));
  await actor.update({ "system.health.value": after,
    [`flags.incarnos.appliedPrompts.${key}`]: true }, healthOptions);
  // A Barrier may have ignored the damage: go by the HP the actor really has now, and it isn't a death save failure.
  const actual = Number(actor.system.health?.value ?? after);
  const absorbed = hadBarrier && actual >= before;
  if (handleHere) await handleDyingHealth(actor, before, actual, absorbed ? { ...healthOptions, incarnosDamage: false } : healthOptions);
  return true;
}

const handledTurns = new WeakMap();

export function registerConditionHooks() {
  Hooks.once("init", () => {
    configureStatusEffects();
    game.settings.register("incarnos", "statusEffectsMigrated", { scope: "world", config: false, type: Number, default: 0 });
  });
  Hooks.once("ready", () => { void removeOldStatusEffects().catch(error => console.error("Incarnos | old status effects", error)); });

  // HP prompts: the actor's owners (and GMs) apply each line themselves.
  Hooks.on("renderChatMessageHTML", (message, html) => {
    const prompt = message.flags?.incarnos?.healthPrompt;
    if (!prompt) return;
    // The GM's reminders in a start-of-turn card are for GMs only.
    if (!game.user.isGM) for (const section of html.querySelectorAll("[data-incarnos-gm-only]")) section.remove();
    const actor = fromUuidSync(prompt.actorUuid);
    for (const button of html.querySelectorAll("[data-incarnos-health-apply]")) {
      if (!actor || !(game.user.isGM || actor.isOwner)) { button.remove(); continue; }
      const index = Number(button.dataset.incarnosHealthApply);
      const entry = prompt.entries[index];
      const key = `${message.id}-${index}`;
      if (promptApplied(actor, key)) {
        button.disabled = true;
        button.classList.add("isc-done");
        button.innerHTML = '<i class="fas fa-check"></i>';
        continue;
      }
      button.addEventListener("click", async event => {
        event.preventDefault();
        button.disabled = true;
        try {
          await applyHealthChange(actor, key, entry.kind, entry.amount);
          ui.chat?.updateMessage?.(message);
        } catch (error) { console.error(error); button.disabled = false; }
      });
    }
  });

  // End the previous turn, then start the current one, once per forward transition and by each actor's writer.
  Hooks.on("combatTurnChange", (combat, prior, current) => {
    if (!current?.combatantId || !(current.round > 0)) return;
    const forward = !prior || current.round > prior.round || (current.round === prior.round && current.turn > prior.turn);
    const signature = `${current.round}:${current.turn}:${current.combatantId}`;
    if (!forward || handledTurns.get(combat) === signature) return;
    handledTurns.set(combat, signature);
    const previous = prior?.round > 0 ? combat.combatants.get(prior.combatantId)?.actor : null;
    const actor = combat.combatants.get(current.combatantId)?.actor;
    void (async () => {
      if (previous && isWriter(previous)) await endOfTurn(previous, `${combat.id}:${prior.round}:${prior.turn}`);
      if (actor && isWriter(actor)) await startOfTurn(actor);
    })().catch(error => console.error("Incarnos | turn conditions", error));
  });

  // Healing ends Bleed; damage halves sleep tokens; every action point spent while asleep removes a sleep token.
  Hooks.on("preUpdateActor", (actor, changes, options) => {
    if (foundry.utils.hasProperty(changes, "system.health.value")) {
      options.incarnosHealthBefore = Number(actor.system.health?.value ?? 0);
      options.incarnosDyingBefore = actor.statuses?.has("dying") ?? false;
      // Invulnerable: no damage at all, and the Barrier stays.
      if (invulnerableBlocks(options.incarnosHealthBefore, foundry.utils.getProperty(changes, "system.health.value"),
        statusEffect(actor, "invulnerable"), options.incarnosDamage)) {
        foundry.utils.setProperty(changes, "system.health.value", options.incarnosHealthBefore);
        options.incarnosDamage = false;
        options.incarnosIgnoreBarrier = true;
      }
      // Barrier: the next HP loss is ignored completely; the Barrier ends in updateActor.
      // (Damage at 0 HP is a damage instance too: the Apply buttons and turn damage say so with incarnosDamage.)
      if (barrierAbsorbs(options.incarnosHealthBefore, foundry.utils.getProperty(changes, "system.health.value"),
        statusEffect(actor, "barrier"), options.incarnosIgnoreBarrier, options.incarnosDamage)) {
        foundry.utils.setProperty(changes, "system.health.value", options.incarnosHealthBefore);
        // A changed flag keeps the update from being empty, so updateActor still runs and ends the Barrier.
        foundry.utils.setProperty(changes, "flags.incarnos.barrierPopped", Date.now());
        options.incarnosBarrierPopped = true;
        options.incarnosDamage = false;
      }
    }
    if (actor.type === "character" && actor.statuses?.has("dying") && foundry.utils.hasProperty(changes, "system.actionpoints.value")) {
      const value = Number(foundry.utils.getProperty(changes, "system.actionpoints.value"));
      foundry.utils.setProperty(changes, "system.actionpoints.value", Math.min(1, Math.max(0, value || 0)));
    }
    if (foundry.utils.hasProperty(changes, "system.actionpoints.value")) options.incarnosActionsBefore = getActionState(actor).value;
  });
  Hooks.on("updateActor", (actor, changes, options, userId) => {
    if (!options.incarnosHandledHealth && options.incarnosHealthBefore !== undefined && isWriter(actor)) {
      void handleDyingHealth(actor, options.incarnosHealthBefore, Number(actor.system.health?.value ?? 0), options)
        .catch(error => console.error("Incarnos | dying", error));
    }
    // NPCs at 0 HP are dead: the big skull overlay and defeated in combat; healed above 0, they're back.
    if (options.incarnosHealthBefore !== undefined && isWriter(actor)) {
      const transition = npcHealthTransition({ type: actor.type, before: options.incarnosHealthBefore,
        after: Number(actor.system.health?.value ?? 0) });
      if (transition) void (transition === "dead" ? markDead(actor) : unmarkDead(actor))
        .catch(error => console.error("Incarnos | npc dead", error));
    }
    if (userId !== game.user.id) return;
    if (options.incarnosBarrierPopped) {
      void (async () => {
        await setConditionTokens(actor, "barrier", 0);
        await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }),
          content: `<p>${escape(game.i18n.format("INCARNOS.Conditions.barrierPopped", { name: actor.name }))}</p>` });
      })().catch(error => console.error("Incarnos | barrier", error));
    }
    if (options.incarnosHealthBefore !== undefined) {
      const after = Number(actor.system.health?.value ?? 0);
      if (after > options.incarnosHealthBefore && statusEffect(actor, "bleed")) {
        void setConditionTokens(actor, "bleed", 0);
        ui.notifications.info(`${actor.name}: healing stopped the bleeding.`);
      }
      const sleep = conditionTokens(actor, "asleep");
      // incarnosKeepSleep: the damage of the spell that just put the target to sleep doesn't wake it.
      if (after < options.incarnosHealthBefore && sleep > 0 && !options.incarnosKeepSleep) void setConditionTokens(actor, "asleep", asleepAfterDamage(sleep));
    }
    // The action Paralyzed takes away isn't spent, so it doesn't wake a sleeper.
    if (options.incarnosActionsBefore !== undefined && !options.incarnosParalyzed) {
      const spent = options.incarnosActionsBefore - getActionState(actor).value;
      const sleep = conditionTokens(actor, "asleep");
      if (spent > 0 && sleep > 0) void setConditionTokens(actor, "asleep", asleepAfterActions(sleep, spent));
    }
  });

  // Grappled and Immobilized: players can't move the token.
  Hooks.on("preUpdateToken", (token, changes) => {
    if (game.user.isGM || !("x" in changes || "y" in changes)) return;
    const blocked = ["grappled", "immobilized"].find(id => token.actor?.statuses?.has(id));
    if (!blocked) return;
    ui.notifications.warn(game.i18n.format("INCARNOS.Conditions.movementBlocked", { name: token.name, condition: blocked }));
    return false;
  });
}

/**
 * Put an attack's conditions on a target (with the GM's Apply on the attack card).
 * @param {Actor} actor
 * @param {{id: string, tokens?: number, timed?: boolean, heal?: string}[]} conditions  Immobilized durations explicitly carry timed: true.
 */
export async function applyAttackConditions(actor, conditions = []) {
  for (const { id, tokens, heal, timed, damage, by } of conditions) {
    if (!conditionById(id)) continue;
    if ((id === "taunted" || id === "frenzied") && by) {
      // A spell's Taunted names the caster and ends at the end of the target's next turn; one put on by hand
      // (no timer) stays until removed.
      const existing = statusEffect(actor, id);
      if (!existing) await actor.toggleStatusEffect(id, { active: true });
      const effect = statusEffect(actor, id);
      await effect?.setFlag("incarnos", "by", by);
      if (!existing || existing.getFlag("incarnos", "untilEndOfTurn") === true) await effect?.setFlag("incarnos", "untilEndOfTurn", true);
      continue;
    }
    if (id === "entertainer-s-cursed") {
      // Entertainer's Curse remembers its caster, who gains Applause when this creature takes damage.
      if (!statusEffect(actor, id)) await actor.toggleStatusEffect(id, { active: true });
      if (by) await statusEffect(actor, id)?.setFlag("incarnos", "curseBy", by);
      continue;
    }
    if (TURN_COUNTDOWN_CONDITIONS.includes(id)) {
      // A new Shadowclone also gives its extra action (a refreshed clone doesn't give another).
      const fresh = id === "shadowclone" && !statusEffect(actor, id);
      await setConditionTokens(actor, id, Math.max(conditionTokens(actor, id), Math.max(1, Number(tokens) || 1)));
      if (fresh) await grantExtraAction(actor, 1);
      continue;
    }
    if (damage && DAMAGE_TOKEN_CONDITIONS.includes(id)) {
      // Bloody Claws: tokens count the turns and each turn rolls the source's damage; a new source refreshes the turns.
      await setConditionTokens(actor, id, Math.max(conditionTokens(actor, id), Math.max(1, Number(tokens) || 1)));
      await statusEffect(actor, id)?.setFlag("incarnos", "damage", damage);
      continue;
    }
    if (id === "immobilized") {
      const existing = statusEffect(actor, id);
      if (timed === true && (!existing || existing.getFlag("incarnos", "timed") === true)) {
        await addConditionTokens(actor, id, Math.max(1, Number(tokens) || 1));
        await statusEffect(actor, id)?.setFlag("incarnos", "timed", true);
      } else {
        if (!existing) await actor.toggleStatusEffect(id, { active: true });
        // An untimed source (or a hand-applied effect) lasts until removed, even alongside a timed source.
        await statusEffect(actor, id)?.setFlag("incarnos", "timed", false);
      }
    } else if (id === "barrier") {
      // A new Barrier doesn't stack: the longer duration wins.
      await setConditionTokens(actor, id, Math.max(conditionTokens(actor, id), Math.max(1, Number(tokens) || 1)));
    } else if (conditionById(id).tokens) await addConditionTokens(actor, id, Math.max(1, Number(tokens) || 1));
    else if (!actor.statuses?.has(id)) await actor.toggleStatusEffect(id, { active: true });
    // Regenerating keeps the healing per turn its source fixed (the newest source wins).
    if (heal) await statusEffect(actor, id)?.setFlag("incarnos", "heal", heal);
  }
}

/** Hindered lasts for one attack: remove it after an attack roll. */
export async function consumeHindered(actor) {
  if (actor?.statuses?.has("hindered")) await actor.toggleStatusEffect("hindered", { active: false });
}

/** Dodge is a temporary ActiveEffect, separate from token-HUD status conditions. */
export const dodgeEffects = actor => [...(actor?.effects ?? [])].filter(effect => effect.getFlag("incarnos", "dodge") === true);
export const hasDodge = actor => dodgeEffects(actor).some(effect => !effect.disabled && !effect.isSuppressed);
export async function consumeDodge(actor) {
  for (const effect of dodgeEffects(actor)) await effect.delete();
}
export async function applyDodge(actor) {
  await consumeDodge(actor);
  return actor.createEmbeddedDocuments("ActiveEffect", [{
    name: game.i18n.localize("INCARNOS.Actions.dodge"), img: "icons/svg/shield.svg",
    description: "<p>Your next Parry against a melee, ranged or spell attack has advantage until the beginning of your next turn.</p>",
    duration: { rounds: 1 }, flags: { incarnos: { dodge: true } }
  }]);
}

/** Preserve an existing HUD condition's indefinite duration. Repeated timed sources refresh the next-turn expiry. */
export async function applyActionCondition(actor, id, { untilEndOfTurn = false } = {}) {
  const existing = statusEffect(actor, id);
  await applyAttackConditions(actor, [{ id }]);
  const effect = statusEffect(actor, id);
  if (untilEndOfTurn && effect && (!existing || existing.getFlag("incarnos", "untilEndOfTurn") === true)) {
    const combat = game.combat;
    await effect.update({ "flags.incarnos.untilEndOfTurn": true,
      "flags.incarnos.appliedTurn": combat ? `${combat.id}:${combat.round}:${combat.turn}` : null });
  }
}
