import assert from "node:assert/strict";
import { test } from "node:test";
import { renderCheckCard, renderContestBoard, renderRollCard } from "../module/helpers/roll-card.mjs";

const roller = { name: "Drea", img: "drea.webp" };

test("shared roll cards accept visible effect HTML between facts and rows without changing other cards", () => {
  const card = { title: "Rules", facts: "Facts", rows: [{ name: "Target" }], details: { summary: "Weapon text", html: "<p>Traits</p>", open: true } };
  const html = renderRollCard({ ...card, effect: "<b>Effect</b><p>Rules</p>" });
  assert.match(html, /<div class="isc-facts">Facts<\/div><div class="isc-effect-block"><b>Effect<\/b><p>Rules<\/p><\/div><ol class="isc-targets">/);
  assert.match(html, /<details class="isc-text" open><summary>Weapon text<\/summary><p>Traits<\/p><\/details>/);
  assert.doesNotMatch(renderRollCard(card), /isc-effect/);
});

test("stat checks and saves show Success or Fail against the value, with the d20 as the big number", () => {
  const check = renderCheckCard({ roller, kind: "ability", statLabel: "Strength", value: 12, d20: 7 });
  assert.match(check, /class="isc-name">Strength check</);
  assert.match(check, /isc-chip isc-info" title="Needs 12 or less">≤ 12</);
  assert.match(check, /isc-chip isc-good"[^>]*>Success <small>7\/12</);
  assert.match(check, /fa-dice-d20"><\/i>7</);
  const save = renderCheckCard({ roller, kind: "save", statLabel: "Dexterity", value: 6, d20: 20 });
  assert.match(save, /Dexterity save/);
  assert.match(save, /isc-bad"[^>]*>Fail · nat 20/);
  assert.match(renderCheckCard({ roller, kind: "ability", statLabel: "Wil", value: 2, d20: 1 }), /isc-crit"[^>]*>Success · nat 1/);
});

test("Parry shows the roll against the Parry value and reminds to apply the GM's modifier", () => {
  const parry = renderCheckCard({ roller, kind: "parry", value: 6, d20: 9 });
  assert.match(parry, /class="isc-name">Parry</);
  assert.match(parry, /Apply GM modifier <small>9 vs 6<\/small>/);
  assert.doesNotMatch(parry, /Success|Fail/);
});

const sides = (attackState, saveState) => [
  { key: "attack", name: "Orc", img: "orc.webp", stat: "Strength", value: 8, die: 12, state: attackState, total: 2 },
  { key: "save", name: "Drea", img: "drea.webp", stat: "Dexterity", value: 6, die: 14, state: saveState, total: 5 }
];

test("a contest board shows both sides: waiting sides get Roll, rolling sides wait, done sides show totals", () => {
  const html = renderContestBoard({ stat: "Strength", sides: sides("done", "waiting") });
  assert.match(html, /class="isc-name">Strength contest</);
  assert.match(html, /Orc vs Drea/);
  assert.match(html, /Attack <small>Strength 8<\/small>/);
  assert.match(html, /<\/i>2</);
  assert.match(html, /data-incarnos-contest-roll="save" title="Roll save \(Dexterity\)"/);
  assert.doesNotMatch(html, /data-incarnos-contest-roll="attack"/);
  assert.match(html, /data-incarnos-contest-cancel/);
  assert.match(html, /<header class="isc-head" title="[^"]*Lower total wins/, "the rule is a tooltip on the header");
  assert.doesNotMatch(html.replace(/title="[^"]*"/g, ""), /Lower total wins/, "never as visible text");
  assert.match(renderContestBoard({ stat: "Strength", sides: sides("rolling", "waiting") }), /Rolling…/);
});

test("the outcome replaces the title, marks Winner/Lost and drops the buttons; a tie and later rounds are labelled", () => {
  const won = renderContestBoard({ stat: "Strength", sides: sides("done", "done"), outcome: { winner: "attack" } });
  assert.match(won, /class="isc-name">Orc wins!</);
  assert.match(won, /isc-good" title="Lower total wins">Winner/);
  assert.match(won, /isc-target isc-missed"><img class="isc-portrait" src="drea.webp"/);
  assert.doesNotMatch(won, /data-incarnos-contest-(roll|cancel)/);
  const tie = renderContestBoard({ stat: "Strength", round: 2, sides: sides("done", "done"), outcome: { winner: null, tie: true } });
  assert.match(tie, /Tie! Both roll again/);
  assert.match(tie, />Round 2</);
  assert.equal((tie.match(/>Tie</g) ?? []).length, 2);
});

test("a cancelled board says so and offers no buttons", () => {
  const html = renderContestBoard({ stat: "Strength", sides: sides("done", "waiting"), cancelled: true });
  assert.match(html, /Contest cancelled/);
  assert.match(html, /Not rolled/);
  assert.doesNotMatch(html, /data-incarnos-contest-(roll|cancel)/);
});
