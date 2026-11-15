import assert from "node:assert/strict";
import { test } from "node:test";
import { applyAttackConditions, conditionTokens, shadowcloneCheck, SHADOWCLONE_DIVERT } from "../module/helpers/conditions.mjs";
import { getSpellAutomation } from "../module/helpers/spells.mjs";
import { getActionState } from "../module/helpers/action-tracker.mjs";

/** An actor with status effects stored like Foundry's (statuscounter value in flags) and incarnos flags. */
function mockActor(statuses = []) {
  const flags = {};
  const actor = {
    type: "character", statuses: new Set(statuses), effects: [], flags: { incarnos: flags },
    system: { actionpoints: { value: 3, max: 3 } },
    getFlag: (scope, key) => flags[key], async setFlag(scope, key, value) { flags[key] = value; },
    async update(changes) { if ("system.actionpoints.value" in changes) this.system.actionpoints.value = changes["system.actionpoints.value"]; },
    async toggleStatusEffect(id) {
      const data = {};
      const effect = { statuses: new Set([id]), getFlag: (scope, key) => data[`${scope}.${key}`],
        async setFlag(scope, key, value) { data[`${scope}.${key}`] = value; },
        async update(changes) { for (const [path, value] of Object.entries(changes)) data[path.replace(/^flags\./, "")] = value; },
        async delete() { actor.effects.splice(actor.effects.indexOf(effect), 1); actor.statuses.delete(id); } };
      actor.effects.push(effect);
      actor.statuses.add(id);
      return true;
    }
  };
  return actor;
}

test("Shadowclones gives every ally a Shadowclone for its 1 turn", () => {
  const auto = getSpellAutomation({ target: "Allies", range: "Sight around user", check: "No Check", duration: "1 turn",
    effect: "On cast: \nAll allies in sight receive a shadow clone:\nShadowclones grant 2 bonuses:\n1. The ally gains an extra action\n2. On enemy attack against the ally:\nRoll a d20 to determine whether the enemy attacks the shadowclone instead.\nOn a 9 or lower, the shadow gets attacked instead." });
  assert.deepEqual(auto.conditions.map(({ id, formula }) => [id, formula]), [["shadowclone", "1"]]);
});

test("an attack against a cloned creature rolls a d20: 9 or lower hits the clone", async () => {
  const roller = total => async formula => { assert.equal(formula, "1d20"); return { total }; };
  assert.equal(await shadowcloneCheck(mockActor(), roller(1)), null, "no clone, no roll");
  assert.equal(SHADOWCLONE_DIVERT, 9);
  assert.deepEqual(await shadowcloneCheck(mockActor(["shadowclone"]), roller(9)).then(({ d20, diverted }) => ({ d20, diverted })), { d20: 9, diverted: true });
  assert.deepEqual(await shadowcloneCheck(mockActor(["shadowclone"]), roller(10)).then(({ d20, diverted }) => ({ d20, diverted })), { d20: 10, diverted: false });
});

test("receiving a clone gives 1 extra action this turn; refreshing it doesn't give another", async () => {
  const actor = mockActor();
  await applyAttackConditions(actor, [{ id: "shadowclone", tokens: 1 }]);
  assert.equal(conditionTokens(actor, "shadowclone"), 1);
  assert.deepEqual(getActionState(actor), { max: 4, value: 4 });
  await applyAttackConditions(actor, [{ id: "shadowclone", tokens: 1 }]);
  assert.deepEqual(getActionState(actor), { max: 4, value: 4 });
});

test("You're a fucking Nightmare makes its target Frenzied", () => {
  const auto = getSpellAutomation({ target: "Asleep Single Target", range: "9m", check: "No Check",
    effect: "On cast:\nForces your target to spend his next actions randomly attacking targets around him." });
  assert.deepEqual(auto.conditions.map(condition => condition.id), ["frenzied"]);
});

test("Frenzied plan: one random creature in reach per action, or the nearest to move to", async () => {
  const { frenziedPlan } = await import("../module/helpers/conditions.mjs");
  const picks = [0, 0.6, 0.99];
  assert.deepEqual(frenziedPlan([{ name: "Drea" }, { name: "Goblin" }], 3, null, () => picks.shift()), { attacks: ["Drea", "Goblin", "Goblin"], moveTo: null });
  assert.deepEqual(frenziedPlan([], 3, { name: "Piet" }), { attacks: [], moveTo: "Piet" });
  assert.deepEqual(frenziedPlan([], 3, null), { attacks: [], moveTo: null });
});
