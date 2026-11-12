import assert from "node:assert/strict";
import { test } from "node:test";
import { afterpartyFormula, atBar, finaleFormula, isStageCurse, stageHasCombat } from "../module/helpers/entertainer.mjs";
import { applyAttackConditions, statusEffect } from "../module/helpers/conditions.mjs";

const EFFECT = "On cast:\nA shadow stage (6m radius) rises around you. You stand on a raised stage in its centre, ringed by a bar (1.5m radius).\n"
  + "Every enemy on the stage is cursed until the finale.\n\nWhile the spell lasts:\nEach time a cursed enemy takes damage, the crowd cheers: you gain +1 Applause (no maximum).\n\n"
  + "At the start of your next turn:\nFinale: Attack every cursed enemy.\nOn hit: Deals 1d4 per Applause + (lvl * 4) fire dmg.";

test("Entertainer's Curse is recognised by its text", () => {
  assert.equal(isStageCurse({ effect: EFFECT }), true);
  assert.equal(isStageCurse({ effect: "On hit: Deals 2d6 fire dmg" }), false);
});

test("finale: 1d4 per Applause + lvl × 4; afterparty: 1d4 per Applause", () => {
  assert.equal(finaleFormula(5, 3), "5d4 + 12");
  assert.equal(finaleFormula(0, 3), "12");
  assert.equal(afterpartyFormula(4), "4d4");
  assert.equal(afterpartyFormula(0), null);
});

test("the bar: within 1.5m of the stage centre, with half a square of leeway", () => {
  const stage = { x: 0, y: 0 };
  const ppm = 100 / 1.5;
  assert.equal(atBar(stage, { x: 0, y: 0 }, ppm), true, "the caster on the stage");
  assert.equal(atBar(stage, { x: 100, y: 100 }, ppm), true, "diagonally next to the stage");
  assert.equal(atBar(stage, { x: 200, y: 0 }, ppm), false, "two squares away");
});

test("a stage only counts as running while its combat runs", () => {
  const drea = { id: "drea" };
  const stage = { sceneId: "city" };
  const combat = (scene, actor, started = true) => ({ started, scene: { id: scene }, combatants: [{ actor, actorId: actor.id }] });
  assert.equal(stageHasCombat(stage, drea, [combat("city", drea)]), true);
  assert.equal(stageHasCombat(stage, drea, []), false, "the combat was ended: the old stage is stale");
  assert.equal(stageHasCombat(stage, drea, [combat("forest", drea)]), false, "a combat on another scene");
  assert.equal(stageHasCombat(stage, drea, [combat("city", { id: "other" })]), false, "Drea is not in it");
  assert.equal(stageHasCombat(stage, drea, [combat("city", drea, false)]), false, "not started yet");
});

test("the curse remembers its caster", async () => {
  const effects = [];
  const actor = { effects, statuses: new Set(),
    async toggleStatusEffect(id) {
      const flags = {};
      effects.push({ statuses: new Set([id]), getFlag: (scope, key) => flags[key], async setFlag(scope, key, value) { flags[key] = value; } });
      this.statuses.add(id);
    } };
  await applyAttackConditions(actor, [{ id: "entertainer-s-cursed", by: "Actor.drea" }]);
  assert.equal(statusEffect(actor, "entertainer-s-cursed").getFlag("incarnos", "curseBy"), "Actor.drea");
});

test("an Invulnerable gained during the holder's own turn skips that turn's end", async () => {
  const { endOfTurn, conditionTokens } = await import("../module/helpers/conditions.mjs");
  const flags = { incarnos: { skipTick: true }, statuscounter: { value: 3 } };
  const effect = { statuses: new Set(["invulnerable"]),
    getFlag: (scope, key) => flags[scope]?.[key],
    async unsetFlag(scope, key) { delete flags[scope][key]; },
    async update(changes) { flags.statuscounter.value = changes["flags.statuscounter.value"]; },
    async delete() { actor.effects.length = 0; } };
  const actor = { effects: [effect], getFlag: () => undefined };
  await endOfTurn(actor);
  assert.equal(conditionTokens(actor, "invulnerable"), 3, "the turn it started in doesn't count");
  for (const left of [2, 1]) { await endOfTurn(actor); assert.equal(conditionTokens(actor, "invulnerable"), left); }
  await endOfTurn(actor);
  assert.equal(actor.effects.length, 0, "gone after 3 full turns");
});
