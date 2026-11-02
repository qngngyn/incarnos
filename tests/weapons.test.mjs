import assert from "node:assert/strict";
import { test } from "node:test";
import { getTraitDamageFormula, getTraitHit, getWeaponRules, parseWeaponTraits, withDieSize } from "../module/helpers/weapons.mjs";

const katana = { traits: "Finesse: You can use your Dexterity…\nTwo-Hand D10: … -2 hitrate …\nDeadly D8: When you crit, add the named dice…" };

test("trait lines split into name, value and description", () => {
  assert.deepEqual(parseWeaponTraits("Throwable 4,5m: You can throw it.\n(Once per Turn) Shield Bash: Bash.\nCritical Strike 1-3: Crits.").map(({ name, value, text }) => [name, value, text]), [
    ["Throwable", "4,5m", "You can throw it."],
    ["(Once per Turn) Shield Bash", "", "Bash."],
    ["Critical Strike", "1-3", "Crits."]
  ]);
  assert.deepEqual(parseWeaponTraits(""), []);
});

test("automated traits become attack rules", () => {
  const rules = getWeaponRules(katana);
  assert.deepEqual([rules.finesse, rules.twoHand, rules.deadly, rules.fatal, rules.critRange], [true, 10, 8, null, 1]);
  const pistol = getWeaponRules({ traits: "Critical Strike 1-3: …\nFatal D10: …\nConsuming: …" });
  assert.deepEqual([pistol.critRange, pistol.fatal, pistol.finesse], [3, 10, false]);
  assert.equal(getWeaponRules({ traits: "Throwable 9m: …" }).throwable, "9m");
  assert.equal(getWeaponRules({ traits: "Sweep: …" }).sweep, true);
  assert.equal(getWeaponRules({}).critRange, 1);
});

test("damage formulas follow Two-Hand, Fatal and Deadly", () => {
  const rules = getWeaponRules(katana);
  assert.equal(withDieSize("1d6 + 2", 10), "1d10 + 2");
  assert.equal(getTraitDamageFormula("1d6", rules), "1d6");
  assert.equal(getTraitDamageFormula("1d6", rules, { twoHanded: true }), "1d10");
  assert.equal(getTraitDamageFormula("1d6", rules, { crit: true }), "1d6 + 1d8");
  assert.equal(getTraitDamageFormula("1d4", getWeaponRules({ traits: "Fatal D10: …" }), { crit: true }), "1d10");
});

test("hits follow Critical Strike ranges and Poor Precision", () => {
  assert.deepEqual(getTraitHit(3, 2, { critRange: 3 }), { success: true, crit: true, fumble: false });
  assert.deepEqual(getTraitHit(3, 2, {}), { success: false, crit: false, fumble: false });
  assert.deepEqual(getTraitHit(20, 25, {}), { success: false, crit: false, fumble: true });
  assert.equal(getTraitHit(5, 10, { poorPrecision: true }).success, false, "a successful roll misses");
  assert.equal(getTraitHit(15, 10, { poorPrecision: true }).success, true, "a failed roll hits");
});
