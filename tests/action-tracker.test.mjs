import assert from "node:assert/strict";
import { test } from "node:test";
import { getActionState, positionActionHUD, tokenParticipatesInCombat, actorParticipatesInCombat, migrateDefaultActions, actionTrackerVisible, changeActions, drawActionTracker, replenishCombatTurn, replenishEndedTurn, registerActionTrackerHooks } from "../module/helpers/action-tracker.mjs";

function setup(value = 3, max = 3) {
  const owner = { id: "owner", active: true };
  const other = { id: "other", active: true };
  const gm = { id: "gm", active: true, isGM: true };
  globalThis.game = { user: owner, users: [owner, other, gm], combat: { started: true, combatants: [{ tokenId: "token", sceneId: "scene" }] } };
  const updates = [];
  const actor = { type: "character", system: { actionpoints: { value, max } },
    testUserPermission: user => user.id === owner.id,
    async update(data) { await Promise.resolve(); updates.push(data); this.system.actionpoints.value = data["system.actionpoints.value"]; }
  };
  return { actor, owner, other, gm, updates };
}

test("actions default to 3 and accept 6 or 9 with bounded remaining values", () => {
  assert.deepEqual(getActionState({}), { value: 3, max: 3 });
  for (const max of [3, 6, 9]) assert.deepEqual(getActionState({ system: { actionpoints: { value: max + 1, max } } }), { value: max, max });
  assert.equal(getActionState({ system: { actionpoints: { value: -2, max: 3 } } }).value, 0);
});

test("owned tokens always show actions; others require hover and cannot expose unseen tokens", () => {
  const { actor, owner, other, gm } = setup();
  const token = { document: { id: "token", parent: { id: "scene" } }, actor, isVisible: true, hover: false };
  assert(actionTrackerVisible(token, owner));
  assert(!actionTrackerVisible(token, other));
  token.hover = true;
  assert(actionTrackerVisible(token, other));
  token.isVisible = false;
  assert(!actionTrackerVisible(token, owner));
  token.isVisible = true; token.hover = false;
  assert(actionTrackerVisible(token, gm));
});

test("rapid spends are serialized, stop at zero and only owners or GMs can edit", async () => {
  const env = setup();
  await Promise.all([changeActions(env.actor, "spend"), changeActions(env.actor, "spend"), changeActions(env.actor, "spend"), changeActions(env.actor, "spend")]);
  assert.equal(env.actor.system.actionpoints.value, 0);
  assert.deepEqual(env.updates.map(data => data["system.actionpoints.value"]), [2, 1, 0]);
  game.user = env.other;
  assert.equal(await changeActions(env.actor, "restore"), false);
  assert.equal(env.actor.system.actionpoints.value, 0);
  game.user = env.owner;
  await changeActions(env.actor, "restore");
  assert.equal(env.actor.system.actionpoints.value, 1);
  await changeActions(env.actor, "reset");
  assert.equal(env.actor.system.actionpoints.value, 3);
  await changeActions(env.actor, "restore");
  assert.equal(env.actor.system.actionpoints.value, 3);
});

test("ending a forward turn refills only the outgoing actor, once on the elected GM", async () => {
  const env = setup(0, 9);
  const next = setup(1, 6).actor;
  game.user = env.owner;
  game.users = [env.owner, env.gm];
  const combat = { combatants: new Map([["outgoing", { actor: env.actor }], ["next", { actor: next }]]) };
  const options = { incarnosEndedCombatantId: "outgoing" };
  await replenishEndedTurn(combat, { turn: 1 }, options, env.owner.id);
  assert.equal(env.actor.system.actionpoints.value, 0);
  game.user = env.gm;
  await replenishEndedTurn(combat, { turn: 1 }, options, env.owner.id);
  assert.equal(env.actor.system.actionpoints.value, 9);
  assert.equal(next.system.actionpoints.value, 1);
  assert.equal(env.updates.length, 1);
});

test("confirmed combat transitions ignore starts, rewinds and initiative reordering", async () => {
  const env = setup(0, 3); game.user = env.gm;
  const combat = { combatants: new Map([["outgoing", { actor: env.actor }]]) };
  for (const [prior, current] of [
    [{ round: 0, turn: 0, combatantId: "outgoing" }, { round: 1, turn: 0 }],
    [{ round: 2, turn: 1, combatantId: "outgoing" }, { round: 2, turn: 0 }],
    [{ round: 2, turn: 0, combatantId: "outgoing" }, { round: 1, turn: 2 }],
    [{ round: 1, turn: 0, combatantId: "outgoing" }, { round: 1, turn: 0, combatantId: "another" }]
  ]) await replenishCombatTurn(combat, prior, current);
  assert.equal(env.actor.system.actionpoints.value, 0);
});

test("an owner can refill at end of turn when no GM is online", async () => {
  const env = setup(0, 6);
  env.gm.active = false;
  await replenishEndedTurn({ combatants: new Map([["outgoing", { actor: env.actor }]]) }, { round: 2, turn: 0 }, { incarnosEndedCombatantId: "outgoing" }, env.owner.id);
  assert.equal(env.actor.system.actionpoints.value, 6);
});

test("token segments scale to 3/6/9 and redraw removes the previous display", () => {
  class Container {
    constructor() { this.children = []; this.position = { set: (x, y) => { this.x = x; this.y = y; } }; }
    addChild(child) { this.children.push(child); }
    destroy() { this.destroyed = true; }
  }
  class Graphics {
    lineStyle() { return this; }
    beginFill(color) { this.color = color; return this; }
    drawRoundedRect(x, y, width, height) { Object.assign(this, { x, y, width, height }); return this; }
    endFill() { return this; }
  }
  globalThis.PIXI = { Container, Graphics };
  const env = setup();
  const token = { document: { id: "token", parent: { id: "scene" } }, actor: env.actor, w: 100, isVisible: true, hover: false, children: [], addChild(child) { this.children.push(child); } };
  let previous;
  for (const max of [3, 6, 9]) {
    env.actor.system.actionpoints = { value: 2, max };
    drawActionTracker(token);
    const display = token.children.at(-1);
    assert.equal(display.children.length, max);
    assert.equal(display.children.filter(segment => segment.color === 0x39d353).length, 2);
    assert(display.y < 0);
    assert(display.visible);
    assert.equal(new Set(display.children.map(segment => segment.y)).size, max / 3);
    if (previous) assert(previous.destroyed);
    previous = display;
  }
});


test("action UI requires a started combat and the exact participating token", () => {
  const env = setup();
  const token = { document: { id: "token", parent: { id: "scene" } }, actor: env.actor, isVisible: true, hover: true };
  assert(actionTrackerVisible(token));
  game.combat.started = false;
  assert(!actionTrackerVisible(token));
  game.combat.started = true;
  token.document.id = "another-token";
  assert(!tokenParticipatesInCombat(token));
  assert(!actionTrackerVisible(token));
  token.document.id = "token"; token.document.parent.id = "another-scene";
  assert(!actionTrackerVisible(token));
  env.actor.uuid = "Actor.hero";
  game.combat.combatants[0].actor = env.actor;
  assert(actorParticipatesInCombat(env.actor));
  assert(!actorParticipatesInCombat({ uuid: "Actor.bystander" }));
  game.combat = null;
  assert(!actionTrackerVisible(token));
  assert(!actorParticipatesInCombat(env.actor));
});

test("legacy defaults become 3 while custom action pools and spent values survive", async () => {
  const env = setup(4, 4);
  const spent = setup(1, 4).actor;
  const custom = setup(5, 6).actor;
  const synthetic = setup(4, 4).actor;
  for (const actor of [env.actor, spent, custom, synthetic]) {
    actor.toObject = () => ({ system: structuredClone(actor.system) });
    actor.update = async data => {
      actor.system.actionpoints.max = data["system.actionpoints.max"];
      actor.system.actionpoints.value = data["system.actionpoints.value"];
    };
  }
  game.user = env.gm; game.users = [env.gm];
  game.actors = [env.actor, spent, custom];
  game.scenes = [{ tokens: [{ actorLink: false, actor: synthetic }] }];
  await migrateDefaultActions();
  assert.deepEqual(env.actor.system.actionpoints, { value: 3, max: 3 });
  assert.deepEqual(spent.system.actionpoints, { value: 1, max: 3 });
  assert.deepEqual(custom.system.actionpoints, { value: 5, max: 6 });
  assert.deepEqual(synthetic.system.actionpoints, { value: 3, max: 3 });
});


test("action HUD sits below overflowing native buttons at different canvas scales", () => {
  for (const scale of [0.5, 1, 2]) {
    const child = {};
    const controls = { isConnected: true, style: {}, contains: element => element === child };
    const root = { isConnected: true, offsetHeight: 100,
      getBoundingClientRect: () => ({ top: 20, bottom: 20 + 100 * scale, height: 100 * scale }),
      querySelectorAll: () => [
        { getBoundingClientRect: () => ({ width: 40, height: 40, bottom: 20 + 160 * scale }) },
        { getBoundingClientRect: () => ({ width: 0, height: 0, bottom: 999 }) }, controls, child
      ]
    };
    positionActionHUD(root, controls);
    assert.equal(controls.style.top, "172px");
  }
});


test("round transitions refill the last combatant and single-combatant encounters", async () => {
  for (const max of [3, 6, 9]) for (const solo of [false, true]) {
    const env = setup(0, max);
    game.user = env.gm;
    const hooks = {};
    globalThis.Hooks = { on: (name, callback) => { hooks[name] = callback; }, once: () => {} };
    registerActionTrackerHooks();
    const linked = setup(1, 3).actor;
    game.user = env.gm; game.users = [env.gm, env.owner];
    const combat = { started: true, combatant: { id: "last" },
      combatants: new Map(solo ? [["last", { actor: env.actor }]] : [["last", { actor: env.actor }], ["next", { actor: linked }]]) };
    // Unlinked token actors are used directly, leaving their world actor alone.
    env.actor.isToken = true;
    const changed = { round: 2, turn: 0 };
    const prior = { round: 1, turn: solo ? 0 : 1, combatantId: "last" };
    const current = { round: 2, turn: 0, combatantId: solo ? "last" : "next" };
    await replenishCombatTurn(combat, prior, current);
    assert.equal(env.actor.system.actionpoints.value, max);
    assert.equal(linked.system.actionpoints.value, 1);
    assert.equal(env.updates.length, 1);

  }
});

test("without a GM, the outgoing owner resets even if another player advances combat", async () => {
  const env = setup(0, 6);
  env.gm.active = false;
  const combat = { combatants: new Map([["outgoing", { actor: env.actor }]]) };
  const options = { incarnosEndedCombatantId: "outgoing" };
  game.user = env.other;
  await replenishEndedTurn(combat, { turn: 1 }, options, env.other.id);
  assert.equal(env.actor.system.actionpoints.value, 0);
  game.user = env.owner;
  await replenishEndedTurn(combat, { turn: 1 }, options, env.other.id);
  assert.equal(env.actor.system.actionpoints.value, 6);
  assert.equal(env.updates.length, 1);
});

test("direct confirmed transitions reset once without preliminary update metadata", async () => {
  const env = setup(0, 3); game.user = env.gm;
  const hooks = {};
  globalThis.Hooks = { on: (name, callback) => { hooks[name] = callback; }, once: () => {} };
  registerActionTrackerHooks();
  assert.equal(hooks.combatTurn, undefined);
  assert.equal(hooks.combatRound, undefined);
  const combat = { combatants: new Map([["outgoing", { actor: env.actor }]]) };
  const prior = { round: 1, turn: 0, combatantId: "outgoing" };
  const current = { round: 1, turn: 1, combatantId: "next" };
  hooks.combatTurnChange(combat, prior, current);
  await changeActions(env.actor, "spend");
  assert.equal(env.actor.system.actionpoints.value, 2);
  // A repeated notification must not refill actions spent after the reset.
  await replenishCombatTurn(combat, prior, current);
  assert.equal(env.actor.system.actionpoints.value, 2);
  assert.deepEqual(env.updates.map(data => data["system.actionpoints.value"]), [3, 2]);
});


test("a failed automatic reset can be retried on the same confirmed transition", async () => {
  const env = setup(0, 9); game.user = env.gm;
  const update = env.actor.update;
  env.actor.update = async () => { throw new Error("write failed"); };
  const combat = { combatants: new Map([["outgoing", { actor: env.actor }]]) };
  const prior = { round: 1, turn: 0, combatantId: "outgoing" };
  const current = { round: 1, turn: 1, combatantId: "next" };
  await assert.rejects(replenishCombatTurn(combat, prior, current), /write failed/);
  env.actor.update = update;
  await replenishCombatTurn(combat, prior, current);
  assert.equal(env.actor.system.actionpoints.value, 9);
});
