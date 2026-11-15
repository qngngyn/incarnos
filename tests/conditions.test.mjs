import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as CONDITION_HELPERS from "../module/helpers/conditions.mjs";
const { advantageFormula, asleepAfterActions, asleepAfterDamage, conditionAdvantage, proneParry, tickDamageTokens } = CONDITION_HELPERS;
import { CONDITIONS } from "../module/data/conditions.mjs";
import { conditionsModule, parseConditionNote } from "../tools/condition-notes.mjs";

test("damage tokens deal 1 damage per token, then one token goes", () => {
  assert.deepEqual(tickDamageTokens(3), { damage: 3, remaining: 2 });
  assert.deepEqual(tickDamageTokens(1), { damage: 1, remaining: 0 });
  // 3 tokens deal 3 + 2 + 1 = 6 in total.
  let tokens = 3, total = 0;
  while (tokens) { const tick = tickDamageTokens(tokens); total += tick.damage; tokens = tick.remaining; }
  assert.equal(total, 6);
});

test("asleep: every action point spent removes a token; damage halves them, not below 2", () => {
  assert.equal(asleepAfterActions(5, 1), 4);
  assert.equal(asleepAfterActions(2, 3), 0);
  assert.equal(asleepAfterActions(4, 0), 4);
  assert.equal(asleepAfterDamage(9), 4);
  assert.equal(asleepAfterDamage(3), 1);
  assert.equal(asleepAfterDamage(4), 2);
  assert.equal(asleepAfterDamage(2), 0, "at least 2 tokens are lost");
  assert.equal(asleepAfterDamage(1), 0);
});

test("Hidden gives advantage, Hindered disadvantage on attacks, Prone depends on the attack parried", () => {
  assert.deepEqual(conditionAdvantage(new Set(["hidden"]), "attack"), { delta: 1, sources: ["Hidden"] });
  assert.deepEqual(conditionAdvantage(new Set(["hindered"]), "attack"), { delta: -1, sources: ["Hindered"] });
  assert.equal(conditionAdvantage(new Set(["hidden", "hindered"]), "attack").delta, 0);
  assert.equal(conditionAdvantage(new Set(["prone"]), "parry", "melee").delta, -1);
  assert.equal(conditionAdvantage(new Set(["prone"]), "parry", "ranged").delta, 1);
  assert.equal(conditionAdvantage(new Set(["hindered"]), "parry").delta, 0, "Hindered only affects attacks");
  // Prone Parry without a popup: both cases from one roll.
  assert.deepEqual(proneParry([4, 15]), { melee: 15, ranged: 4 });
  assert.deepEqual(proneParry([9, 15, 3], true), { melee: 9, ranged: 3 }, "Hidden cancels the melee disadvantage and doubles the ranged advantage");
  assert.equal(advantageFormula(1), "2d20kl");
  assert.equal(advantageFormula(-1), "2d20kh");
  assert.equal(advantageFormula(0), "1d20");
});

test("vault condition notes give id, name, icon, text and whether they count tokens", () => {
  const { condition, warnings } = parseConditionNote("Burn (dice, e.g. D4): You get that many Burn tokens.", "Burn");
  assert.deepEqual(warnings, []);
  assert.deepEqual(condition, { id: "burn", name: "Burn", img: "icons/svg/fire.svg", description: "You get that many Burn tokens.", tokens: true });
  assert.equal(parseConditionNote("Prone: Melee Parry at disadvantage.\nIcon: icons/svg/down.svg", "Prone").condition.img, "icons/svg/down.svg");
  assert.match(parseConditionNote("Dazed: Stuff.", "Dazed").warnings[0], /no icon/);
  assert.match(conditionsModule([]), /export const CONDITIONS = \[\]/);
});

test("the generated list holds every vault condition with an icon", () => {
  assert.deepEqual(CONDITIONS.map(c => c.id).sort(),
    ["applause", "asleep", "barrier", "bleed", "blinded", "burn", "charged", "dying", "entertainer-s-cursed", "frenzied", "grappled", "hidden", "hindered", "immobilized", "intimidated", "invulnerable", "mounted", "paralyzed", "poisoned", "prone", "regenerating", "shadowclone", "shadowform", "shadowmarked", "stunned", "summoned", "taunted", "unconscious"]);
  assert.ok(CONDITIONS.every(c => c.img.startsWith("icons/") || c.img.startsWith("systems/incarnos/icons/")));
  assert.deepEqual(CONDITIONS.filter(c => c.tokens).map(c => c.id).sort(), ["applause", "asleep", "barrier", "bleed", "blinded", "burn", "charged", "immobilized", "invulnerable", "poisoned", "regenerating", "shadowclone", "shadowform", "shadowmarked", "summoned"]);
});

test("attack conditions: only trait lines that are just a condition count, token conditions keep their dice", () => {
  const { parseAttackConditions } = CONDITION_HELPERS;
  assert.deepEqual(parseAttackConditions("Burn D4\nProne"), [{ id: "burn", name: "Burn", dice: "d4" }, { id: "prone", name: "Prone", dice: null }]);
  assert.deepEqual(parseAttackConditions("Poisoned d4"), [{ id: "poisoned", name: "Poisoned", dice: "d4" }]);
  assert.deepEqual(parseAttackConditions("Bleed"), [{ id: "bleed", name: "Bleed", dice: "1" }], "token condition without dice: 1 token");
  assert.deepEqual(parseAttackConditions("Trip: on a crit the target falls Prone.\nReach: 3m"), [], "descriptions never apply a condition");
  assert.deepEqual(parseAttackConditions(""), []);
});

test("HUD order: Incarnos conditions first, then Defeated and three spare statuses", () => {
  const list = CONDITION_HELPERS.statusEffectList();
  const sorted = [...list].sort((a, b) => a.order - b.order).map(status => status.id);
  assert.deepEqual(sorted.slice(0, CONDITIONS.length), CONDITION_HELPERS.CONDITION_ORDER, "every vault condition has its place in the fixed order");
  assert.deepEqual(sorted.slice(CONDITIONS.length), ["dead", "custom-1", "custom-2", "custom-3"]);
  assert.equal(list.find(status => status.id === "immobilized").img, "icons/svg/net.svg", "Immobilized keeps the net icon");
  assert.equal(new Set(list.map(status => status.img)).size, list.length, "every status has its own icon");
});

test("only status effects made entirely of unknown statuses count as old", () => {
  const known = new Set(CONDITION_HELPERS.statusEffectList().map(status => status.id));
  const { unknownStatusEffect } = CONDITION_HELPERS;
  assert.equal(unknownStatusEffect({ statuses: new Set(["stun"]) }, known), true);
  assert.equal(unknownStatusEffect({ statuses: new Set(["prone"]) }, known), false);
  assert.equal(unknownStatusEffect({ statuses: new Set() }, known), false, "plain active effects (passives, items) stay");
});

test("spell texts: clear prone and token effects count, conditional or optional ones don't", async () => {
  const { parseSpellConditions } = await import("../module/helpers/spells.mjs");
  assert.deepEqual(parseSpellConditions(["On hit: Deals 4d6 + (lvl * 2) earth dmg", "Target is knocked prone (none when save succeeded)"], true),
    [{ id: "prone", name: "Prone", formula: null, saveNegates: true }]);
  assert.deepEqual(parseSpellConditions(["On hit:", "Deals 1d6 + (lvl * 2) water dmg", "Apply 4d4 + (lvl * 2) sleep tokens, the target falls asleep", "", "Asleep: You cannot act. When you take damage, you half your sleep tokens."], false),
    [{ id: "asleep", name: "Asleep", formula: "4d4 + (@lvl * 2)", saveNegates: false }]);
  assert.deepEqual(parseSpellConditions(["On cast: Targets are pushed. If the target hits objects, the target falls prone and both take 1d4 air dmg"], true), [], "Gale Force: only if it hits something");
  assert.deepEqual(parseSpellConditions(["Up to 3 projectiles gain one of the effects of your choice:", "Prone targets (none when Save succeeded)"], true), [], "choices stay manual");
  assert.deepEqual(parseSpellConditions(["Slash: Burn D4 on the target"], false).map(c => c.id), [], "lines starting with a label are reminders");
  assert.deepEqual(parseSpellConditions(["On hit: 2d6 fire dmg and Burn D6"], false), [{ id: "burn", name: "Burn", formula: "d6", saveNegates: false }]);
});

test("Leaf wind: Regenerating with turns as tokens and the healing per turn", async () => {
  const { parseSpellAutomation } = await import("../module/helpers/spells.mjs");
  const auto = parseSpellAutomation({ check: "No Check", target: "Single Ally", category: "Heal",
    effect: "On cast:\nHeals the target by 2d6 + (lvl * 1)\nTarget gains Regenerating 2: heals 1d6 + (lvl * 1) at the beginning of the target's turn" });
  assert.equal(auto.heal, "2d6 + (@lvl * 1)", "the instant heal stays the cast's heal");
  assert.deepEqual(auto.conditions, [{ id: "regenerating", name: "Regenerating", formula: "2", saveNegates: false, heal: "1d6 + (@lvl * 1)" }]);
});

test("Regenerating uses the actor's effect when activation reports an already active status", async () => {
  const { applyAttackConditions, conditionTokens } = CONDITION_HELPERS;
  const actor = { effects: [], statuses: new Set() };
  const flags = { statuscounter: { value: 1, visible: false } };
  let updatingCounter = false;
  const effect = {
    statuses: new Set(["regenerating"]),
    getFlag: (scope, key) => flags[scope]?.[key],
    async setFlag(scope, key, value) {
      assert.equal(updatingCounter, false, "the counter update must finish before writing the heal flag");
      (flags[scope] ??= {})[key] = value;
    },
    get statusCounter() {
      return this._statusCounter ??= {
        get displayValue() { return flags.statuscounter.value; },
        async setValue(value) {
          updatingCounter = true;
          await new Promise(resolve => setImmediate(resolve));
          flags.statuscounter = { value, visible: value > 1 };
          updatingCounter = false;
        }
      };
    }
  };
  actor.toggleStatusEffect = async (id, options) => {
    assert.equal(id, "regenerating");
    assert.deepEqual(options, { active: true });
    // Cover Foundry's boolean success result as well as the document result.
    actor.effects.push(effect);
    actor.statuses.add(id);
    return true;
  };
  await applyAttackConditions(actor, [{ id: "regenerating", tokens: 2, heal: "1d6 + (3 * 1)" }]);
  assert.equal(conditionTokens(actor, "regenerating"), 2);
  assert.equal(flags.statuscounter.visible, true);
  assert.equal(flags.incarnos.heal, "1d6 + (3 * 1)");
});

test("Immobilized notes declare optional turns and keep their explicit icon", () => {
  const { condition, warnings } = parseConditionNote("Immobilized (turns, optional): You cannot use movement actions.\nIcon: icons/svg/net.svg", "Immobilized");
  assert.deepEqual(warnings, []);
  assert.deepEqual(condition, { id: "immobilized", name: "Immobilized", img: "icons/svg/net.svg",
    description: "You cannot use movement actions.", tokens: true });
});

test("attacks can apply indefinite Immobilized or an explicit timed token count", () => {
  assert.deepEqual(CONDITION_HELPERS.parseAttackConditions("Immobilized"),
    [{ id: "immobilized", name: "Immobilized", dice: null, timed: false }]);
  assert.deepEqual(CONDITION_HELPERS.parseAttackConditions("Prone, Immobilized 2"),
    [{ id: "prone", name: "Prone", dice: null }, { id: "immobilized", name: "Immobilized", dice: "2", timed: true }]);
});

/** In-memory effect documents, including statuscounter's implicit one; never reads or writes a world. */
function immobilizedActor({ timed, tokens } = {}) {
  const actor = { name: "Held", uuid: "Actor.held", effects: [], statuses: new Set(), system: {}, testUserPermission: user => user.id === "owner" };
  actor.toggleStatusEffect = async id => {
    const flags = { incarnos: {}, statuscounter: {} };
    const effect = { statuses: new Set([id]), getFlag: (scope, key) => flags[scope]?.[key],
      async setFlag(scope, key, value) { (flags[scope] ??= {})[key] = value; },
      async update(changes) { for (const [path, value] of Object.entries(changes)) {
        const [, scope, key] = path.split("."); (flags[scope] ??= {})[key] = value;
      } },
      async delete() { actor.effects = actor.effects.filter(entry => entry !== effect); actor.statuses.delete(id); } };
    actor.effects.push(effect);
    actor.statuses.add(id);
    return true;
  };
  if (timed !== undefined || tokens !== undefined) {
    actor.toggleStatusEffect("immobilized");
    const effect = actor.effects[0];
    if (timed !== undefined) effect.setFlag("incarnos", "timed", timed);
    if (tokens !== undefined) effect.setFlag("statuscounter", "value", tokens);
  }
  return actor;
}

test("Immobilized counts down only with timed === true; hand counters and implicit one persist", async () => {
  const { conditionTokens, endOfTurn, startOfTurn } = CONDITION_HELPERS;
  for (const settings of [{ tokens: 1 }, { tokens: 4 }, { tokens: 2, timed: false }, { timed: "true" }]) {
    const actor = immobilizedActor(settings);
    const before = conditionTokens(actor, "immobilized");
    await endOfTurn(actor);
    assert.equal(conditionTokens(actor, "immobilized"), before);
  }
  const actor = immobilizedActor({ timed: true, tokens: 2 });
  const gm = { id: "gm", active: true, isGM: true };
  globalThis.game = { user: gm, users: [gm] };
  const prompts = [];
  globalThis.ChatMessage = { getSpeaker: () => ({}), create: async data => prompts.push(data) };
  await startOfTurn(actor);
  assert.equal(conditionTokens(actor, "immobilized"), 2, "starting the turn never consumes Immobilized");
  assert.match(prompts[0].content, /Immobilized/);
  assert.match(prompts[0].content, /2 tokens/);
  await endOfTurn(actor);
  assert.equal(conditionTokens(actor, "immobilized"), 1);
  await endOfTurn(actor);
  assert.equal(actor.statuses.has("immobilized"), false, "the last token removes the effect");
  await startOfTurn(immobilizedActor({ tokens: 1 }));
  assert.match(prompts[1].content, /Immobilized/);
  assert.doesNotMatch(prompts[1].content, /isc-detail">1 token/, "an untimed HUD counter is not presented as a duration");
});

test("Immobilized sources flag durations, add timed tokens and preserve indefinite effects", async () => {
  const { applyAttackConditions, conditionTokens, endOfTurn, statusEffect } = CONDITION_HELPERS;
  const actor = immobilizedActor();
  await applyAttackConditions(actor, [{ id: "immobilized", tokens: 2, timed: true }]);
  assert.equal(conditionTokens(actor, "immobilized"), 2);
  assert.equal(statusEffect(actor, "immobilized").getFlag("incarnos", "timed"), true);
  await applyAttackConditions(actor, [{ id: "immobilized", tokens: 2, timed: true }]);
  assert.equal(conditionTokens(actor, "immobilized"), 4, "two timed sources add their tokens");
  await applyAttackConditions(actor, [{ id: "immobilized", timed: false }]);
  await endOfTurn(actor);
  assert.equal(conditionTokens(actor, "immobilized"), 4, "an indefinite source stops the countdown");
  const manual = immobilizedActor({ tokens: 1 });
  await applyAttackConditions(manual, [{ id: "immobilized", tokens: 2, timed: true }]);
  assert.equal(statusEffect(manual, "immobilized").getFlag("incarnos", "timed"), false, "a timed hit cannot expire a hand-applied effect");
  const untimed = immobilizedActor();
  await applyAttackConditions(untimed, [{ id: "immobilized", timed: false }]);
  await endOfTurn(untimed);
  assert.equal(conditionTokens(untimed, "immobilized"), 1, "the default counter isn't a duration");
});

function conditionHooks() {
  const hooks = {};
  globalThis.Hooks = { once: () => {}, on: (name, callback) => { hooks[name] = callback; } };
  CONDITION_HELPERS.registerConditionHooks();
  return hooks;
}

test("turn transitions tick the previous combatant once, forward only, using the single writer", async () => {
  const { conditionTokens } = CONDITION_HELPERS;
  const gm = { id: "a-gm", active: true, isGM: true };
  const secondGM = { id: "z-gm", active: true, isGM: true };
  const owner = { id: "owner", active: true, isGM: false };
  const previous = immobilizedActor({ timed: true, tokens: 4 });
  const currentActor = immobilizedActor({ timed: true, tokens: 3 });
  globalThis.ChatMessage = { getSpeaker: () => ({}), create: async () => {} };
  const combat = () => ({ combatants: new Map([["previous", { actor: previous }], ["current", { actor: currentActor }]]) });
  const prior = { round: 1, turn: 0, combatantId: "previous" };
  const current = { round: 1, turn: 1, combatantId: "current" };
  const transition = async (user, users, encounter = combat(), before = prior, after = current) => {
    globalThis.game = { user, users };
    const hooks = conditionHooks();
    hooks.combatTurnChange(encounter, before, after);
    hooks.combatTurnChange(encounter, before, after);
    await new Promise(resolve => setImmediate(resolve));
  };
  await transition(secondGM, [secondGM, owner, gm]);
  await transition(owner, [owner, gm]);
  assert.equal(conditionTokens(previous, "immobilized"), 4, "neither another GM nor an owner writes while the elected GM is active");
  await transition(gm, [secondGM, owner, gm]);
  assert.equal(conditionTokens(previous, "immobilized"), 3, "only the previous actor ticks, once despite duplicate hooks");
  assert.equal(conditionTokens(currentActor, "immobilized"), 3);
  await transition(gm, [gm], combat(), current, prior);
  assert.equal(conditionTokens(currentActor, "immobilized"), 3, "backward navigation doesn't consume duration");
  await transition(gm, [gm], combat(), { round: 0, turn: null }, prior);
  assert.equal(conditionTokens(previous, "immobilized"), 3, "starting combat doesn't end a turn");
  await transition(owner, [owner, { ...gm, active: false }]);
  assert.equal(conditionTokens(previous, "immobilized"), 2, "an active owner writes if no GM is active");
  await transition(gm, [gm], combat(), { round: 1, turn: 1, combatantId: "previous" }, { round: 2, turn: 0, combatantId: "previous" });
  assert.equal(conditionTokens(previous, "immobilized"), 1, "a solo combatant ticks across rounds too");
});

test("Immobilized and Grappled stop player movement with the existing warning style; GMs can move", () => {
  const hook = conditionHooks().preUpdateToken;
  const warnings = [];
  globalThis.ui = { notifications: { warn: text => warnings.push(text) } };
  const language = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url), "utf8"));
  globalThis.game = { user: { isGM: false }, i18n: { format: (key, data) => language[key].replace(/\{(\w+)\}/g, (_, field) => data[field]) } };
  for (const id of ["immobilized", "grappled"]) {
    const token = { name: "Held", actor: { hasPlayerOwner: true, statuses: new Set([id]) } };
    assert.equal(hook(token, { x: 100 }), false);
    assert.equal(hook(token, { y: 100 }), false);
    assert.equal(warnings.at(-1), `Held is ${id} and cannot move.`);
    assert.equal(hook(token, { rotation: 90 }), undefined);
    game.user.isGM = true;
    assert.equal(hook(token, { x: 100 }), undefined);
    game.user.isGM = false;
  }
  assert.equal(hook({ actor: { statuses: new Set() } }, { x: 100 }), undefined);
});

test("Bloody Claws bleed: tokens count the turns and each start of turn rolls the source's damage", async () => {
  const { applyAttackConditions, conditionTokens, startOfTurn, statusEffect } = CONDITION_HELPERS;
  const actor = immobilizedActor();
  await applyAttackConditions(actor, [{ id: "bleed", tokens: 3, damage: "2d6" }]);
  assert.equal(conditionTokens(actor, "bleed"), 3);
  assert.equal(statusEffect(actor, "bleed").getFlag("incarnos", "damage"), "2d6");
  await applyAttackConditions(actor, [{ id: "bleed", tokens: 3, damage: "2d6" }]);
  assert.equal(conditionTokens(actor, "bleed"), 3, "a second hit refreshes the turns instead of stacking them");
  const gm = { id: "gm", active: true, isGM: true };
  globalThis.game = { user: gm, users: [gm], combats: [] };
  globalThis.Roll = class { constructor(formula) { this.formula = formula; } async evaluate() { this.total = 7; this.result = "3 + 4"; return this; } };
  const prompts = [];
  globalThis.ChatMessage = { getSpeaker: () => ({}), create: async data => prompts.push(data) };
  actor.system.health = { value: 20, min: 0, max: 20 };
  actor.update = async changes => { actor.system.health.value = changes["system.health.value"]; };
  await startOfTurn(actor);
  assert.equal(conditionTokens(actor, "bleed"), 2);
  assert.equal(actor.system.health.value, 13, "Bleed deals its damage by itself");
  assert.match(prompts[0].content, /7 damage \(2d6\)\. 2 turns left\./);
  assert.match(prompts[0].content, /isc-done/);
  assert.doesNotMatch(prompts[0].content, /data-incarnos-health-apply/);
});

/** An actor with token conditions, HP and one combatant, under an online GM. */
function dotActor(hp, tokens) {
  const actor = immobilizedActor();
  for (const [id, count] of Object.entries(tokens)) {
    actor.toggleStatusEffect(id);
    actor.effects.at(-1).setFlag("statuscounter", "value", count);
  }
  actor.system.health = { value: hp, min: 0, max: 20 };
  actor.update = async changes => { actor.system.health.value = changes["system.health.value"]; };
  const combatant = { actor, defeated: false, async update(changes) { Object.assign(this, changes); } };
  const gm = { id: "gm", active: true, isGM: true };
  globalThis.game = { user: gm, users: [gm], combats: [{ combatants: [combatant] }] };
  globalThis.CONFIG = { specialStatusEffects: { DEFEATED: "dead" } };
  const prompts = [];
  globalThis.ChatMessage = { getSpeaker: () => ({}), create: async data => prompts.push(data) };
  return { actor, combatant, prompts };
}

test("Burn, Poisoned and Bleed deal their damage at the start of the turn without an Apply button", async () => {
  const { actor, combatant, prompts } = dotActor(10, { burn: 2, poisoned: 1, bleed: 3 });
  await CONDITION_HELPERS.startOfTurn(actor);
  assert.equal(actor.system.health.value, 4, "2 Burn + 1 Poison + 3 Bleed");
  assert.equal(actor.statuses.has("dead"), false);
  assert.equal(combatant.defeated, false);
  assert.doesNotMatch(prompts[0].content, /data-incarnos-health-apply/);
  assert.equal((prompts[0].content.match(/isc-done/g) ?? []).length, 3);
});

test("bleeding to 0 HP kills (dead status, combatant defeated); Burn or Poison alone at 0 HP does not", async () => {
  const bleeding = dotActor(4, { burn: 2, bleed: 3 });
  await CONDITION_HELPERS.startOfTurn(bleeding.actor);
  assert.equal(bleeding.actor.system.health.value, 0);
  assert.equal(bleeding.actor.statuses.has("dead"), true);
  assert.equal(bleeding.combatant.defeated, true);
  assert.match(bleeding.prompts[0].content, /bled out and is dead/);
  const burning = dotActor(2, { burn: 2 });
  await CONDITION_HELPERS.startOfTurn(burning.actor);
  assert.equal(burning.actor.system.health.value, 0);
  assert.equal(burning.actor.statuses.has("dead"), false, "0 HP from Burn follows the normal rules");
  assert.doesNotMatch(burning.prompts[0].content, /dead/);
});

test("turn start: Stunned leaves no actions, Paralyzed takes one, never below 0", () => {
  const { actionsAfterTurnStart } = CONDITION_HELPERS;
  assert.equal(actionsAfterTurnStart(3, { stunned: true }), 0);
  assert.equal(actionsAfterTurnStart(3, { paralyzed: true }), 2);
  assert.equal(actionsAfterTurnStart(3, { stunned: true, paralyzed: true }), 0);
  assert.equal(actionsAfterTurnStart(0, { paralyzed: true }), 0);
  assert.equal(actionsAfterTurnStart(3), 3);
});

test("Barrier ignores an HP loss or a damage instance at 0 HP, but not healing or a skipped check", () => {
  const { barrierAbsorbs } = CONDITION_HELPERS;
  assert.equal(barrierAbsorbs(10, 4, true), true);
  assert.equal(barrierAbsorbs(0, 0, true, false, true), true, "damage at 0 HP is still the next damage instance");
  assert.equal(barrierAbsorbs(4, 10, true), false);
  assert.equal(barrierAbsorbs(10, 4, false), false);
  assert.equal(barrierAbsorbs(10, 4, true, true), false);
});

test("Blinded gives disadvantage on attacks, Parry and saves", () => {
  const { conditionAdvantage } = CONDITION_HELPERS;
  for (const kind of ["attack", "parry", "save"]) assert.deepEqual(conditionAdvantage(new Set(["blinded"]), kind), { delta: -1, sources: ["Blinded"] });
  assert.equal(conditionAdvantage(new Set(["blinded", "hidden"]), "attack").delta, 0, "Hidden and Blinded cancel");
});

test("the HUD order is fixed and grouped in rows of 7; unknown conditions follow alphabetically", () => {
  const { CONDITION_ORDER, sortConditions } = CONDITION_HELPERS;
  assert.deepEqual(CONDITION_ORDER.slice(0, 7), ["prone", "grappled", "immobilized", "mounted", "hidden", "hindered", "blinded"]);
  assert.deepEqual(CONDITION_ORDER.slice(22), ["summoned", "dying", "unconscious", "invulnerable", "entertainer-s-cursed", "applause"]);
  assert.equal(CONDITION_ORDER[8], "frenzied", "next to Taunted");
  const sorted = sortConditions([{ id: "zeta", name: "Zeta" }, { id: "alpha", name: "Alpha" }, { id: "burn", name: "Burn" }, { id: "prone", name: "Prone" }]);
  assert.deepEqual(sorted.map(condition => condition.id), ["prone", "burn", "alpha", "zeta"]);
});

test("Invulnerable blocks every HP loss and damage at 0 HP, but not healing; it counts down each turn", () => {
  const { invulnerableBlocks, TURN_COUNTDOWN_CONDITIONS } = CONDITION_HELPERS;
  assert.equal(invulnerableBlocks(10, 4, true), true);
  assert.equal(invulnerableBlocks(0, 0, true, true), true, "a damage instance at 0 HP");
  assert.equal(invulnerableBlocks(4, 10, true), false, "healing still works");
  assert.equal(invulnerableBlocks(10, 4, false), false);
  assert.ok(TURN_COUNTDOWN_CONDITIONS.includes("invulnerable"));
});
