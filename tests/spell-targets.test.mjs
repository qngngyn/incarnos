import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSpellTargets, describeSpellTargets, filterBySide, parseSpellTargets, relationTo, sideDisposition } from "../module/helpers/spell-targets.mjs";

const pick = (target, ...entries) => checkSpellTargets(parseSpellTargets(target), entries.map(relation => (typeof relation === "string" ? { relation } : relation)));

test("Target lines from the vault become side, count and self rules", () => {
  const rule = target => { const { kind, side, min, max, self, requires } = parseSpellTargets(target); return [kind, side, min, max, self, requires]; };
  assert.deepEqual(rule("Self"), ["self", "any", 0, 0, true, null]);
  assert.deepEqual(rule("Single Enemy"), ["pick", "enemy", 1, 1, false, null]);
  assert.deepEqual(rule("Single Ally"), ["pick", "ally", 1, 1, false, null]);
  assert.deepEqual(rule("Single Target"), ["pick", "any", 1, 1, true, null]);
  assert.deepEqual(rule("2 Single Enemies"), ["pick", "enemy", 1, 2, false, null]);
  assert.deepEqual(rule("One/Two Enemies"), ["pick", "enemy", 1, 2, false, null]);
  assert.deepEqual(rule("Up to 5 Enemies"), ["pick", "enemy", 1, 5, false, null]);
  assert.deepEqual(rule("Enemies"), ["all", "enemy", 1, Infinity, false, null]);
  assert.deepEqual(rule("Shadowmarked Enemies"), ["all", "enemy", 1, Infinity, false, "shadowmarked"]);
  assert.deepEqual(rule("Allies"), ["all", "ally", 1, Infinity, false, null]);
  assert.deepEqual(rule("Friendlies"), ["all", "friendly", 1, Infinity, true, null]);
  assert.deepEqual(rule("Asleep Single Target"), ["pick", "any", 1, 1, true, "asleep"]);
  assert.deepEqual(rule("Single downed Target"), ["pick", "any", 1, 1, true, "downed"]);
  assert.deepEqual(rule("Self + Single Target"), ["pick", "any", 1, 1, false, null]);
  for (const free of ["Ground Circle", "Line From User", "Orthogonal Line", "Single Weapon", "Oils", "Varied", "Variable", "After save", "Projectiles"]) {
    assert.equal(parseSpellTargets(free).kind, "free", free);
  }
});

test("allies never include the caster; targets and friendlies do; enemies never", () => {
  assert.equal(pick("Single Ally", "self"), "side");
  assert.equal(pick("Single Ally", "ally"), null);
  assert.equal(pick("Single Ally", "enemy"), "side");
  assert.equal(pick("Single Target", "self"), null);
  assert.equal(pick("Single Target", "enemy"), null);
  assert.equal(pick("Single Enemy", "self"), "side");
  assert.equal(pick("Single Enemy", "ally"), "side");
  assert.equal(pick("Self + Single Target", "self"), "side");
  assert.equal(filterBySide(parseSpellTargets("Friendlies"), ["me", "friend", "foe"].map(id => ({ id, document: { disposition: id === "foe" ? -1 : 1 } })),
    { token: { id: "me", document: { disposition: 1 } } }).map(token => token.id).join(), "me,friend");
  assert.equal(filterBySide(parseSpellTargets("Enemies"), ["me", "friend", "foe"].map(id => ({ id, document: { disposition: id === "foe" ? -1 : 1 } })),
    { token: { id: "me", document: { disposition: 1 } } }).map(token => token.id).join(), "foe");
});

test("counts, conditions and range", () => {
  assert.equal(pick("Single Enemy", "enemy", "enemy"), "count");
  assert.equal(pick("Up to 5 Enemies", ...Array(5).fill("enemy")), null);
  assert.equal(pick("Up to 5 Enemies", ...Array(6).fill("enemy")), "count");
  assert.equal(pick("Up to 5 Enemies", { relation: "enemy", inRange: false }), "range");
  assert.equal(pick("Asleep Single Target", { relation: "enemy", asleep: false }), "asleep");
  assert.equal(pick("Asleep Single Target", { relation: "enemy", asleep: true }), null);
  assert.equal(pick("Single downed Target", { relation: "ally", downed: false }), "downed");
  assert.equal(pick("Ground Circle", "self", "ally", "enemy"), null, "areas without a side are not checked here");
});

test("relation comes from token disposition; unknown dispositions never block", () => {
  const caster = { token: { id: "c", document: { disposition: 1 } } };
  assert.equal(relationTo(caster, caster.token), "self");
  assert.equal(relationTo(caster, { id: "a", document: { disposition: 1 } }), "ally");
  assert.equal(relationTo(caster, { id: "n", document: { disposition: 0 } }), "enemy");
  assert.equal(relationTo(caster, { id: "x", document: {} }), "unknown");
  assert.equal(pick("Single Ally", "unknown"), null);
});

test("player-owned characters are friendly even when their token is set to Hostile", () => {
  const silver = { hasPlayerOwner: true };
  const caster = { actor: silver, token: { id: "c", actor: silver, document: { disposition: -1 } } };
  const monster = { id: "m", actor: { hasPlayerOwner: false }, document: { disposition: -1 } };
  const friend = { id: "f", actor: { hasPlayerOwner: true }, document: { disposition: -1 } };
  assert.equal(relationTo(caster, monster), "enemy");
  assert.equal(relationTo(caster, friend), "ally");
  assert.equal(checkSpellTargets(parseSpellTargets("Single Enemy"), [{ relation: relationTo(caster, monster) }]), null);
  // A monster casting sees the hostile-set player token as an enemy too.
  assert.equal(relationTo({ actor: monster.actor, token: monster }, caster.token), "enemy");
  assert.equal(sideDisposition(friend), 1);
  // PvP: two player characters compare their own token dispositions.
  const rival = { id: "r", actor: { hasPlayerOwner: true }, document: { disposition: 1 } };
  assert.equal(relationTo(caster, rival), "enemy");
});

test("warnings name the rule in plain words", () => {
  assert.equal(describeSpellTargets(parseSpellTargets("Single Enemy")), "1 enemy");
  assert.equal(describeSpellTargets(parseSpellTargets("Up to 5 Enemies")), "1–5 enemies");
  assert.equal(describeSpellTargets(parseSpellTargets("Single Ally")), "1 ally (not yourself)");
  assert.equal(describeSpellTargets(parseSpellTargets("Single downed Target")), "1 target who is downed (0 HP)");
  assert.equal(describeSpellTargets(parseSpellTargets("Self + Single Target")), "1 target other than yourself");
});

test("Shadowbomb only hits shadowmarked enemies", () => {
  assert.equal(pick("Shadowmarked Enemies", { relation: "enemy", shadowmarked: true }), null);
  assert.equal(pick("Shadowmarked Enemies", { relation: "enemy", shadowmarked: false }), "shadowmarked");
});
