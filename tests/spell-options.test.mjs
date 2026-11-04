import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseSpellNote } from "../tools/spell-notes.mjs";
import { describeSpellAutomation, getSpellAutomation, getSpellOptions, getSpellOptionSystem } from "../module/helpers/spells.mjs";
import { renderSpellCard } from "../module/helpers/spell-card.mjs";

const note = name => parseSpellNote(readFileSync(new URL(`fixtures/${name}.md`, import.meta.url), "utf8"), name).spell;
const crystal = note("crystal-shower");
const darkness = note("darkness-manifestation");
const shadow = note("shadow-play");
const strike = note("transmuting-strike");
const meat = note("meat-augmentation");

test("Crystal Shower reads independent card blocks and inherits the shared check and duration", () => {
  const snapshot = structuredClone(crystal);
  assert.deepEqual(getSpellOptions(crystal), [
    { name: "Spear", range: "9m", target: "Single Target", check: "Attack Int / Cha", duration: "Instant",
      effect: "Deals 4d6 + (lvl * 2) water dmg" },
    { name: "Needles", range: "9m (4,5m x 4,5m)", target: "Square Ground", check: "Attack Int / Cha", duration: "Instant",
      effect: "Deals 2d4 + 1 + (lvl * 2) water dmg\nLeaves difficult terrain" }
  ]);
  assert.deepEqual(crystal, snapshot);
  assert.deepEqual(getSpellOptions({ ...crystal, effect: crystal.effect.replaceAll("\n", "\r\n") }), getSpellOptions(crystal));
  const auto = getSpellAutomation(crystal);
  assert.equal(auto.damage, "", "an unchosen spell must not use the first option's damage");
  assert.equal(describeSpellAutomation(auto), "2 options: Spear, Needles");
});

test("Darkness Manifestation has three names from their headings, including the corrected Crescent spelling", () => {
  const options = getSpellOptions(darkness);
  assert.deepEqual(options.map(({ name, range, target }) => [name, range, target]), [
    ["Spear", "12m", "Line from User"], ["Crescent", "9m (12m width)", "Orthogonal Line"], ["Spiked Ball", "12m", "Single Target"]
  ]);
  for (const option of options) {
    assert.equal(option.check, darkness.check);
    assert.equal(option.duration, darkness.duration);
    assert.equal(option.effect.split("\n").length, 1);
  }
});

test("Shadow Play reads inline Name: effect choices without the pick-a-card intro", () => {
  const options = getSpellOptions(shadow);
  assert.deepEqual(options.map(option => option.name), ["Taunt", "Knife Throw", "Flower Bouquet"]);
  assert.deepEqual(options.map(option => option.effect), [
    "Target is taunted, you gain +2 Parry for the next attack against this target",
    "Target is restricted and fears you", "Deal 4d4 fire dmg"
  ]);
  for (const option of options) assert.deepEqual([option.range, option.target, option.check, option.duration], ["12m", "Single Target", "Prc Save", "1 turn"]);
});

test("Transmuting Strike names unnamed area/save blocks by their effect and keeps the delayed rules", () => {
  const options = getSpellOptions(strike);
  assert.deepEqual(options.map(option => option.name), ["Paralyze", "Confuse", "Prone"]);
  assert.deepEqual(options.map(option => option.check), ["Target Save Con", "Target Save Wil", "Target Save Con"]);
  for (const option of options) {
    assert.deepEqual([option.range, option.target, option.duration], ["3m radius", "Ground Circle", "Instant"]);
    assert.match(option.effect, /^Up to 3 projectiles gain one of the effects of your choice:/);
    assert.match(option.effect, /On beginning of targets turn:/);
    for (const other of options.filter(other => other !== option)) assert.ok(!option.effect.includes(`${other.name} targets`));
  }
});

test("Meat Augmentation keeps shared upkeep, inner OR and the entire Fleshball follow-up in the right option", () => {
  const options = getSpellOptions(meat);
  assert.deepEqual(options.map(option => option.name), ["Extra arms", "Extra eye", "Puss bubble", "Pulsating ulcer"]);
  assert.deepEqual(options.map(option => option.duration), ["3 turns", "3 turns", "2 turns", "2 turns"]);
  assert.deepEqual(options.map(option => option.check), [meat.check, meat.check, "Caster Save Wil+2", meat.check]);
  for (const option of options) {
    assert.equal(option.range, "6m");
    assert.equal(option.target, "Single Ally");
    assert.match(option.effect, /^End of affected ally turn: The part rots away/);
  }
  assert.match(options[0].effect, /Parry \+2\nOR\nGives advantage/);
  assert.match(options[2].effect, /Caster Save Wil\+2:\nOn Success: Puss bubble restores\./);
  assert.match(options[3].effect, /3m \(1,5m radius\) · Ground Circle\n- · 1 turn\nChaotic Fleshball \(only from Pulsating ulcer\):/);
  assert.match(options[3].effect, /Be consumed by the caster to heal 2d6/);
  assert.doesNotMatch(options.slice(0, 3).map(option => option.effect).join("\n"), /Chaotic Fleshball/);
});

test("normal spells, per-attack shapes, hit tiers, rule headers and bullet lists are not choices", () => {
  for (const system of [undefined, {}, note("greatsword-of-death"), note("discharge"), note("death-fire-elemental"),
    { effect: "On hit: Deals 3d6 fire dmg\nOn cast: Burn D4\nEffect: Target falls prone" },
    { effect: "On cast: Choose a target\nOn hit: Deals 3d6 fire dmg\nEffect: Burn D4\n- Strong: more\n- Weak: less" },
    { effect: "Fire: Deals 1d6 fire dmg\nIce: Deals 1d6 water dmg" }
  ]) assert.deepEqual(getSpellOptions(system), []);
});

test("Crystal and Darkness options automate only their own damage and area", () => {
  const expected = [
    [crystal, [["4d6 + (@lvl * 2)", "", 0, 0, "placed"], ["2d4 + 1 + (@lvl * 2)", "rect", 4.5, 4.5, "placed"]]],
    [darkness, [["2d6 + (@lvl *1)", "line", 12, 1.5, "self"], ["2d6 + (@lvl *1)", "line", 12, 1.5, "placed"], ["4d6 + (@lvl * 2)", "", 0, 0, "placed"]]]
  ];
  for (const [system, values] of expected) getSpellOptions(system).forEach((option, i) => {
    const auto = getSpellAutomation(system, option);
    assert.equal(auto.attackStat, "intcha");
    assert.equal(auto.damageType, "water");
    assert.deepEqual([auto.damage, auto.areaShape, auto.areaSize, auto.areaWidth, auto.areaOrigin], values[i]);
  });
});

test("every Shadow Play option keeps the Perception save; only Flower Bouquet rolls damage", () => {
  const values = getSpellOptions(shadow).map(option => getSpellAutomation(shadow, option));
  assert.deepEqual(values.map(auto => auto.saveStat), ["prc", "prc", "prc"]);
  assert.deepEqual(values.map(auto => auto.damage), ["", "", "4d4"]);
  assert.equal(values[2].damageType, "fire");
  assert.deepEqual(values.map(auto => auto.conditions), [[], [], []], "source-dependent conditions stay as rules text");
});

test("Transmuting Strike automates each circle and save; beginning-of-turn conditions stay manual", () => {
  const values = getSpellOptions(strike).map(option => getSpellAutomation(strike, option));
  assert.deepEqual(values.map(auto => auto.saveStat), ["con", "wis", "con"]);
  for (const auto of values) {
    assert.deepEqual([auto.areaShape, auto.areaSize, auto.areaOrigin], ["circle", 3, "placed"]);
    assert.equal(auto.attackStat, "");
    assert.equal(auto.damage, "");
    assert.deepEqual(auto.conditions, [], "do not apply a future turn's condition on cast");
  }
});

test("Meat Augmentation never rolls its reactive damage, delayed heal or end-of-turn caster save at cast time", () => {
  for (const option of getSpellOptions(meat)) {
    const auto = getSpellAutomation(meat, option);
    assert.deepEqual([auto.attackStat, auto.saveStat, auto.damage, auto.heal, auto.areaShape], ["", "", "", "", ""]);
    assert.deepEqual(auto.conditions, []);
  }
});

test("option overrides use the normal heal, condition, duration and save parsers, without changing cost or flavour", () => {
  const system = { ...crystal, description: "Flavour", effect: "Choose one:\nHeal: Heal 1d6\nHold: Target is immobilized" };
  const heal = { ...getSpellOptions(system)[0], target: "Single Ally", check: "No Check" };
  const hold = { ...getSpellOptions(system)[1], check: "Target Save Str+2", duration: "2 turns" };
  assert.equal(getSpellAutomation(system, heal).heal, "1d6");
  const auto = getSpellAutomation(system, hold);
  assert.deepEqual([auto.saveStat, auto.saveModifier, auto.attackStat, auto.damage], ["str", 2, "", ""]);
  assert.deepEqual(auto.conditions, [{ id: "immobilized", name: "Immobilized", formula: "2", timed: true, saveNegates: true }]);
  const selected = getSpellOptionSystem(system, { ...hold, mp: 0, cost: "Free", description: "Forged" });
  assert.equal(selected.mp, system.mp);
  assert.equal(selected.cost, system.cost);
  assert.equal(selected.description, "Flavour");
});

test("selected chat cards use the option's title, facts and effect, including unautomated rules", () => {
  for (const system of [crystal, darkness, shadow, strike, meat]) for (const option of getSpellOptions(system)) {
    const html = renderSpellCard({ name: system.name, system, option, auto: getSpellAutomation(system, option) });
    assert.ok(html.includes(`${system.name} — ${option.name}`));
    assert.ok(html.includes(option.effect.replaceAll("\n", "<br>")));
    assert.doesNotMatch(html, /Choose between|Pick a card/);
    assert.ok(html.includes(option.duration));
  }
  const html = renderSpellCard({ name: '<spell>', system: { effect: "Original", range: "Wrong" },
    option: { name: '<option> & "name"', range: "<range>", effect: '<script>alert("x")</script>\nManual & rules' } });
  assert.doesNotMatch(html, /<spell>|<option>|<range>|<script>|Original|Wrong/);
  assert.match(html, /&lt;spell&gt; — &lt;option&gt; &amp; &quot;name&quot;/);
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;<br>Manual &amp; rules/);
});
