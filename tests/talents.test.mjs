import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyTalentRules, describeTalent, getTalentRules, getTalentSummary, isSpectacle, parseTalentPassives, parseTalentRules
} from "../module/helpers/talents.mjs";
import { parseTalentNote, talentsToDocuments } from "../tools/talent-notes.mjs";
import { renderCheckCard } from "../module/helpers/roll-card.mjs";

test("only whole-line flat stat bonuses become passives; check bonuses stay text", () => {
  assert.deepEqual(parseTalentPassives("+1 Parry").map(({ stat, value }) => [stat, value]), [["attributes.parry.value", 1]]);
  assert.deepEqual(parseTalentPassives("+1 Intelligence\nYou always know which way is north.").map(p => p.stat), ["abilities.int.value"]);
  assert.deepEqual(parseTalentPassives("You gain a bonus to dark magic.\n-1 Charisma").map(p => [p.stat, p.value]), [["abilities.cha.value", -1]]);
  assert.deepEqual(parseTalentPassives("You deal 1d4 extra dmg\nYou gain +2m movement").map(p => [p.stat, p.value]), [["attributes.movement.value", 2]]);
  assert.deepEqual(parseTalentPassives("+2 Willpower"), [{ stat: "abilities.wis.value", value: 2, text: "+2 Willpower" }]);
  for (const text of ["+4 in Repairing Checks", "+2 on Fabric Checks", "+4 to all saves against breaking character", "+4 in Perception Checks against ambushes"]) {
    assert.deepEqual(parseTalentPassives(text), [], text);
  }
});

test("save advantage, darkvision and Impressive Spectacle are read from the Bonus text", () => {
  assert.deepEqual(parseTalentRules("Advantage on Charisma/Willpower Saving Throws").saveAdvantage, ["cha", "wis"]);
  assert.equal(parseTalentRules("Vision up to 9m in Darkness").darkvision, 9);
  assert.deepEqual(parseTalentRules("If you attack with a one-handed weapon, and you succeed an attack by over 10 (e.g. …), your damage is doubled for this attack.").spectacle, { margin: 10 });
  assert.deepEqual(parseTalentRules("You have advantage on survival checks"),
    { saveAdvantage: [], saveBonus: null, darkvision: 0, spectacle: null, movementMultiplier: 1, hpMagic: false });
});

test("actor rules combine all talents and name the source; other item types are ignored", () => {
  const rules = getTalentRules([
    { type: "feature", name: "Cold-Hearted", system: { bonus: "Advantage on Charisma/Willpower Saving Throws" } },
    { type: "feature", name: "Nightvision", system: { bonus: "Vision up to 9m in Darkness" } },
    { type: "weapon", name: "Odd", system: { bonus: "Vision up to 30m in Darkness" } }
  ]);
  assert.deepEqual(rules.saveAdvantage, { cha: "Cold-Hearted", wis: "Cold-Hearted" });
  assert.equal(rules.darkvision, 9);
  assert.equal(rules.darkvisionSource, "Nightvision");
  assert.equal(getTalentRules(undefined).spectacle, null);
});

test("Impressive Spectacle needs a one-handed hit at least the margin under the target number (needs 12, rolled 2 counts)", () => {
  const spectacle = { margin: 10 };
  assert.equal(isSpectacle(spectacle, { success: true, d20: 2, needed: 12, oneHanded: true }), true);
  assert.equal(isSpectacle(spectacle, { success: true, d20: 3, needed: 12, oneHanded: true }), false);
  assert.equal(isSpectacle(spectacle, { success: true, d20: 2, needed: 12, oneHanded: false }), false);
  assert.equal(isSpectacle(null, { success: true, d20: 1, needed: 20, oneHanded: true }), false);
});

test("talent sheet and profile show the bonus and what is automated", () => {
  assert.equal(describeTalent({ bonus: "+1 Parry", passives: { a: { stat: "attributes.parry.value", value: 1 } } }), "Parry +1");
  assert.equal(describeTalent({ bonus: "Advantage on Charisma/Willpower Saving Throws" }), "advantage on Cha/Wil saves");
  assert.equal(getTalentSummary({ bonus: "+1 <b>\nline", description: "<p>Flavour</p>" }), '<p class="talent-bonus">+1 &lt;b&gt;<br>line</p><p>Flavour</p>');
  assert.equal(getTalentSummary({ description: "<p>Only</p>" }), "<p>Only</p>");
});

test("vault talent notes become feature documents with stat passives", () => {
  const note = "```ad-note\ntitle:### Tough Skin\n```\n```ad-check\ntitle: ### Stat Beschreibung:\nTyp: Talent\nBonus: +1 Parry\nSecond line\n```\n```ad-example\ntitle: ### Beschreibung:\nYour skin is tough.\n```\n";
  const { talent, warnings } = parseTalentNote(note, "file");
  assert.deepEqual(warnings, []);
  assert.deepEqual(talent, { name: "Tough Skin", bonus: "+1 Parry\nSecond line", description: "Your skin is tough." });
  const [doc] = talentsToDocuments([talent]);
  assert.equal(doc.type, "feature");
  assert.equal(doc.system.description, "<p>Your skin is tough.</p>");
  assert.deepEqual(doc.system.passives, { bonus1: { stat: "attributes.parry.value", value: 1, description: "+1 Parry" } });
  assert.equal(talentsToDocuments([talent])[0]._id, doc._id, "IDs are stable");
  assert.match(parseTalentNote("no type", "Notes").warnings[0], /not a talent note/);
});

test("race rules: save bonuses, movement multipliers, HP instead of IP and an open stat bonus", () => {
  assert.deepEqual(parseTalentRules("+2 on Constitution, Willpower, Charisma, Intelligence Saving Throws").saveBonus, { keys: ["con", "wis", "cha", "int"], value: 2 });
  assert.equal(parseTalentRules("You have 1.5x movementspeed").movementMultiplier, 1.5);
  assert.equal(parseTalentRules("You have 2x movementspeed on normal terrain, but only have 0.25x movementspeed on difficult terrain").movementMultiplier, 2);
  assert.equal(parseTalentRules("You have no IP. Instead gain HP and all spells use HP.").hpMagic, true);
  assert.equal(parseTalentRules("+4 on Persuasion Checks").saveBonus, null);
  assert.deepEqual(parseTalentPassives("You gain the ability to glide in the air\n+1 Stat Bonus"), [{ stat: "", value: 1, text: "+1 Stat Bonus (choose the stat)" }]);
  assert.equal(describeTalent({ bonus: "+1 Stat Bonus", passives: { a: { stat: "", value: 1 } } }), "+1 to a stat you pick on the Passives tab");
  assert.equal(describeTalent({ bonus: "You have 2x movementspeed" }), "Movement ×2");
});

test("race rules change derived stats: saves and movement before flat passives, IP into HP after", () => {
  const rules = getTalentRules([
    { type: "race", name: "Dwarf", system: { bonus: "+2 on Constitution, Willpower Saving Throws" } },
    { type: "feature", name: "Odd Talent", system: { bonus: "+1 on Constitution Saving Throws" } }
  ]);
  assert.deepEqual(rules.saveBonus.con, { value: 3, source: "Dwarf, Odd Talent" });
  const system = { abilities: { con: { save: 8 }, wis: { save: 7 }, str: { save: 6 } }, attributes: { movement: { value: 6 } }, health: { max: 20 }, power: { max: 9, value: 4 } };
  applyTalentRules(system, rules, "saves");
  assert.deepEqual([system.abilities.con.save, system.abilities.wis.save, system.abilities.str.save], [11, 9, 6]);

  const centaur = getTalentRules([{ type: "race", name: "Centaur", system: { bonus: "You have 2x movementspeed" } }]);
  applyTalentRules(system, centaur, "saves");
  assert.equal(system.attributes.movement.value, 12);

  const abomination = getTalentRules([{ type: "race", name: "Abomination", system: { bonus: "You have no IP. Instead gain HP and all spells use HP." } }]);
  assert.deepEqual(abomination.hpMagic, { source: "Abomination" });
  applyTalentRules(system, abomination, "resources");
  assert.deepEqual([system.health.max, system.power.max, system.power.value], [29, 0, 0]);
});

test("vault race notes become race documents", () => {
  const note = "```ad-note\ntitle:### Tabaxi\n```\n```ad-check\ntitle: ### Stat Beschreibung:\nTyp: Race\nBonus: +2 Dexterity\n```\n```ad-example\ntitle: ### Beschreibung:\nTabaxi\n```\n";
  const { talent } = parseTalentNote(note, "file", { kind: "Race" });
  const [doc] = talentsToDocuments([talent], { type: "race" });
  assert.equal(doc.type, "race");
  assert.deepEqual(doc.system.passives, { bonus1: { stat: "abilities.dex.value", value: 2, description: "+2 Dexterity" } });
  assert.notEqual(doc._id, talentsToDocuments([talent])[0]._id, "a race and a talent with the same name get different IDs");
  assert.match(parseTalentNote(note, "Tabaxi").warnings[0], /not a talent note/);
});

test("check cards name a save bonus that is already in the target number", () => {
  const card = renderCheckCard({ roller: { name: "Drea" }, kind: "save", statLabel: "Constitution", value: 12, d20: 11, bonus: { source: "Dwarf", value: 2 } });
  assert.match(card, /\+2 · Dwarf/);
  assert.match(card, /≤ 12/);
});

test("check cards name the advantage source and show both dice", () => {
  const card = renderCheckCard({ roller: { name: "Drea" }, kind: "save", statLabel: "Charisma", value: 11, d20: 4, advantage: { source: "Cold-Hearted", dice: [17, 4] } });
  assert.match(card, /Advantage · Cold-Hearted/);
  assert.match(card, /d20s: 17, 4, kept 4/);
  assert.match(card, /Success/);
});


test("Incarna and legacy resource bonuses import as the same actor passive", () => {
  for (const resource of ["IP", "Incarna", "Incarna Points", "MP", "PP", "Mana", "Power", "Power Points"]) {
    const bonus = "+2 " + resource;
    assert.deepEqual(parseTalentPassives(bonus), [{ stat: "power.max", value: 2, text: bonus }]);
    const [doc] = talentsToDocuments([{ name: "Magic", bonus, description: "" }]);
    assert.equal(doc.system.passives.bonus1.stat, "power.max");
    assert.equal(describeTalent(doc.system), "Max IP +2");
  }
});

test("Abomination recognizes IP and legacy resource names and describes Incarna as IP", () => {
  for (const resource of ["IP", "Incarna", "Incarna Points", "MP", "PP", "Mana", "Power", "Power Points"]) {
    const system = { bonus: "You have no " + resource + ". Instead gain HP and all spells use HP." };
    assert.equal(parseTalentRules(system.bonus).hpMagic, true, resource);
    assert.equal(describeTalent(system), "no IP: Max IP is added to Max HP and spells cost HP");
  }
  assert.equal(parseTalentRules("You have no IP.").hpMagic, false);
});

test("vault Abomination race notes preserve IP text and enable the live HP conversion", () => {
  const note = "Typ: Race\n" + "\x60\x60\x60ad-check\nBonus: You have no IP. Instead gain HP and all spells use HP.\n\x60\x60\x60\n";
  const { talent, warnings } = parseTalentNote(note, "Abomination", { kind: "Race" });
  assert.deepEqual(warnings, []);
  const [doc] = talentsToDocuments([talent], { type: "race" });
  const rules = getTalentRules([doc]);
  const system = { health: { max: 20 }, power: { max: 9, value: 4 } };
  applyTalentRules(system, rules, "resources");
  assert.deepEqual(system, { health: { max: 29 }, power: { max: 0, value: 0 } });
});
