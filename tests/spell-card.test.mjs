import assert from "node:assert/strict";
import { test } from "node:test";
import { damageIcon, renderSpellCard } from "../module/helpers/spell-card.mjs";

const system = {
  element: "Fire", category: "Attack", range: "12m", target: "Single Enemy", check: "Attack Int / Cha", duration: "Instant",
  effect: "On hit: Deals 6d6 + (lvl * 2) fire dmg", description: "<p>A lance of fire.</p>"
};
const auto = { attackStat: "intcha", damage: "6d6 + (@lvl * 2)", damageType: "fire" };
const damage = { total: 18, formula: "6d6 + (1 * 2)", result: "16 + 2" };

test("a hit shows the target, an outcome chip, the damage and an Apply button", () => {
  const html = renderSpellCard({
    name: "Firelance", img: "fire.webp", system, auto, paid: { mp: 10, actions: 0 }, damage,
    results: [{ name: "Drea", img: "drea.webp", hit: true, attack: { d20: 5, threshold: 13 }, damage: 18 }]
  });
  assert.match(html, /class="isc-name">Firelance</);
  assert.match(html, /class="isc-chip isc-info" title="Paid">10 IP</);
  assert.match(html, /12m · Single Enemy · Attack Int \/ Cha · Instant/);
  assert.match(html, /isc-chip isc-good" title="Attack: rolled 5, needed 13 or less">Hit <small>5\/13<\/small>/);
  assert.match(html, /isc-amount isc-damage[^>]*><i class="fas fa-fire"><\/i>18</);
  assert.match(html, /data-incarnos-spell-apply="damage" data-index="0"/);
  assert.ok(!html.includes("Apply all"), "one target needs no Apply all");
  assert.match(html, /<details class="isc-text"><summary>Flavour<\/summary>/);
});

test("misses, saves, crits and PvP are labelled; several targets get Apply all", () => {
  const html = renderSpellCard({
    name: "Burning Grounds", system, auto: { saveStat: "dex", saveEffect: "half", damage: "3d6", damageType: "fire", areaShape: "circle" },
    damage: { total: 14, formula: "3d6", result: "14" },
    results: [
      { name: "Goblin", hit: true, save: { d20: 12, threshold: 5 }, damage: 14 },
      { name: "Orc", hit: true, save: { d20: 1, threshold: 8 }, saved: true, damage: 7 },
      { name: "Ally", hit: true, save: { d20: 20, threshold: 9 }, damage: 7, pvp: true }
    ]
  });
  assert.match(html, /isc-bad"[^>]*>Failed save <small>12\/5/);
  assert.match(html, /isc-crit"[^>]*>Saved · nat 1/);
  assert.match(html, /Failed save · nat 20/);
  assert.match(html, /PvP ½/);
  assert.match(html, /title="7 fire damage \(halved by save\)"/);
  assert.match(html, /data-incarnos-spell-apply="all"/);
});

test("missed targets are dimmed, empty areas say so, plain spells show their effect without a fold", () => {
  const miss = renderSpellCard({ name: "Firelance", system, auto, damage, results: [{ name: "Orc", hit: false, attack: { d20: 17, threshold: 12 }, damage: 0 }] });
  assert.match(miss, /isc-target isc-missed/);
  assert.match(miss, /no effect/);
  assert.doesNotMatch(miss, /Damage 16/, "no damage line when nobody was hit");
  assert.match(renderSpellCard({ name: "Gale", system, auto: { saveStat: "str", areaShape: "line" }, results: [] }), /No one in the area\./);
  const plain = renderSpellCard({ name: "Heataura", system: { effect: "Melee: <burn>" } });
  assert.match(plain, /class="isc-effect-block"/);
  assert.doesNotMatch(plain, /<details/);
  assert.match(plain, /Melee: &lt;burn&gt;/);
  assert.equal(damageIcon("Water"), "fa-droplet");
  assert.equal(damageIcon("odd"), "fa-burst");
});

test("spell effects stay visible before targets and flavour stays folded in every cast state", () => {
  for (const automation of [auto, {}]) for (const pending of [false, true]) {
    const html = renderSpellCard({ name: "Firelance", system: { ...system, effect: "On hit: <burn> & scorch\nNext turn: fade" },
      auto: automation, pending, results: [{ name: "Target", hit: true }] });
    const folded = html.match(/<details\b[^>]*>[\s\S]*?<\/details>/g) ?? [];
    assert.equal(folded.length, 1);
    assert.match(folded[0], /^<details class="isc-text"><summary>Flavour<\/summary><div class="isc-flavour"><p>A lance of fire\.<\/p><\/div><\/details>$/);
    assert.doesNotMatch(folded[0], /isc-effect|On hit/);
    const visible = html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, "");
    assert.match(visible, /class="isc-effect-label">Effect<\/span><p class="isc-effect">On hit: &lt;burn&gt; &amp; scorch<br>Next turn: fade<\/p>/);
    assert.ok(html.indexOf('class="isc-facts"') < html.indexOf('class="isc-effect-block"'));
    assert.ok(html.indexOf('class="isc-effect-block"') < html.indexOf('class="isc-targets"'));
    assert.ok(html.indexOf('class="isc-targets"') < html.indexOf("<details"));
  }
});

test("empty descriptions omit flavour entirely, and empty effects omit the rules block", () => {
  for (const description of [undefined, null, "", " \n "]) {
    const html = renderSpellCard({ name: "Plain", system: { effect: "Rules", description } });
    assert.match(html, /class="isc-effect-block"/);
    assert.doesNotMatch(html, /<details|isc-flavour|Flavour/);
  }
  const flavourOnly = renderSpellCard({ name: "Lore", system: { description: "<p>Ancient magic.</p>" } });
  assert.doesNotMatch(flavourOnly, /isc-effect/);
  assert.match(flavourOnly, /<details class="isc-text"><summary>Flavour<\/summary>/);
});

test("while the dice roll, targets show without outcomes, numbers or buttons", () => {
  const html = renderSpellCard({
    name: "Firelance", system, auto, damage, pending: true,
    results: [{ name: "Drea", hit: true, attack: { d20: 5, threshold: 13 }, damage: 18 }, { name: "Orc", hit: false, damage: 0 }]
  });
  assert.equal((html.match(/Rolling…/g) ?? []).length, 2);
  assert.doesNotMatch(html, /Hit|Miss|isc-amount|data-incarnos-spell-apply|Damage 16/);
});

test("a critical spell attack shows the maxed damage for that target", () => {
  const html = renderSpellCard({
    name: "Firelance", system: {}, auto: { attackStat: "int", damage: "6d6", damageType: "fire" },
    damage: { total: 20, formula: "6d6", result: "3 + 4 + 2 + 5 + 1 + 5" },
    critDamage: { total: 36, formula: "6d6", result: "6 + 6 + 6 + 6 + 6 + 6" },
    results: [
      { name: "Goblin", hit: true, crit: true, attack: { d20: 1, threshold: 12 }, damage: 36 },
      { name: "Orc", hit: true, crit: false, attack: { d20: 7, threshold: 12 }, damage: 20 }
    ]
  });
  assert.match(html, /Max dmg/);
  assert.match(html, /Crit damage \(dice maxed\) 6 \+ 6 \+ 6 \+ 6 \+ 6 \+ 6 = <b>36<\/b>/);
  assert.match(html, /Damage 3 \+ 4/);
});

test("spell conditions show as chips (they are put on the targets automatically) and token rolls are listed", () => {
  const html = renderSpellCard({
    name: "Tsunami", system: {}, auto: { saveStat: "str" },
    results: [
      { name: "Goblin", hit: true, saved: false, save: { d20: 15, threshold: 6 }, damage: 0, conditions: [{ id: "prone", name: "Prone" }] },
      { name: "Orc", hit: true, saved: true, save: { d20: 2, threshold: 6 }, damage: 0, conditions: [] }
    ]
  });
  assert.match(html, /isc-chip isc-note" title="Prone: put on the target automatically">Prone</);
  assert.doesNotMatch(html, /data-incarnos-spell-apply/, "no Apply needed for conditions");
  const withDamage = renderSpellCard({
    name: "Go to Sleep..", system: {}, auto: { attackStat: "dex", damage: "1d6" }, damage: { total: 4, formula: "1d6", result: "4" },
    results: [{ name: "Goblin", hit: true, attack: { d20: 5, threshold: 12 }, damage: 4, conditions: [{ id: "asleep", name: "Asleep", tokens: 11, roll: { formula: "4d4 + 2", result: "3 + 4 + 1 + 1 + 2" } }] }]
  });
  assert.match(withDamage, />Asleep 11</);
  assert.match(withDamage, /Asleep tokens 3 \+ 4 \+ 1 \+ 1 \+ 2 = <b>11<\/b>/);
});

test("multi-attack cards list every roll and hit's damage, then one total Apply per target", () => {
  const results = [{ name: "Target <one>", hit: true, crit: true, damage: 24, conditions: [{ id: "prone", name: "Prone" }], attacks: [
    { attack: { d20: 8, threshold: 10 }, hit: true, damage: 9, damageRoll: { formula: "3d4 + 3", result: "2 + 3 + 1 + 3", total: 9 } },
    { attack: { d20: 20, threshold: 10 }, hit: false, damage: 0 },
    { attack: { d20: 1, threshold: 10 }, hit: true, crit: true, damage: 15, damageRoll: { formula: "3d4 + 3", result: "4 + 4 + 4 + 3", total: 15 } }
  ] }, { name: "Other", hit: true, damage: 7, attacks: [
    { attack: { d20: 5, threshold: 8 }, hit: true, damage: 7 },
    { attack: { d20: 15, threshold: 8 }, hit: false, damage: 0 },
    { attack: { d20: 18, threshold: 8 }, hit: false, damage: 0 }
  ] }];
  const card = { name: "Leaf toss", auto: { attackStat: "intcha", attackCount: 3, damage: "3d4 + (@lvl * 1)", damageType: "earth" }, results };
  const html = renderSpellCard(card);
  assert.match(html, /Target &lt;one&gt;/);
  assert.match(html, /Attack 1: Hit <small>8\/10<\/small>/);
  assert.match(html, /Attack 2: Miss · nat 20 <small>20\/10<\/small>/);
  assert.match(html, /Attack 3: Hit · nat 1 <small>1\/10<\/small>/);
  assert.match(html, /9 earth damage/);
  assert.match(html, /0 earth damage/);
  assert.match(html, /15 earth damage \(dice maxed\)/);
  assert.match(html, /3d4 \+ 3: 4 \+ 4 \+ 4 \+ 3 = 15 \(dice maxed\)/);
  assert.ok(html.indexOf("Attack 3: Hit") < html.indexOf(">Total</span>"));
  assert.match(html, />Total<\/span>.*fa-mountain"><\/i>24<\/span>/);
  assert.equal((html.match(/data-incarnos-spell-apply="damage"/g) ?? []).length, 2);
  assert.match(html, /data-index="0" title="Apply 24 damage"/);
  assert.match(html, /data-index="1" title="Apply 7 damage"/);
  assert.match(html, /data-incarnos-spell-apply="all"/);
  assert.equal((html.match(/>Prone</g) ?? []).length, 1);
  const pending = renderSpellCard({ ...card, pending: true });
  assert.doesNotMatch(pending, /Attack [123]:|Total|isc-amount|data-incarnos-spell-apply/);
  assert.equal((pending.match(/Rolling…/g) ?? []).length, 2);
});

test("a multi-attack full miss shows all misses and a zero total without Apply", () => {
  const html = renderSpellCard({ name: "Leaf toss", auto: { attackStat: "int", damage: "3d4" },
    results: [{ name: "Target", hit: false, damage: 0, attacks: [18, 19, 20].map(d20 => ({ attack: { d20, threshold: 10 }, damage: 0 })) }] });
  assert.equal((html.match(/Attack [123]: Miss/g) ?? []).length, 3);
  assert.match(html, /isc-target isc-missed/);
  assert.match(html, />Total<\/span>.*fa-burst"><\/i>0<\/span>/);
  assert.doesNotMatch(html, /data-incarnos-spell-apply/);
});
