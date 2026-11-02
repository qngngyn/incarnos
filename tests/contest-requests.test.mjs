import assert from "node:assert/strict";
import { test } from "node:test";
import { showContestDialog, waitForContestAnimations, resolveContestTie, promptDefenderContest, registerContestRequestHooks, getContestDie, getContestDefender, requestDefenderContest, rollDefenderContest, processContestResponse, completeDefenderContest, refreshBoard, rollBoardSide, cancelContest } from "../module/helpers/contest-requests.mjs";

let nextMessageId = 0;

function setup() {
  const actors = new Map();
  const actor = (id, owner, save = 5) => {
    const value = { id, uuid: "Actor." + id, name: id, system: { abilities: { str: { value: 8, save } } }, testUserPermission: user => user.id === owner };
    actors.set(value.uuid, value);
    return value;
  };
  const attacker = actor("Attacker", "attacker-user");
  const defender = actor("Defender", "defender-user");
  const gm = { id: "gm", isGM: true, active: true };
  const attackUser = { id: "attacker-user", isGM: false, active: true, character: attacker, targets: new Set() };
  const defendUser = { id: "defender-user", isGM: false, active: true, character: defender };
  const users = [gm, attackUser, defendUser];
  users.get = id => users.find(user => user.id === id);
  const messages = new Map();
  const created = [];
  const warnings = [];
  let rollCount = 0;
  globalThis.game = { user: attackUser, users, messages };
  globalThis.ui = { notifications: { warn: text => warnings.push(text) } };
  globalThis.fromUuid = async uuid => actors.get(uuid);
  const prompts = [];
  globalThis.foundry = { applications: { api: { DialogV2: {
    prompt: async options => {
      prompts.push(options);
      if (!options.content.includes("<select")) return options.ok.callback();
      const selected = options.content.match(/value="([^"]+)" selected/)[1];
      return options.ok.callback(null, { form: { elements: { stat: { value: selected } } } });
    }
  } } } };
  globalThis.ChatMessage = {
    getSpeaker: ({ actor }) => ({ actor: actor.id }),
    create: async data => {
      const message = { ...structuredClone(data), id: "message-" + nextMessageId++, author: game.user, updates: [],
        async update(change) {
          this.updates.push(change);
          for (const [key, value] of Object.entries(change)) {
            if (key === "author") { this.author = game.users.get(value); continue; }
            // Dotted keys update nested data, like Foundry's document updates.
            const path = key.split(".");
            let target = this;
            for (const part of path.slice(0, -1)) target = target[part] ??= {};
            target[path.at(-1)] = value;
          }
        },
        async delete() { this.deleted = true; messages.delete(this.id); }
      };
      created.push(message); messages.set(message.id, message);
      return message;
    }
  };
  globalThis.Roll = class {
    constructor(formula) { this.formula = formula; this.total = Math.min(7, Number(formula.replace(/^1?d/, ""))); this._evaluated = false; }
    async evaluate() { rollCount++; this._evaluated = true; return this; }
    toJSON() { return { formula: this.formula, total: this.total, evaluated: this._evaluated }; }
    async render() { return "<div>" + this.formula + ": " + this.total + "</div>"; }
    static fromData(data) { const roll = new this(data.formula); roll.total = data.total; roll._evaluated = data.evaluated; return roll; }
  };
  return { attacker, defender, attackUser, defendUser, gm, users, created, warnings, actor, prompts, rollCount: () => rollCount };
}

async function request(env) {
  return requestDefenderContest({ attacker: env.attacker, defender: { actor: env.defender, playerId: env.defendUser.id }, attackMessage: { id: "attack-message" }, stat: "Strength" });
}

test("defender comes from the targeted owner's configured character, with no right-click HUD fallback", () => {
  const env = setup();
  const other = env.actor("Owned summon", env.defendUser.id);
  env.attackUser.targets.add({ actor: other, document: { uuid: "token" } });
  const selected = getContestDefender(env.attacker);
  assert.equal(selected.actor, env.defender);
  assert.equal(selected.playerId, env.defendUser.id);
  env.attackUser.targets.add({ actor: env.defender });
  assert.match(getContestDefender(env.attacker).error, /only one/);
  env.attackUser.targets.clear();
  globalThis.canvas = { tokens: { hud: { object: { actor: env.defender } } } };
  assert.match(getContestDefender(env.attacker).error, /Target a defender/);
});

test("private request routes to assigned defender, attacker and GM and escapes character names", async () => {
  const env = setup();
  env.attacker.name = '<img src=x onerror="alert(1)">';
  const card = await request(env);
  assert.deepEqual(card.whisper.sort(), ["attacker-user", "defender-user", "gm"]);
  assert.equal(card.flags.incarnos.contestRequest.defenderUuid, env.defender.uuid);
  assert.equal(card.flags.incarnos.contestRequest.stat, "Strength");
  assert.match(card.content, /Roll Contest/);
  assert(card.flavor.replace(/<[^>]*>/g, "").includes(" vs. Defender"));
  assert(card.flavor.includes("#c62828"));
  assert(card.flavor.includes("#2e7d32"));
  assert(!card.flavor.includes("<img"));
  assert(!card.content.includes('<img'));
  assert(card.content.includes('&lt;img'));
});

test("player response is authenticated and updates the existing card once via the GM", async () => {
  const env = setup();
  const card = await request(env);
  game.user = env.defendUser;
  await rollDefenderContest(card);
  await rollDefenderContest(card);
  assert.equal(env.rollCount(), 1);
  assert.equal(env.created.length, 2);
  const response = env.created[1];
  assert.deepEqual(response.whisper, ["gm", "defender-user"]);
  game.user = env.gm;
  await processContestResponse(response, env.defendUser.id);
  assert.equal(card.flags.incarnos.contestRequest.status, "complete");
  assert.equal(card.updates.length, 1);
  assert.deepEqual(card.whisper, []);
  assert.equal(card.blind, false);
  assert.equal(card.flavor, "");
  assert.equal(card.rolls[0].formula, "d15");
  assert.equal(card.author.id, env.defendUser.id);
  assert.equal(card.flags.incarnos.contestRequest.requestAuthorId, env.attackUser.id);
  assert.equal(card.content, "<p>Defender: Strength 5, d15 → 7</p>");
  assert.equal(card.flags.incarnos.contestRequest.responseValue, 5);
  assert.equal(card.flags.incarnos.contestRequest.responseDie, 15);
  assert(response.deleted);
  await rollDefenderContest(card);
  assert.equal(env.rollCount(), 1);
});

test("nonowners cannot roll or submit a defender's response", async () => {
  const env = setup();
  const card = await request(env);
  await rollDefenderContest(card); // Attacker does not own the defender.
  assert.equal(env.rollCount(), 0);
  const response = { requestId: card.id, value: 5, roll: { formula: "d15", total: 7, evaluated: true } };
  assert.equal(await completeDefenderContest(card, env.defender, response, env.attackUser.id), false);
  assert.equal(card.updates.length, 0);
  assert.deepEqual(card.whisper.sort(), ["attacker-user", "defender-user", "gm"]);
});

test("GM may roll for NPCs directly without a second response message", async () => {
  const env = setup();
  const card = await request(env);
  game.user = env.gm;
  await rollDefenderContest(card);
  assert.equal(env.created.length, 1);
  assert.equal(card.flags.incarnos.contestRequest.status, "complete");
});

test("no online GM and invalid dice are reported without sending or rolling", async () => {
  let env = setup();
  env.gm.active = false;
  assert.equal(await request(env), null);
  assert.equal(env.created.length, 0);
  assert.match(env.warnings[0], /GM must be online/);
  env = setup();
  const card = await request(env);
  env.defender.system.abilities.str.save = NaN;
  game.user = env.defendUser;
  await rollDefenderContest(card);
  assert.equal(env.rollCount(), 0);
  assert.equal(card.flags.incarnos.contestRequest.status, "pending");
  assert.deepEqual(card.whisper.sort(), ["attacker-user", "defender-user", "gm"]);
  assert.match(env.warnings[0], /valid contest die/);
});

test("forged authors and incorrect dice cannot complete a request", async () => {
  const env = setup();
  const card = await request(env);
  const payload = { requestId: card.id, value: 5, roll: { formula: "d20", total: 7, evaluated: true } };
  assert.equal(await completeDefenderContest(card, env.defender, payload, env.defendUser.id), false);
  const packet = await ChatMessage.create({ flags: { incarnos: { contestResponse: payload } } });
  game.user = env.gm;
  await processContestResponse(packet, env.defendUser.id);
  assert.equal(card.updates.length, 0);
  assert(packet.deleted);
});


test("an unanswered or declined defender request stays private and cannot publish a roll", async () => {
  const env = setup();
  const card = await request(env);
  const recipients = [...card.whisper];
  assert.equal(card.flags.incarnos.contestRequest.status, "pending");
  assert.deepEqual(card.whisper, recipients);
  card.flags.incarnos.contestRequest.status = "declined";
  game.user = env.defendUser;
  await rollDefenderContest(card);
  assert.equal(env.rollCount(), 0);
  assert.equal(card.updates.length, 0);
  assert.deepEqual(card.whisper, recipients);
});


test("defender dialog defaults to the requested save and lists all saving throws", async () => {
  const env = setup();
  const card = await request(env);
  game.user = env.gm;
  await rollDefenderContest(card);
  assert.equal(env.prompts.length, 1);
  assert.match(env.prompts[0].content, /value="Strength" selected/);
  assert.equal((env.prompts[0].content.match(/<option /g) ?? []).length, 8);
  assert.equal(card.flags.incarnos.contestRequest.responseStat, "Strength");
});

test("a changed saving throw determines the defender die, GM validation and public result", async () => {
  const env = setup();
  env.defender.system.abilities.dex = { value: 2, save: 11 };
  const card = await request(env);
  game.user = env.defendUser;
  foundry.applications.api.DialogV2.prompt = async options => options.ok.callback(null, { form: { elements: { stat: { value: "Dexterity" } } } });
  await rollDefenderContest(card);
  const packet = env.created[1];
  assert.equal(packet.flags.incarnos.contestResponse.stat, "Dexterity");
  assert.equal(packet.flags.incarnos.contestResponse.value, 11);
  assert.equal(packet.flags.incarnos.contestResponse.roll.formula, "d9");
  game.user = env.gm;
  await processContestResponse(packet, env.defendUser.id);
  assert.equal(card.flags.incarnos.contestRequest.stat, "Strength");
  assert.equal(card.flags.incarnos.contestRequest.responseStat, "Dexterity");
  assert.equal(card.content, "<p>Defender: Dexterity 11, d9 → 7</p>");
  assert.equal(card.flags.incarnos.contestRequest.responseDie, 9);
  assert.deepEqual(card.whisper, []);
  assert.equal(card.updates.length, 1);
});

test("closing the save chooser keeps the request private and allows a later retry", async () => {
  const env = setup();
  const card = await request(env);
  game.user = env.gm;
  const defaultPrompt = foundry.applications.api.DialogV2.prompt;
  foundry.applications.api.DialogV2.prompt = async () => null;
  await rollDefenderContest(card);
  assert.equal(env.rollCount(), 0);
  assert.equal(card.updates.length, 0);
  assert.equal(card.flags.incarnos.contestRequest.status, "pending");
  assert(card.whisper.length > 0);
  foundry.applications.api.DialogV2.prompt = defaultPrompt;
  await rollDefenderContest(card);
  assert.equal(env.rollCount(), 1);
  assert.equal(card.flags.incarnos.contestRequest.status, "complete");
});

test("unsupported saving throws cannot be rolled or accepted by the GM", async () => {
  const env = setup();
  const card = await request(env);
  game.user = env.gm;
  foundry.applications.api.DialogV2.prompt = async () => "Unknown";
  await rollDefenderContest(card);
  assert.equal(env.rollCount(), 0);
  assert.match(env.warnings[0], /valid saving throw/);
  assert.equal(await completeDefenderContest(card, env.defender, { stat: "Unknown", value: 5, roll: { formula: "d15", total: 7, evaluated: true } }, env.defendUser.id), false);
  assert.equal(card.updates.length, 0);
  assert(card.whisper.length > 0);
});


test("contest dice improve down to d2 and stay there for higher stats", () => {
  for (const [value, die] of [[5, 15], [17, 3], [18, 2], [19, 2], [20, 2], [25, 2]]) {
    assert.equal(getContestDie(value), die);
  }
  for (const value of [NaN, Infinity, 18.5]) assert(Number.isNaN(getContestDie(value)));
});

test("high defender saves roll d2 and the GM accepts the capped response", async () => {
  const env = setup();
  env.defender.system.abilities.str.save = 25;
  const card = await request(env);
  game.user = env.defendUser;
  await rollDefenderContest(card);
  const packet = env.created[1];
  assert.equal(packet.flags.incarnos.contestResponse.roll.formula, "d2");
  game.user = env.gm;
  await processContestResponse(packet, env.defendUser.id);
  assert.equal(card.flags.incarnos.contestRequest.status, "complete");
  assert.equal(card.rolls[0].formula, "d2");
  assert.deepEqual(card.whisper, []);
});


test("popup requests open only for the assigned defender and do not reopen on duplicate events", async () => {
  const env = setup();
  const card = await request(env);
  await promptDefenderContest(card);
  game.user = env.gm;
  await promptDefenderContest(card);
  assert.equal(env.prompts.length, 0);
  game.user = env.defendUser;
  await promptDefenderContest(card);
  await promptDefenderContest(card);
  assert.equal(env.prompts.length, 1);
  assert.match(env.prompts[0].content.replace(/<[^>]*>/g, ""), /Attacker challenges you!/);
  assert.equal(env.rollCount(), 1);
});

test("NPC popup goes to the elected GM and request cards stay hidden; results show on the board", async () => {
  const env = setup();
  const npc = env.actor("NPC", "gm");
  const card = await requestDefenderContest({ attacker: env.attacker, defender: { actor: npc }, attackMessage: { id: "attack" }, stat: "Strength" });
  const hooks = {};
  globalThis.Hooks = { on: (name, callback) => { hooks[name] = callback; }, once: (name, callback) => { hooks[name] = callback; } };
  registerContestRequestHooks();
  const hidden = { style: {}, querySelector: () => null };
  hooks.renderChatMessageHTML(card, hidden);
  assert.equal(hidden.style.display, "none");
  game.user = env.defendUser;
  await promptDefenderContest(card);
  assert.equal(env.prompts.length, 0);
  game.user = env.gm;
  await promptDefenderContest(card);
  assert.equal(env.prompts.length, 1);
  assert.equal(card.flags.incarnos.contestRequest.status, "complete");
  assert.deepEqual(card.whisper, []);
  const completed = { style: {}, querySelector: () => null };
  hooks.renderChatMessageHTML(card, completed);
  assert.equal(completed.style.display, "none");
});


/** A round-1 contest board (the attacker's card, carrying the attack roll) plus its completed save request. */
async function completedPair(env, attackTotal, saveTotal) {
  const attack = await ChatMessage.create({
    content: "attack board", rolls: attackTotal === null ? [] : [{ total: attackTotal }],
    flags: { incarnos: { contestBoard: { round: 1, stat: "Strength",
      attacker: { uuid: env.attacker.uuid, name: "Attacker", stat: "Strength", value: 8, die: 12, role: "attack" },
      defender: { uuid: env.defender.uuid, name: "Defender" } } } }
  });
  const save = await requestDefenderContest({ attacker: env.attacker, defender: { actor: env.defender, playerId: env.defendUser.id }, attackMessage: attack, stat: "Strength" });
  save.flags.incarnos.contestRequest.status = "complete";
  save.flags.incarnos.contestRequest.responseStat = "Dexterity";
  save.rolls = [{ total: saveTotal }];
  save.content = "save result";
  return { attack, save };
}

test("a tie shows on the board and starts a new board with one popup request per contestant", async () => {
  const env = setup();
  const { attack, save } = await completedPair(env, 4, 4);
  game.user = env.gm;
  const waitedIds = [];
  let finishAnimation;
  const animation = new Promise(resolve => { finishAnimation = resolve; });
  game.dice3d = { waitFor3DAnimationByMessageID: id => { waitedIds.push(id); return animation; } };
  const resolution = Promise.all([resolveContestTie(save), resolveContestTie(attack)]);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert(!attack.content.includes("Tie!"), "nothing is revealed before the dice land");
  assert.equal(env.created.length, 2);
  assert.deepEqual(waitedIds.sort(), [attack.id, save.id].sort());
  finishAnimation();
  await resolution;
  await resolveContestTie(save);
  // The round-1 board shows the tie; round 2 gets its own board.
  assert(attack.content.includes("Tie! Both roll again"));
  assert.equal(attack.flags.incarnos.contestOutcome.tie, true);
  assert.equal((attack.content.match(/>Tie</g) ?? []).length, 2);
  assert.equal(env.created.length, 5);
  const nextBoard = env.created[2];
  assert.equal(nextBoard.flags.incarnos.contestBoard.round, 2);
  assert.deepEqual(nextBoard.whisper, []);
  const [nextAttack, nextSave] = env.created.slice(3);
  assert.equal(nextAttack.flags.incarnos.contestRequest.boardId, nextBoard.id);
  assert.equal(nextSave.flags.incarnos.contestRequest.boardId, nextBoard.id);
  assert(nextBoard.content.includes("Round 2"));
  assert.equal((nextBoard.content.match(/Waiting/g) ?? []).length, 2);
  assert.equal(nextAttack.flags.incarnos.contestRequest.role, "attack");
  assert.equal(nextAttack.flags.incarnos.contestRequest.defenderUuid, env.attacker.uuid);
  assert.equal(nextAttack.flags.incarnos.contestRequest.recipientUserId, env.attackUser.id);
  assert.equal(nextAttack.flags.incarnos.contestRequest.stat, "Strength");
  assert.equal(nextSave.flags.incarnos.contestRequest.role, "save");
  assert.equal(nextSave.flags.incarnos.contestRequest.recipientUserId, env.defendUser.id);
  assert.equal(nextSave.flags.incarnos.contestRequest.stat, "Dexterity");
  assert.equal(nextSave.flags.incarnos.contestRequest.attackMessageId, nextAttack.id);
  for (const card of [nextAttack, nextSave]) {
    assert.equal(card.flags.incarnos.contestRequest.popup, true);
    assert.equal(card.flags.incarnos.contestRequest.status, "pending");
  }
  game.user = env.attackUser;
  await promptDefenderContest(nextAttack);
  const response = env.created[5];
  assert.match(env.prompts[0].window.title, /TIE!/);
  assert(!env.prompts[0].content.includes("<select"));
  assert.equal(env.prompts[0].ok.label, "Roll!");
  assert.equal(response.flags.incarnos.contestResponse.value, 8); // Attack, not save 5.
  assert.equal(response.flags.incarnos.contestResponse.roll.formula, "d12");
  game.user = env.gm;
  await processContestResponse(response, env.attackUser.id);
  assert.equal(nextAttack.flags.incarnos.contestRequest.status, "complete");
  await refreshBoard(nextBoard);
  assert(nextBoard.content.includes("Attack <small>Strength 8</small>"), "the reroll's attack side shows on the round-2 board");
});

test("tie detection waits for both results and also works when the attacker finishes last", async () => {
  const env = setup();
  const { attack, save } = await completedPair(env, null, 3);
  game.user = env.gm;
  await resolveContestTie(save);
  assert.equal(env.created.length, 2);
  attack.rolls = [{ total: 3 }];
  await resolveContestTie(attack);
  assert.equal(env.created.length, 5);
});

test("unequal results, including two even numbers, do not trigger a reroll", async () => {
  const env = setup();
  const { attack, save } = await completedPair(env, 2, 4);
  game.user = env.gm;
  await resolveContestTie(save);
  assert.equal(env.created.length, 2, "no new messages: the result shows on the board");
  assert(attack.content.includes("Attacker wins!"));
  assert(!attack.content.includes("Tie"));
});

test("another tied reroll starts another pair and only the active GM resolves ties", async () => {
  const env = setup();
  const { save } = await completedPair(env, 2, 2);
  await resolveContestTie(save);
  assert.equal(env.created.length, 2);
  game.user = env.gm;
  await resolveContestTie(save);
  const [nextAttack, nextSave] = env.created.slice(3);
  for (const card of [nextAttack, nextSave]) {
    card.flags.incarnos.contestRequest.status = "complete";
    card.rolls = [{ total: 1 }];
    card.content = "reroll result";
  }
  await resolveContestTie(nextSave);
  assert.equal(env.created.length, 8);
  assert(env.created[2].content.includes("Tie! Both roll again"), "round 2 shows its tie");
  assert.equal(env.created[5].flags.incarnos.contestBoard.round, 3);
  assert(env.created[5].content.includes("Round 3"));
});


test("defender tie reroll has only Roll and keeps the previous saving throw", async () => {
  const env = setup();
  env.defender.system.abilities.dex = { value: 2, save: 11 };
  const card = await request(env);
  Object.assign(card.flags.incarnos.contestRequest, { reroll: true, role: "save", stat: "Dexterity" });
  game.user = env.gm;
  await rollDefenderContest(card);
  assert.equal(env.prompts.length, 1);
  assert(!env.prompts[0].content.includes("<select"));
  assert.equal(env.prompts[0].ok.label, "Roll!");
  assert.equal(card.flags.incarnos.contestRequest.responseStat, "Dexterity");
  assert.equal(card.rolls[0].formula, "d9");
});


test("reroll popup waits for the receiving player's animations before opening", async () => {
  const env = setup();
  const card = await request(env);
  Object.assign(card.flags.incarnos.contestRequest, { reroll: true, previousMessageIds: ["previous-attack", "previous-save"] });
  game.user = env.defendUser;
  let finish;
  const animation = new Promise(resolve => { finish = resolve; });
  const waited = [];
  game.dice3d = { waitFor3DAnimationByMessageID: id => { waited.push(id); return animation; } };
  const popup = promptDefenderContest(card);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(env.prompts.length, 0);
  assert.deepEqual(waited, ["previous-attack", "previous-save"]);
  finish();
  await popup;
  assert.equal(env.prompts.length, 1);
});

test("animation waiting proceeds immediately when no dice animation provider is installed", async () => {
  setup();
  await waitForContestAnimations(["attack", "save"]);
});


test("the lower total wins and the result appears on the same board, no extra messages", async () => {
  for (const [attackTotal, saveTotal, winner, name] of [
    [2, 4, "attack", "Attacker"],
    [6, 1, "defender", "Defender"]
  ]) {
    const env = setup();
    const { attack, save } = await completedPair(env, attackTotal, saveTotal);
    game.user = env.gm;
    await Promise.all([resolveContestTie(attack), resolveContestTie(save)]);
    await resolveContestTie(save);
    assert.equal(env.created.length, 2);
    assert(attack.content.includes('class="isc-name">' + name + " wins!</span>"));
    assert(attack.content.includes('isc-chip isc-good" title="Lower total wins">Winner'));
    assert(attack.content.includes('isc-chip isc-bad" title="Lower total wins">Lost'));
    assert(!attack.content.includes("Lower total wins</span>"), "the rule is a tooltip, not text");
    assert(!attack.content.includes("Cancel contest"), "a resolved contest has no Cancel button");
    for (const card of [attack, save]) assert.equal(card.flags.incarnos.contestOutcome.winner, winner);
    assert(save.flags.incarnos.contestRequest.outcomeProcessed);
  }
});

test("the board shows the result only after the dice animation", async () => {
  const env = setup();
  const { attack, save } = await completedPair(env, 1, 3);
  game.user = env.gm;
  let finish;
  const animation = new Promise(resolve => { finish = resolve; });
  game.dice3d = { waitFor3DAnimationByMessageID: () => animation };
  const resolution = resolveContestTie(save);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert(!attack.content.includes("wins!"));
  finish();
  await resolution;
  assert.equal(env.created.length, 2);
  assert(attack.content.includes("Attacker wins!"));
});

test("only one client writes the board: the active GM, or the author when no GM is online", async () => {
  const env = setup();
  const { attack } = await completedPair(env, 2, 5);
  game.user = env.attackUser;
  await refreshBoard(attack);
  assert.equal(attack.updates.length, 0, "a player does not write while a GM is online");
  env.gm.active = false;
  attack.author = env.attackUser;
  await refreshBoard(attack);
  assert(attack.updates.length >= 1);
  assert(attack.content.includes("Strength contest"));
});

test("a waiting side gets a Roll button for its owner only; the GM gets Cancel", async () => {
  const env = setup();
  const attack = await ChatMessage.create({ content: "", rolls: [], flags: { incarnos: { contestBoard: { round: 1, stat: "Strength",
    attacker: { uuid: env.attacker.uuid, name: "Attacker", stat: "Strength", value: 8, die: 12, role: "attack" },
    defender: { uuid: env.defender.uuid, name: "Defender" } } } } });
  attack.author = env.attackUser;
  await requestDefenderContest({ attacker: env.attacker, defender: { actor: env.defender, playerId: env.defendUser.id }, attackMessage: attack, stat: "Strength" });
  game.user = env.gm;
  await refreshBoard(attack);
  assert.equal((attack.content.match(/data-incarnos-contest-roll=/g) ?? []).length, 2);
  assert(attack.content.includes("data-incarnos-contest-cancel"));
  const hooks = {};
  globalThis.Hooks = { on: (name, callback) => { hooks[name] = callback; }, once: (name, callback) => { hooks[name] = callback; } };
  registerContestRequestHooks();
  const rendered = user => {
    game.user = user;
    const button = key => ({ dataset: { incarnosContestRoll: key }, style: {}, removed: false, remove() { this.removed = true; }, addEventListener() {} });
    const buttons = [button("attack"), button("save")];
    const cancel = { dataset: {}, removed: false, remove() { this.removed = true; }, addEventListener() {} };
    hooks.renderChatMessageHTML(attack, { style: {}, querySelectorAll: selector => selector.includes("cancel") ? [cancel] : buttons });
    return { buttons, cancel };
  };
  const forDefender = rendered(env.defendUser);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  const forAttacker = rendered(env.attackUser);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.deepEqual(forDefender.buttons.map(button => button.removed), [true, false]);
  assert.deepEqual(forAttacker.buttons.map(button => button.removed), [false, true]);
  assert(forDefender.cancel.removed && forAttacker.cancel.removed, "players cannot cancel");
});

test("after a disconnect the attacker can still roll from the board", async () => {
  const env = setup();
  const attack = await ChatMessage.create({ content: "", rolls: [], flags: { incarnos: { contestBoard: { round: 1, stat: "Strength",
    attacker: { uuid: env.attacker.uuid, name: "Attacker", stat: "Strength", value: 8, die: 12, role: "attack" }, defender: null } } } });
  attack.author = env.attackUser;
  game.user = env.defendUser;
  assert.equal(await rollBoardSide(attack), false, "someone else cannot roll the attacker's side");
  assert.equal(attack.rolls.length, 0);
  game.user = env.attackUser;
  assert.equal(await rollBoardSide(attack), true);
  assert.equal(attack.rolls[0].formula, "d12");
  assert.equal(await rollBoardSide(attack), false, "a side is rolled only once");
});

test("a cancelled contest closes its requests and rejects late responses", async () => {
  const env = setup();
  const attack = await ChatMessage.create({ content: "", rolls: [{ total: 2 }], flags: { incarnos: { contestBoard: { round: 1, stat: "Strength",
    attacker: { uuid: env.attacker.uuid, name: "Attacker", stat: "Strength", value: 8, die: 12, role: "attack" },
    defender: { uuid: env.defender.uuid, name: "Defender" } } } } });
  const pending = await requestDefenderContest({ attacker: env.attacker, defender: { actor: env.defender, playerId: env.defendUser.id }, attackMessage: attack, stat: "Strength" });
  game.user = env.defendUser;
  await rollDefenderContest(pending);
  const lateResponse = env.created.at(-1);
  game.user = env.attackUser;
  await cancelContest(attack);
  assert.notEqual(attack.flags.incarnos.contestBoard.cancelled, true, "players cannot cancel");
  game.user = env.gm;
  await cancelContest(attack);
  assert.equal(attack.flags.incarnos.contestBoard.cancelled, true);
  assert.equal(pending.flags.incarnos.contestRequest.status, "cancelled");
  assert(attack.content.includes("Contest cancelled"));
  assert(!attack.content.includes("data-incarnos-contest-roll"));
  await processContestResponse(lateResponse, env.defendUser.id);
  assert.equal(pending.flags.incarnos.contestRequest.status, "cancelled");
  assert(lateResponse.deleted);
});

test("on reload the GM finishes recent open contests from their boards without reopening popups", async () => {
  const env = setup();
  const { attack, save } = await completedPair(env, 2, 5); // Completed while the GM was away.
  const other = await ChatMessage.create({ content: "", rolls: [{ total: 9 }], flags: { incarnos: { contestBoard: { round: 1, stat: "Strength",
    attacker: { uuid: env.attacker.uuid, name: "Attacker", stat: "Strength", value: 8, die: 12, role: "attack" },
    defender: { uuid: env.defender.uuid, name: "Defender" } } } } });
  const pending = await requestDefenderContest({ attacker: env.attacker, defender: { actor: env.defender, playerId: env.defendUser.id }, attackMessage: other, stat: "Strength" });
  game.user = env.defendUser;
  await rollDefenderContest(pending);
  const leftover = env.created.at(-1); // A response the GM never processed.
  for (const message of env.created) message.timestamp = Date.now();
  game.user = env.attackUser;
  const old = await completedPair(env, 3, 3); // An old tie: left alone.
  for (const message of [old.attack, old.save]) message.timestamp = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const before = env.created.length;
  const promptsBefore = env.prompts.length;
  game.user = env.gm;
  const hooks = {};
  globalThis.Hooks = { on: (name, callback) => { hooks[name] = callback; }, once: (name, callback) => { hooks[name] = callback; } };
  registerContestRequestHooks();
  await hooks.ready();
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(env.prompts.length, promptsBefore, "no popups reopen on reload");
  assert.equal(pending.flags.incarnos.contestRequest.status, "complete");
  assert(leftover.deleted);
  assert(attack.content.includes("Attacker wins!"));
  assert(save.flags.incarnos.contestRequest.outcomeProcessed);
  assert(other.content.includes("Defender wins!"), "the leftover response was processed and resolved");
  assert.equal(old.save.flags.incarnos.contestRequest.tieProcessed, undefined, "old contests stay untouched");
  assert.equal(env.created.length, before, "no new messages");
});

test("new requests still open from live chat events after hooks are registered", async () => {
  const env = setup();
  const hooks = {};
  globalThis.Hooks = { on: (name, callback) => { hooks[name] = callback; }, once: () => {} };
  registerContestRequestHooks();
  const card = await request(env);
  game.user = env.defendUser;
  hooks.createChatMessage(card, {}, env.attackUser.id);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(env.prompts.length, 1);
  assert.equal(env.rollCount(), 1);
});


const flushMicrotasks = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

test("overlapping defender requests queue without replacing the active popup and both roll", async () => {
  const env = setup();
  const first = await request(env);
  const second = await request(env);
  game.user = env.defendUser;
  const dialogs = [];
  let finishFirst;
  foundry.applications.api.DialogV2.prompt = options => {
    dialogs.push(options);
    return dialogs.length === 1 ? new Promise(resolve => { finishFirst = resolve; }) : Promise.resolve("Strength");
  };
  const firstRoll = promptDefenderContest(first);
  const secondRoll = promptDefenderContest(second);
  await flushMicrotasks();
  assert.equal(dialogs.length, 1);
  assert.equal(env.rollCount(), 0);
  finishFirst("Strength");
  await Promise.all([firstRoll, secondRoll]);
  assert.equal(dialogs.length, 2);
  assert.notEqual(dialogs[0].id, dialogs[1].id);
  assert.equal(env.rollCount(), 2);
  game.user = env.gm;
  for (const packet of env.created.slice(2)) await processContestResponse(packet, env.defendUser.id);
  assert.equal(first.flags.incarnos.contestRequest.status, "complete");
  assert.equal(second.flags.incarnos.contestRequest.status, "complete");
  assert.equal(first.updates.length, 1);
  assert.equal(second.updates.length, 1);
});

test("a queued request completed elsewhere is skipped rather than reopening a stale popup", async () => {
  const env = setup();
  const first = await request(env);
  const second = await request(env);
  game.user = env.gm;
  let finish;
  let dialogCount = 0;
  foundry.applications.api.DialogV2.prompt = () => { dialogCount++; return new Promise(resolve => { finish = resolve; }); };
  const firstRoll = rollDefenderContest(first);
  const secondRoll = rollDefenderContest(second);
  await flushMicrotasks();
  second.flags.incarnos.contestRequest.status = "complete";
  finish("Strength");
  await Promise.all([firstRoll, secondRoll]);
  assert.equal(dialogCount, 1);
  assert.equal(env.rollCount(), 1);
});

test("failed and cancelled dialogs release the queue for subsequent contest windows", async () => {
  setup();
  const dialogs = [];
  foundry.applications.api.DialogV2.prompt = async options => {
    dialogs.push(options);
    if (options.window.title === "fail") throw new Error("Dialog failed");
    return options.window.title === "cancel" ? null : "Strength";
  };
  const failed = showContestDialog("prompt", { window: { title: "fail" } });
  const cancelled = showContestDialog("prompt", { window: { title: "cancel" } });
  const next = showContestDialog("prompt", { window: { title: "next" } });
  await assert.rejects(failed, /Dialog failed/);
  assert.equal(await cancelled, null);
  assert.equal(await next, "Strength");
  assert.equal(new Set(dialogs.map(dialog => dialog.id)).size, 3);
});

test("a cancelled defender window does not prevent the next queued request from rolling", async () => {
  const env = setup();
  const first = await request(env);
  const second = await request(env);
  game.user = env.gm;
  let opened = 0;
  foundry.applications.api.DialogV2.prompt = async () => ++opened === 1 ? null : "Strength";
  await Promise.all([rollDefenderContest(first), rollDefenderContest(second)]);
  assert.equal(first.flags.incarnos.contestRequest.status, "pending");
  assert.equal(second.flags.incarnos.contestRequest.status, "complete");
  assert.equal(env.rollCount(), 1);
});


test("defender result author is the roller and completion still resolves the original contest", async () => {
  const env = setup();
  const attack = await ChatMessage.create({ content: "attack result", flavor: "Attack Contest", rolls: [{ total: 3 }] });
  const card = await requestDefenderContest({ attacker: env.attacker, defender: { actor: env.defender, playerId: env.defendUser.id }, attackMessage: attack, stat: "Strength" });
  game.user = env.defendUser;
  await rollDefenderContest(card);
  const response = env.created[2];
  game.user = env.gm;
  await processContestResponse(response, env.defendUser.id);
  // Mirrors Dice So Nice's "mine" visibility: a player's result must be authored by that player.
  assert.equal(card.author, env.defendUser);
  assert.equal(card.updates[0].author, env.defendUser.id);
  assert.equal(card.flags.incarnos.contestRequest.requestAuthorId, env.attackUser.id);
  await resolveContestTie(card);
  assert.equal(env.created[3].flags.incarnos.contestOutcome.winner, "attack");
  assert(card.flags.incarnos.contestRequest.outcomeProcessed);
});

test("GM-created tie rerolls use the contestant as author while keeping GM request authorization", async () => {
  const env = setup();
  game.user = env.gm;
  const card = await ChatMessage.create({
    flags: { incarnos: { contestRequest: {
      attackerUuid: env.attacker.uuid, defenderUuid: env.attacker.uuid,
      attackerName: env.attacker.name, defenderName: env.defender.name,
      requestAuthorId: env.gm.id, recipientUserId: env.attackUser.id,
      stat: "Strength", role: "attack", reroll: true, popup: true, status: "pending"
    } } }
  });
  game.user = env.attackUser;
  await rollDefenderContest(card);
  game.user = env.gm;
  await processContestResponse(env.created[1], env.attackUser.id);
  assert.equal(card.author, env.attackUser);
  assert.equal(card.flags.incarnos.contestRequest.requestAuthorId, env.gm.id);
  assert.equal(card.flags.incarnos.contestRequest.status, "complete");
});
