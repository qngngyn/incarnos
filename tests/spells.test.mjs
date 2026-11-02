import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeSpellAutomation, getHealthAfter, getParryModifier, getSpellAttackThreshold, getSpellAutomation, getSpellChatContent, getSpellDamage, getSpellSummary, getVariableCost,
  groupSpellsByElement, parseSpellAutomation, rollUnderSucceeds
} from "../module/helpers/spells.mjs";

const spell = (name, element) => ({ name, system: { element } });

test("spell summary joins the filled fields in reading order", () => {
  assert.equal(
    getSpellSummary({ cost: "2 Actions, 10 IP", range: "12m", target: "Single Enemy", check: " ", duration: "Instant" }),
    "2 Actions, 10 IP · 12m · Single Enemy · Instant"
  );
  assert.equal(getSpellSummary(), "");
});

test("placed rectangles read decimal commas or dots and describe both dimensions on the spell sheet", () => {
  for (const range of ["12m (3m x 1,5m)", "12 m (3 m x 1.5 m)", "12m (3m × 1.5m)"]) {
    const auto = parseSpellAutomation({ range, target: "Ground" });
    assert.deepEqual([auto.areaShape, auto.areaSize, auto.areaWidth, auto.areaOrigin], ["rect", 3, 1.5, "placed"]);
    assert.equal(describeSpellAutomation(auto), "Rectangle 3 m × 1.5 m (placed)");
  }
});

test("Immobilized uses an explicit count, then spell duration, otherwise stays indefinite; a target save negates it", () => {
  const condition = (effect, duration = "Instant", check = "Attack Dex") => parseSpellAutomation({ effect, duration, check }).conditions;
  const expected = (formula, timed, saveNegates = false) => [{ id: "immobilized", name: "Immobilized", formula, timed, saveNegates }];
  assert.deepEqual(condition("On hit: Immobilized 3", "2 turns"), expected("3", true));
  assert.deepEqual(condition("Target is Immobilized 1", "2 turns"), expected("1", true));
  assert.deepEqual(condition("On hit: Target is immobilized", "2 turns"), expected("2", true));
  assert.deepEqual(condition("On hit: Target is Immobilized"), expected(null, false));
  assert.deepEqual(condition("On hit: Target is immobilized", "Instant", "Attack Dex, Target Save Str+2"), expected(null, false, true));
  assert.deepEqual(condition("If the target is immobilized, deal damage", "2 turns"), []);
  assert.deepEqual(condition("Immobilized: You cannot use Movement actions.", "2 turns"), []);
  const ivy = parseSpellAutomation({ range: "12m (3m x 1,5m)", target: "Ground", check: "Attack Int / Cha", duration: "2 turns",
    effect: "On cast: Summons ivy vines from the ground that occupy the space they grow from\nOn hit: Target is immobilized (cannot use Movement actions). The target can use an action to break out." });
  assert.deepEqual(ivy.conditions, expected("2", true));
  assert.equal(ivy.attackStat, "intcha");
  assert.equal(ivy.areaShape, "rect");
});

test("spells group by element alphabetically with unassigned spells last", () => {
  const groups = groupSpellsByElement([spell("a", "Water"), spell("b", ""), spell("c", "Fire"), spell("d", "Water")]);
  assert.deepEqual(groups.map(g => [g.element, g.spells.map(s => s.name)]), [
    ["Fire", ["c"]], ["Water", ["a", "d"]], ["Other", ["b"]]
  ]);
});

test("chat content escapes effect text and keeps line breaks", () => {
  const html = getSpellChatContent({
    element: "Fire", category: "Attack", cost: "1 Action, 4 IP",
    effect: "On hit: <b>3d6</b>\nBurns", description: "<p>Flavour</p>"
  });
  assert.match(html, /Fire · Attack/);
  assert.match(html, /On hit: &lt;b&gt;3d6&lt;\/b&gt;<br>Burns/);
  assert.ok(html.endsWith("<p>Flavour</p>"));
});

test("automation reads attack, damage and a placed circle from the sheet text", () => {
  const auto = parseSpellAutomation({
    check: "Attack Int / Cha", target: "Ground Circle", range: "6m (1,5m radius)",
    effect: "On hit: Deals 6d6 + (lvl * 2) fire dmg\nIf the target burns: 1d6 fire dmg"
  });
  assert.equal(auto.attackStat, "intcha");
  assert.equal(auto.damage, "6d6 + (@lvl * 2)");
  assert.equal(auto.damageType, "fire");
  assert.deepEqual([auto.areaShape, auto.areaSize, auto.areaOrigin], ["circle", 1.5, "placed"]);
});

test("attack counts follow the attack stat and appear in the sheet's automation description", () => {
  for (const suffix of ["(3x)", "(3 x)", "3x"]) {
    const auto = parseSpellAutomation({ check: `Attack Int / Cha ${suffix}`, target: "Single Enemy",
      effect: "On cast:\nFor each successful attack, deal 3d4 + (lvl * 1) earth dmg" });
    assert.equal(auto.attackStat, "intcha");
    assert.equal(auto.attackCount, 3);
    assert.equal(auto.damage, "3d4 + (@lvl * 1)");
    assert.equal(auto.damageType, "earth");
    assert.match(describeSpellAutomation(auto), /Attack Int \/ Cha \(higher\) ×3 vs Parry/);
  }
  assert.equal(parseSpellAutomation({ check: "Attack Dex (4 x)" }).attackCount, 4);
  for (const check of ["Attack Int / Cha", "No Check (3x)", "Attack Int (0x)", "Attack Int, Target Save Con (3x)"]) {
    assert.equal(parseSpellAutomation({ check }).attackCount, 1, check);
  }
  assert.equal(parseSpellAutomation().attackCount, 1);
});

test("automation reads saves with modifiers and what a successful save does", () => {
  const none = parseSpellAutomation({ check: "Target Save Dex-2", target: "Ground Circle", effect: "Deals 3d6 + (lvl * 2) fire dmg (none when Save succeeded)" });
  assert.deepEqual([none.saveStat, none.saveModifier, none.saveEffect], ["dex", -2, "none"]);
  const half = parseSpellAutomation({ check: "Target Wil Save", target: "Single Target", effect: "Deal 2d6 fire dmg (half dmg when save succeeded)" });
  assert.deepEqual([half.saveStat, half.saveEffect], ["wis", "half"]);
  const rider = parseSpellAutomation({ check: "Attack Int / Cha, Target Save Con", target: "Single Enemy", effect: "On hit: 4d6 air dmg" });
  assert.deepEqual([rider.attackStat, rider.saveStat, rider.saveEffect], ["intcha", "con", ""]);
});

test("automation leaves self and ally spells without damage, reads heals and areas from the caster", () => {
  const rain = parseSpellAutomation({ check: "No Check", target: "Ground Circle", range: "12m radius from user", effect: "Heals 4d4 + (lvl * 2) hp" });
  assert.equal(rain.heal, "4d4 + (@lvl * 2)");
  assert.deepEqual([rain.areaShape, rain.areaSize, rain.areaOrigin], ["circle", 12, "self"]);
  const aura = parseSpellAutomation({ check: "No Check", target: "Self", effect: "Melee: Attacker takes 1d6 fire dmg\nDeals 1d6 fire dmg" });
  assert.equal(aura.damage, "");
  const line = parseSpellAutomation({ check: "Attack Int / Cha", target: "Line From User", range: "9m (4,5m width)", effect: "On hit: Deals 3d6 fire dmg" });
  assert.deepEqual([line.areaShape, line.areaSize, line.areaWidth, line.areaOrigin], ["line", 9, 4.5, "self"]);
  const tiered = parseSpellAutomation({ check: "Attack Str", target: "Single Enemy", effect: "If attack hits 0% - 50%: Deals 3d6 earth dmg" });
  assert.equal(tiered.damage, "");
  const momentum = parseSpellAutomation({ check: "Attack Str", target: "Single Target", effect: "On hit:\nDeal Momentum × d6 damage." });
  assert.deepEqual([momentum.attackStat, momentum.damage], ["str", ""]);
});

test("spell attacks use 10 − Parry as the modifier; nat 1 and nat 20 decide", () => {
  assert.equal(getSpellAttackThreshold(12, 10), 12);
  assert.equal(getSpellAttackThreshold(12, 15), 7);
  assert.equal(getSpellAttackThreshold(12, 5, -2), 15);
  assert.equal(rollUnderSucceeds(7, 7), true);
  assert.equal(rollUnderSucceeds(8, 7), false);
  assert.equal(rollUnderSucceeds(1, -3), true);
  assert.equal(rollUnderSucceeds(20, 25), false);
});

test("damage depends on hit and save, health stays within its limits", () => {
  assert.equal(getSpellDamage(17, { hit: false }), 0);
  assert.equal(getSpellDamage(17, { saved: true, saveEffect: "half" }), 8);
  assert.equal(getSpellDamage(17, { saved: true, saveEffect: "none" }), 0);
  assert.equal(getSpellDamage(17, { saved: true, saveEffect: "" }), 17);
  assert.equal(getHealthAfter({ value: 10, min: 0, max: 15 }, 12), 0);
  assert.equal(getHealthAfter({ value: 10, min: 0, max: 15 }, 12, "heal"), 15);
});

test("variable costs are detected so the caster can enter them", () => {
  assert.deepEqual(getVariableCost("2 Actions, 10 IP"), { actions: false, mp: false });
  assert.deepEqual(getVariableCost("X Actions, X * 8 IP"), { actions: true, mp: true });
  assert.deepEqual(getVariableCost("1 Action, 3 IP times 4d4"), { actions: false, mp: true });
  assert.deepEqual(getVariableCost("0 Action (once per turn), 6 IP"), { actions: false, mp: false });
});

test("Parry converts to the players' attack modifier as 10 − Parry", () => {
  assert.deepEqual([10, 11, 15, 9, 5].map(getParryModifier), [0, -1, -5, 1, 5]);
});

test("PvP halves spell damage after the save", () => {
  assert.equal(getSpellDamage(17, { pvp: true }), 8);
  assert.equal(getSpellDamage(17, { pvp: true, saved: true, saveEffect: "half" }), 4);
});

test("casts read automation live from the spell text; leftover stored fields are ignored", () => {
  const text = { check: "Attack Int / Cha", target: "Single Enemy", effect: "On hit: Deals 6d6 + (lvl * 2) fire dmg" };
  assert.equal(getSpellAutomation(text).attackStat, "intcha");
  assert.equal(getSpellAutomation({ ...text, damage: "8d6", attackStat: "" }).damage, "6d6 + (@lvl * 2)");
  assert.equal(describeSpellAutomation(getSpellAutomation(text)), "Attack Int / Cha (higher) vs Parry · Damage 6d6 + (@lvl * 2) fire");
});


test("fixed and variable IP costs behave like legacy MP/PP text at cast time", () => {
  for (const unit of ["IP", "MP", "PP", "ip", "mp", "pp"]) {
    for (const cost of ["12 " + unit, "2 Actions, 12 " + unit]) {
      assert.deepEqual(getVariableCost(cost), { actions: false, mp: false }, cost);
    }
    for (const cost of ["X * 8 " + unit, "3 " + unit + " times 4d4"]) {
      assert.deepEqual(getVariableCost(cost), { actions: false, mp: true }, cost);
      assert.deepEqual(getVariableCost("X Actions, " + cost), { actions: true, mp: true }, cost);
    }
  }
});

test("spell overviews and chat show legacy costs as IP without changing the stored text", () => {
  for (const unit of ["IP", "MP", "PP"]) {
    const system = { cost: "2 Actions, 12 " + unit, effect: "No effect" };
    assert.equal(getSpellSummary(system), "2 Actions, 12 IP");
    assert.match(getSpellChatContent(system), /2 Actions, 12 IP/);
    assert.equal(system.cost, "2 Actions, 12 " + unit);
  }
});
