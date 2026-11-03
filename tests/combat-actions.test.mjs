import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { ACTIONS, actionById, actionTooltip, insightModifier } from "../module/data/actions.mjs";
import { useCombatAction } from "../module/helpers/combat-actions.mjs";
import { applyContestAction, processCombatActionRequest, registerCombatActionHooks } from "../module/helpers/action-effects.mjs";
import { completeDefenderContest, rollDefenderContest, resolveContestTie, refreshBoard, resumeContests, CONTEST_STATS } from "../module/helpers/contest-requests.mjs";
import { applyActionCondition, applyDodge, conditionAdvantage, consumeDodge, consumeHindered, endOfTurn, hasDodge, proneParry, startOfTurn } from "../module/helpers/conditions.mjs";

const strings = JSON.parse(readFileSync(new URL("../lang/en.json", import.meta.url)));
const assign = (object, changes) => {
  for (const [key, value] of Object.entries(changes)) {
    const parts = key.split(".");
    const last = parts.pop();
    const parent = parts.reduce((obj, part) => obj[part] ??= {}, object);
    parent[last] = value;
  }
};
let nextId = 0;
function setup() {
  const actors = new Map(), messages = new Map(), created = [], warnings = [], formulas = [], prompts = [];
  const gm = { id: "gm", isGM: true, active: true };
  const player = { id: "player", active: true, targets: new Set() };
  const other = { id: "other", active: true };
  const users = [gm, player, other];
  users.get = id => users.find(user => user.id === id);
  const actor = (name, owner, type = "character") => {
    const value = { name, id: name, uuid: "Actor." + name, type, documentName: "Actor", img: "", effects: [], statuses: new Set(),
      system: { actionpoints: { value: 3, max: 3 }, attributes: { level: { value: 1 }, parry: { value: 10 } },
        abilities: Object.fromEntries(Object.values(CONTEST_STATS).map(key => [key, { value: 10, save: 12 }])) },
      testUserPermission: user => user.id === owner, getRollData: () => ({}), effectWrites: 0,
      async update(changes) { assign(this, changes); }
    };
    value.createEmbeddedDocuments = async (type, sources) => sources.map(source => {
      const effect = { ...structuredClone(source), id: "effect-" + nextId++, statuses: new Set(source.statuses ?? []),
        getFlag: (scope, key) => effect.flags?.[scope]?.[key],
        setFlag: async (scope, key, val) => assign(effect, { ["flags." + scope + "." + key]: val }),
        update: async changes => assign(effect, changes),
        delete: async () => { value.effects.splice(value.effects.indexOf(effect), 1); for (const id of effect.statuses) value.statuses.delete(id); }
      };
      value.effects.push(effect); for (const id of effect.statuses) value.statuses.add(id);
      value.effectWrites++;
      return effect;
    });
    value.toggleStatusEffect = async (id, { active }) => {
      if (!active) { for (const effect of [...value.effects]) if (effect.statuses.has(id)) await effect.delete(); return; }
      if (!value.statuses.has(id)) await value.createEmbeddedDocuments("ActiveEffect", [{ name: id, statuses: [id] }]);
      return true;
    };
    actors.set(value.uuid, value);
    return value;
  };
  const attacker = actor("Attacker", player.id);
  const defender = actor("Defender", other.id, "npc");
  player.character = attacker; other.character = defender;
  globalThis.game = { user: player, users, messages, combats: [], settings: { get: () => "publicroll" },
    i18n: { localize: key => strings[key] ?? key,
      format: (key, data) => (strings[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(data[name])) }
  };
  globalThis.ui = { notifications: { warn: value => warnings.push(value), error: value => warnings.push(value) } };
  globalThis.fromUuid = async uuid => actors.get(uuid);
  globalThis.CONFIG = { sounds: { dice: "" }, INCARNOS: { abilities: {} } };
  const totals = [];
  globalThis.Roll = class {
    constructor(formula) { this.formula = formula; }
    async evaluate() {
      formulas.push(this.formula);
      this.total = totals.shift() ?? 5;
      this._evaluated = true;
      this.dice = [{ results: (this.formula === "4d20" ? [9, 4, 15, 2] : this.formula === "3d20" ? [9, 15, 3] : [this.total, 15]).map(result => ({ result })) }];
      return this;
    }
    toJSON() { return { formula: this.formula, total: this.total, evaluated: this._evaluated }; }
    static fromData(data) { const roll = new this(data.formula); roll.total = data.total; roll._evaluated = data.evaluated; return roll; }
  };
  globalThis.ChatMessage = {
    getSpeaker: ({ actor }) => ({ actor: actor.id }), applyMode: () => {},
    create: async data => {
      const message = { ...structuredClone(data), id: "message-" + nextId++, author: game.user, timestamp: Date.now(),
        update: async changes => {
          if (changes.author) { message.author = users.get(changes.author); changes = { ...changes }; delete changes.author; }
          assign(message, changes);
        },
        delete: async () => { message.deleted = true; messages.delete(message.id); }
      };
      created.push(message); messages.set(message.id, message);
      return message;
    }
  };
  globalThis.foundry = { applications: { api: { DialogV2: { prompt: async options => {
    prompts.push(options);
    const selected = options.content.match(/value="([^"]+)" selected/);
    return selected ? options.ok.callback(null, { form: { elements: { stat: { value: selected[1] } } } }) : options.ok.callback();
  } } } } };
  const target = () => player.targets.add({ actor: defender, document: { disposition: -1 } });
  return { actor, attacker, defender, gm, player, other, users, created, warnings, formulas, prompts, totals, target };
}

test("all eleven action definitions carry cheat text, valid stats, save restrictions and 1 AP tooltips", () => {
  setup();
  assert.equal(ACTIONS.length, 11);
  assert.equal(new Set(ACTIONS.map(action => action.id)).size, 11);
  assert.deepEqual(ACTIONS.filter(action => action.saves).map(action => action.id), ["shove", "grapple", "escape", "find", "intimidate", "taunt", "scale"]);
  for (const action of ACTIONS) {
    assert.equal(action.apCost, 1);
    assert(strings[action.tooltip]);
    assert(actionTooltip(action).startsWith("1 AP"));
    for (const stat of [...action.stats ?? [], ...action.saves ?? []]) assert(CONTEST_STATS[stat]);
  }
  assert.deepEqual(actionById("taunt").saves, ["Willpower"]);
  assert.equal(CONTEST_STATS.Willpower, "wis");
});

test("every named action spends 1 AP on the actor in combat and blocks without AP", async () => {
  for (const action of ACTIONS) {
    const env = setup(); env.target();
    game.combats = [{ started: true, combatants: [{ actor: env.attacker }, { actor: env.defender }] }];
    await useCombatAction(env.attacker, action.id);
    assert.equal(env.attacker.system.actionpoints.value, 2, action.id);
    assert.equal(env.defender.system.actionpoints.value, 3, "target pays nothing");
    env.attacker.system.actionpoints.value = 0;
    const previous = [env.created.length, env.formulas.length, env.attacker.effectWrites];
    await useCombatAction(env.attacker, action.id);
    assert.deepEqual([env.created.length, env.formulas.length, env.attacker.effectWrites], previous, action.id + " blocked before rolling/effects/requests");
    assert.equal(env.warnings.at(-1), `Attacker has 0 AP left; ${action.name} needs 1.`);
  }
});

test("outside combat actions are free; invalid targets and cancelled Scale never spend AP", async () => {
  for (const action of ACTIONS) {
    const env = setup(); env.target();
    await useCombatAction(env.attacker, action.id);
    assert.equal(env.attacker.system.actionpoints.value, 3, action.id);
  }
  const env = setup();
  game.combats = [{ started: true, combatants: [{ actor: env.attacker }] }];
  for (const id of ["grapple", "hinder", "insight"]) await useCombatAction(env.attacker, id);
  assert.equal(env.attacker.system.actionpoints.value, 3);
  env.target();
  foundry.applications.api.DialogV2.prompt = async () => null;
  await useCombatAction(env.attacker, "scale");
  assert.equal(env.attacker.system.actionpoints.value, 3);
  assert.equal(env.created.length, 0);
});

test("defender saves, tie rerolls and contest cancellation do not change AP after the initial payment", async () => {
  const env = setup(); env.target(); env.totals.push(4, 4);
  game.combats = [{ started: true, combatants: [{ actor: env.attacker }, { actor: env.defender }] }];
  const board = await useCombatAction(env.attacker, "grapple");
  assert.equal(env.attacker.system.actionpoints.value, 2);
  env.defender.system.actionpoints.value = 0;
  game.user = env.gm;
  await rollDefenderContest(env.created[1]);
  await resolveContestTie(env.created[1]);
  const [, attack, save] = env.created.slice(2);
  env.attacker.system.actionpoints.value = 0;
  env.totals.push(2, 6);
  await rollDefenderContest(attack); await rollDefenderContest(save); await resolveContestTie(save);
  assert.equal(env.attacker.system.actionpoints.value, 0);
  assert.equal(env.defender.system.actionpoints.value, 0);
  assert.equal(env.warnings.length, 0);
  const { cancelContest } = await import("../module/helpers/contest-requests.mjs");
  await cancelContest(board);
  assert.equal(env.attacker.system.actionpoints.value, 0, "no cancellation refund");
});

test("actions read their AP cost from the definition", async () => {
  const env = setup();
  const index = ACTIONS.findIndex(action => action.id === "dodge");
  const original = ACTIONS[index];
  ACTIONS[index] = { ...original, apCost: 2 };
  try {
    assert.match(actionTooltip(ACTIONS[index]), /^2 AP/);
    game.combats = [{ started: true, combatants: [{ actor: env.attacker }] }];
    await useCombatAction(env.attacker, "dodge");
    assert.equal(env.attacker.system.actionpoints.value, 1);
  } finally { ACTIONS[index] = original; }
});

test("GM can confirm a zero-AP NPC action; declining makes no effect or card", async () => {
  const env = setup();
  env.defender.system.actionpoints.value = 0;
  game.user = env.gm;
  game.combats = [{ started: true, combatants: [{ actor: env.defender }] }];
  foundry.utils = { escapeHTML: value => value };
  const dialogs = [];
  let override = false;
  foundry.applications.api.DialogV2.confirm = async options => { dialogs.push(options); return override; };
  await useCombatAction(env.defender, "dodge");
  assert.equal(env.defender.effectWrites, 0);
  assert.equal(env.created.length, 0);
  override = true;
  await useCombatAction(env.defender, "dodge");
  assert.equal(env.defender.effectWrites, 1);
  assert.equal(env.created.length, 1);
  assert.equal(env.defender.system.actionpoints.value, 0);
  assert.equal(dialogs.length, 2);
  assert.equal(dialogs[0].window.title, "Use anyway?");
  assert.deepEqual(env.warnings, []);
});

test("action contests require exactly one target, roll presets without a dialog and restrict the save chooser", async () => {
  const env = setup();
  await useCombatAction(env.attacker, "grapple");
  assert.equal(env.created.length, 0);
  assert.match(env.warnings[0], /Target a defender/);
  env.target();
  env.player.targets.add({ actor: env.actor("Extra", "gm") });
  await useCombatAction(env.attacker, "grapple");
  assert.equal(env.formulas.length, 0);
  env.player.targets.delete([...env.player.targets][1]);
  const board = await useCombatAction(env.attacker, "grapple");
  assert.match(board.content, /Grapple: Str vs Str\/Spd Save/);
  assert.equal(board.flags.incarnos.contestBoard.actionId, "grapple");
  assert.equal(env.prompts.length, 0);
  assert.deepEqual(env.formulas, ["d10"]);
  const request = env.created[1];
  game.user = env.gm;
  await rollDefenderContest(request);
  assert.match(env.prompts[0].content, /value="Strength" selected/);
  assert.equal((env.prompts[0].content.match(/<option/g) ?? []).length, 2);
  assert.match(env.prompts[0].content, /Speed/);
  assert(!env.prompts[0].content.includes("Dexterity"));
  assert.equal(request.flags.incarnos.contestRequest.responseValue, 12, "defender uses its save, not its ability");
});

test("GM rejects a valid but disallowed save and accepts another permitted save's own value", async () => {
  const env = setup(); env.target();
  await useCombatAction(env.attacker, "grapple");
  const request = env.created[1];
  env.defender.system.abilities.spd.save = 14;
  game.user = env.gm;
  const response = (stat, value, die) => ({ stat, value, roll: { formula: "d" + die, total: 3, evaluated: true } });
  assert.equal(await completeDefenderContest(request, env.defender, response("Dexterity", 12, 8), env.other.id), false);
  assert.equal(await completeDefenderContest(request, env.defender, response("Speed", 14, 6), env.other.id), true);
  assert.equal(request.flags.incarnos.contestRequest.responseDie, 6);
});

test("winning actions apply once on the elected GM, survive reload and show escaped result text; losses do nothing", async () => {
  for (const win of [true, false]) {
    const env = setup(); env.target();
    env.defender.name = "<script>target</script>";
    env.totals.push(win ? 2 : 7, win ? 7 : 2);
    const board = await useCombatAction(env.attacker, "grapple");
    game.user = env.gm; await rollDefenderContest(env.created[1]);
    await resolveContestTie(env.created[1]);
    await Promise.all([refreshBoard(board), refreshBoard(board)]);
    await resumeContests();
    assert.equal(env.defender.effectWrites, win ? 1 : 0);
    assert.equal(env.defender.statuses.has("grappled"), win);
    if (win) {
      assert.equal(board.flags.incarnos.contestBoard.applied, true);
      assert.match(board.content, /Applied: Grappled on &lt;script&gt;target&lt;\/script&gt;/);
      await env.defender.toggleStatusEffect("grappled", { active: false });
      await refreshBoard(board);
      assert.equal(env.defender.statuses.has("grappled"), false, "reload cannot reapply a consumed/removed effect");
    }
    assert(!board.content.includes("<script>"));
  }
});

test("ties keep action restrictions and metadata, then apply only on a winning reroll", async () => {
  const env = setup(); env.target(); env.totals.push(4, 4);
  const board = await useCombatAction(env.attacker, "grapple");
  game.user = env.gm; await rollDefenderContest(env.created[1]); await resolveContestTie(env.created[1]);
  const [nextBoard, attack, save] = env.created.slice(2);
  assert.equal(board.flags.incarnos.contestOutcome.tie, true);
  assert.equal(env.defender.effectWrites, 0);
  assert.equal(nextBoard.flags.incarnos.contestBoard.actionId, "grapple");
  assert.equal(save.flags.incarnos.contestRequest.actionId, "grapple");
  env.totals.push(2, 6);
  await rollDefenderContest(attack); await rollDefenderContest(save); await resolveContestTie(save);
  await refreshBoard(nextBoard);
  assert.equal(env.defender.effectWrites, 1);
  assert.match(nextBoard.content, /Grapple: Str vs Str\/Spd Save/);
  assert.equal(await applyContestAction(nextBoard), false);
});

test("Scale chooses Speed/Dexterity; Escape and Find remove conditions; Mounted goes on the attacker", async () => {
  for (const [id, subject, condition, removed] of [
    ["escape", "attacker", "grappled", true], ["find", "defender", "hidden", true], ["scale", "attacker", "mounted", false]
  ]) {
    const env = setup(); env.target(); env.totals.push(2, 7);
    if (removed) await env[subject].toggleStatusEffect(condition, { active: true });
    const board = await useCombatAction(env.attacker, id);
    if (id === "scale") {
      assert.equal(env.prompts.length, 1);
      assert.match(env.prompts[0].content, /Speed/); assert.match(env.prompts[0].content, /Dexterity/);
      assert.match(board.content, /Size rule is manual/);
      assert.equal(board.flags.incarnos.contestBoard.attacker.stat, "Speed");
    }
    game.user = env.gm; await rollDefenderContest(env.created[1]); await resolveContestTie(env.created[1]);
    assert.equal(env[subject].statuses.has(condition), !removed);
  }
});

test("Intimidate and Taunt expire at the end of the target's next turn; HUD effects and Immobilized stay untimed", async () => {
  const env = setup();
  for (const id of ["intimidated", "taunted"]) {
    game.combat = { id: "combat", round: 1, turn: 2 };
    await applyActionCondition(env.defender, id, { untilEndOfTurn: true });
    assert.equal(env.defender.effects.find(effect => effect.statuses.has(id)).getFlag("incarnos", "untilEndOfTurn"), true);
    await endOfTurn(env.defender, "combat:1:2");
    assert(env.defender.statuses.has(id), "an application during the current turn lasts through the next turn");
    await endOfTurn(env.defender, "combat:2:2");
    assert(!env.defender.statuses.has(id));
    await env.defender.toggleStatusEffect(id, { active: true });
    await applyActionCondition(env.defender, id, { untilEndOfTurn: true });
    await endOfTurn(env.defender);
    assert(env.defender.statuses.has(id), "HUD duration remains indefinite");
  }
  await env.defender.toggleStatusEffect("immobilized", { active: true });
  await endOfTurn(env.defender);
  assert(env.defender.statuses.has("immobilized"));
});

test("Dodge is a visible non-status effect, adds Parry advantage with Hidden/Prone, and ends on consumption/start of turn", async () => {
  const env = setup();
  await useCombatAction(env.attacker, "dodge");
  const effect = env.attacker.effects[0];
  assert.equal(effect.name, "Dodge"); assert.equal(effect.img, "icons/svg/shield.svg");
  assert.equal(effect.statuses.size, 0); assert(effect.duration.rounds);
  assert.match(env.created[0].content, /next Parry has advantage until the start/);
  assert.deepEqual(conditionAdvantage(new Set(), "parry", null, { dodge: hasDodge(env.attacker) }), { delta: 1, sources: ["Dodge"] });
  assert.equal(conditionAdvantage(new Set(), "attack", null, { dodge: true }).delta, 0);
  assert.equal(conditionAdvantage(new Set(["prone"]), "parry", "melee", { dodge: true }).delta, 0);
  assert.deepEqual(proneParry([9, 15, 3], 1), { melee: 9, ranged: 3 });
  assert.deepEqual(proneParry([9, 4, 15, 2], 2), { melee: 4, ranged: 2 });
  await consumeDodge(env.attacker); assert(!hasDodge(env.attacker));
  await applyDodge(env.attacker); await applyDodge(env.attacker);
  assert.equal(env.attacker.effects.length, 1, "Dodge does not stack with itself");
  await startOfTurn(env.attacker); assert(!hasDodge(env.attacker));
});

test("Hinder sends a hidden request and only the elected GM applies it for the authenticated source owner", async () => {
  const env = setup(); env.target();
  await useCombatAction(env.attacker, "hinder");
  const request = env.created[0];
  assert.deepEqual(request.whisper, ["gm", "player"]);
  assert(!env.defender.statuses.has("hindered"));
  assert.equal(await processCombatActionRequest(request, env.player.id), false, "a player cannot process it");
  game.user = env.gm;
  assert.equal(await processCombatActionRequest(request, env.player.id), true);
  assert(env.defender.statuses.has("hindered"));
  assert.match(env.created.at(-1).content, /their next attack has disadvantage/);
  assert(request.deleted);
  assert.equal(await processCombatActionRequest(request, env.player.id), false);
  assert.equal(env.defender.effectWrites, 1);
  await consumeHindered(env.defender); assert(!env.defender.statuses.has("hindered"));
});

test("GM request validation rejects spoofed hook authors, forged flag user IDs, bad targets and unauthorized Shove choices", async () => {
  const env = setup();
  for (const data of [
    { kind: "hinder", actorUuid: env.defender.uuid, targetUuid: env.attacker.uuid, userId: env.gm.id },
    { kind: "hinder", actorUuid: env.attacker.uuid, targetUuid: "missing" },
    { kind: "hinder", actorUuid: env.attacker.uuid, targetUuid: env.attacker.uuid },
    { kind: "hinder", actorUuid: env.attacker.uuid, targetUuid: env.defender.uuid, spoof: true },
    { kind: "shove", boardId: "missing", choice: "prone" },
    { kind: "shove", boardId: "missing", choice: "<script>" }
  ]) {
    game.user = env.player;
    const request = await ChatMessage.create({ flags: { incarnos: { actionRequest: data } } });
    game.user = env.gm;
    assert.equal(await processCombatActionRequest(request, data.spoof ? env.gm.id : env.player.id), false);
    assert(request.deleted);
  }
  assert.equal(env.attacker.effectWrites + env.defender.effectWrites, 0);
});

test("Shove offers a one-time choice to its winner/GM and push never moves a token", async () => {
  for (const choice of ["prone", "push"]) {
    const env = setup(); env.target(); env.totals.push(2, 7);
    const board = await useCombatAction(env.attacker, "shove");
    game.user = env.gm; await rollDefenderContest(env.created[1]); await resolveContestTie(env.created[1]);
    assert.match(board.content, /Knock Prone/); assert.match(board.content, /Pushed 2 m/);
    assert.equal(board.flags.incarnos.contestBoard.applied, undefined);
    assert.equal(await applyContestAction(board, choice), true);
    await refreshBoard(board);
    assert.equal(env.defender.statuses.has("prone"), choice === "prone");
    assert(!board.content.includes("data-incarnos-shove"));
    assert.equal(await applyContestAction(board, choice === "prone" ? "push" : "prone"), false);
    if (choice === "push") assert.match(board.content, /move the token by hand/);
  }
});

test("Insight adds level difficulty to Intelligence, handles nat 1/20, and Hide applies Hidden only on success", async () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 10].map(insightModifier), [2, 0, -2, -4, -6, -8, -10, -16]);
  for (const level of [undefined, null, NaN, Infinity]) assert.equal(insightModifier(level), 2);
  for (const [action, level, roll, success] of [
    ["insight", 1, 11, true], ["insight", 3, 9, false], ["insight", 10, 1, true], ["insight", 1, 20, false],
    ["hide", 1, 10, true], ["hide", 1, 11, false], ["hide", 1, 1, true], ["hide", 1, 20, false]
  ]) {
    const env = setup(); env.target(); env.defender.system.attributes.level.value = level; env.totals.push(roll);
    const card = await useCombatAction(env.attacker, action);
    assert.equal(card.content.includes(">Success"), success);
    if (action === "insight") {
      assert.equal(card.content.includes("Ask the GM one thing about Defender"), success);
      assert.match(card.content, new RegExp("≤ " + (10 + insightModifier(level))));
      assert.match(card.content, /Enemy difficulty/);
    } else assert.equal(env.attacker.statuses.has("hidden"), success);
  }
});

test("GM election, hidden request rendering and enemy/target validation prevent unintended actions", async () => {
  const env = setup();
  for (const action of ["hinder", "insight"]) await useCombatAction(env.attacker, action);
  assert.equal(env.formulas.length, 0); assert.equal(env.created.length, 0);
  env.player.targets.add({ actor: env.defender, document: { disposition: 1 } });
  await useCombatAction(env.attacker, "insight"); assert.equal(env.formulas.length, 0);
  env.player.targets.clear(); env.target();
  await useCombatAction(env.attacker, "hinder");
  env.users.push({ id: "z-gm", isGM: true, active: true }); game.user = env.users.at(-1);
  assert.equal(await processCombatActionRequest(env.created[0], env.player.id), false);
  assert.equal(env.defender.effectWrites, 0);
  const hooks = {};
  globalThis.Hooks = { on: (name, cb) => hooks[name] = cb, once: () => {} };
  registerCombatActionHooks();
  const html = { style: {} };
  hooks.renderChatMessageHTML(env.created[0], html);
  assert.equal(html.style.display, "none");
});

test("sheet Parry consumes Dodge on the actual roll and combines it with Hidden and Prone", async () => {
  const env = setup();
  globalThis.Item = class {};
  foundry.applications.api.HandlebarsApplicationMixin = Base => Base;
  foundry.applications.sheets = { ActorSheetV2: class {} };
  foundry.applications.ux = { TextEditor: { implementation: {} } };
  const { IncarnosActorSheet } = await import("../module/sheets/actor-sheet.mjs");
  const parry = () => IncarnosActorSheet.DEFAULT_OPTIONS.actions.roll.call({ actor: env.attacker }, { preventDefault() {} },
    { dataset: { roll: "d20", check: "parry" } });
  await applyDodge(env.attacker);
  await parry();
  assert.equal(env.formulas.at(-1), "2d20kl");
  assert(!hasDodge(env.attacker));
  assert.match(env.created.at(-1).content, /Dodge/);
  env.attacker.statuses.add("prone"); env.attacker.statuses.add("hidden");
  await applyDodge(env.attacker);
  await parry();
  assert.equal(env.formulas.at(-1), "4d20");
  assert(!hasDodge(env.attacker));
  assert.match(env.created.at(-1).content, /Prone, Hidden, Dodge/);
  assert.match(env.created.at(-1).content, /vs melee: 4/);
  assert.match(env.created.at(-1).content, /vs ranged: 2/);
  await parry();
  assert.equal(env.formulas.at(-1), "3d20");
  assert(!env.created.at(-1).content.includes("Dodge"));
});

test("timed contest wins flag the target and expire through normal turn handling", async () => {
  for (const [action, condition] of [["intimidate", "intimidated"], ["taunt", "taunted"]]) {
    const env = setup(); env.target(); env.totals.push(2, 7);
    game.combat = { id: "combat", round: 1, turn: 0 };
    const board = await useCombatAction(env.attacker, action);
    game.user = env.gm; await rollDefenderContest(env.created[1]); await resolveContestTie(env.created[1]);
    assert(env.defender.statuses.has(condition));
    assert.equal(env.defender.effects[0].getFlag("incarnos", "untilEndOfTurn"), true);
    await endOfTurn(env.defender, "combat:1:1");
    assert(!env.defender.statuses.has(condition));
    await refreshBoard(board);
    assert(!env.defender.statuses.has(condition), "expired effects cannot return when the board refreshes");
  }
});

test("Shove controls are offered only to the winning side's owner or GM and a player's choice is delegated", async () => {
  const env = setup(); env.target(); env.totals.push(2, 7);
  const board = await useCombatAction(env.attacker, "shove");
  game.user = env.gm; await rollDefenderContest(env.created[1]); await resolveContestTie(env.created[1]);
  const hooks = {};
  globalThis.Hooks = { on: (name, cb) => hooks[name] = cb, once: () => {} };
  registerCombatActionHooks();
  const button = () => ({ style: {}, dataset: { incarnosShove: "prone" },
    remove() { this.removed = true; }, addEventListener(event, fn) { this.click = fn; } });
  const render = async user => {
    game.user = user;
    const control = button();
    hooks.renderChatMessageHTML(board, { querySelectorAll: () => [control] });
    await Promise.resolve(); await Promise.resolve();
    return control;
  };
  assert.equal((await render(env.other)).removed, true);
  assert.equal(typeof (await render(env.gm)).click, "function");
  const control = await render(env.player);
  await control.click();
  const request = env.created.at(-1);
  assert.equal(env.defender.effectWrites, 0);
  game.user = env.gm;
  assert.equal(await processCombatActionRequest(request, env.player.id), true);
  assert(env.defender.statuses.has("prone"));
  game.user = env.other;
  const denied = await ChatMessage.create({ flags: { incarnos: { actionRequest: { kind: "shove", boardId: board.id, choice: "push", userId: env.gm.id } } } });
  game.user = env.gm;
  assert.equal(await processCombatActionRequest(denied, env.other.id), false);
});

test("Insight supports legacy level storage and does not roll without an enemy", async () => {
  const env = setup();
  await useCombatAction(env.attacker, "insight");
  assert.equal(env.formulas.length, 0);
  env.target(); delete env.defender.system.attributes.level;
  env.defender.system.level = { value: 4 }; env.totals.push(6);
  const card = await useCombatAction(env.attacker, "insight");
  assert.match(card.content, /≤ 6/);
  assert.match(card.content, /-4 · Enemy difficulty/);
});
