import assert from "node:assert/strict";
import { test } from "node:test";
import { getContestDefender, requestDefenderContest, rollDefenderContest, processContestResponse, completeDefenderContest } from "../module/helpers/contest-requests.mjs";

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
            if (key.startsWith("flags.incarnos.contestRequest.")) this.flags.incarnos.contestRequest[key.split(".").pop()] = value;
            else this[key] = value;
          }
        },
        async delete() { this.deleted = true; messages.delete(this.id); }
      };
      created.push(message); messages.set(message.id, message);
      return message;
    }
  };
  globalThis.Roll = class {
    constructor(formula) { this.formula = formula; this.total = 7; this._evaluated = false; }
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
  assert(card.flavor.includes(" vs. Defender"));
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
  assert.match(card.flavor, /Attacker vs\. Defender/);
  assert.equal(card.rolls[0].formula, "d15");
  assert.match(card.content, /d15: 7/);
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
  env.defender.system.abilities.str.save = 20;
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
  assert.match(card.flavor, /Save: Dexterity Contest: 11/);
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
