/** Chat card for a cast spell, built on the shared roll card layout. */
import { SPELL_STATS, getSpellOptionSystem } from "./spells.mjs";
import { amount, applyAllButton, applyButton, checkChip, chip, criticalFailureButton, escape, renderRollCard, rollingChip } from "./roll-card.mjs";
import { hasCriticalFailure } from "./critical-failure-rules.mjs";

export { damageIcon } from "./roll-card.mjs";

/**
 * @param {object} card
 * @param {string} card.name            Spell name.
 * @param {string} card.img             Spell icon.
 * @param {object} card.system          Spell system data (element, category, range, target, check, duration, effect, description).
 * @param {object} card.auto            Automation in effect (attackStat, saveStat, saveEffect, damageType, areaShape…).
 * @param {{mp:number, hp?:number, actions:number}} card.paid
 * @param {{total:number, formula:string, result:string}|null} card.damage
 * @param {{total:number, formula:string, result:string}|null} card.heal
 * @param {object[]} card.results       Per target: name, img, hit, crit, saved, attack, save, damage, heal, pvp, optional attacks.
 * @param {{total:number, formula:string, result:string}|null} [card.critDamage]  Damage with maxed dice for critical hits.
 * @param {string} [card.attackLabel]   e.g. "Attack (Int 15 + Parry modifier)" for tooltips.
 * @param {boolean} [card.pending]      Dice still rolling: show targets without outcomes.
 * @returns {string}
 */
export function renderSpellCard({ name, img, system = {}, option = null, auto = {}, paid = {}, damage = null, critDamage = null, heal = null, results = [], attackLabel = "Attack", pending = false, criticalFailureLabel, summon = null }) {
  system = getSpellOptionSystem(system, option);
  const tags = [system.element, system.category, option?.name].filter(Boolean).map(escape).join(" · ");
  const cost = [paid.mp ? `${paid.mp} IP` : "", paid.hp ? `${paid.hp} HP` : "", paid.actions ? `${paid.actions} AP` : ""].filter(Boolean).join(" · ");
  const facts = [...new Set([system.range, system.target, system.check, system.duration].map(value => String(value ?? "").trim()).filter(Boolean))].map(escape).join(" · ");
  const resolves = Boolean(auto.attackStat || auto.saveStat || auto.damage || auto.heal);
  const saveLabel = auto.saveStat ? `${SPELL_STATS[auto.saveStat]} save` : "Save";

  const rows = results.map((result, index) => {
    if (pending) return { img: result.img, name: result.name, chips: [rollingChip()] };
    const halvedBySave = result.saved && auto.saveEffect === "half";
    const values = [];
    const multiAttack = Boolean(result.attacks?.length);
    if (result.damage || (multiAttack && auto.damage)) {
      const why = [result.crit && critDamage ? "crit: dice maxed" : "", halvedBySave ? "halved by save" : "", result.pvp ? "PvP halved" : ""].filter(Boolean).join(", ");
      values.push((multiAttack ? `<span class="isc-none">Total</span>` : "")
        + amount(result.damage, { kind: "damage", type: auto.damageType, title: `${result.damage}${auto.damageType ? ` ${auto.damageType}` : ""} damage${why ? ` (${why})` : ""}` })
        + (result.damage ? applyButton("damage", index, result.damage) : ""));
    }
    if (result.heal) values.push(amount(result.heal, { kind: "heal", title: `${result.heal} healing` }) + applyButton("heal", index, result.heal));
    const missed = !result.hit || ((damage || (multiAttack && auto.damage)) && !result.damage && !result.heal && !result.conditions?.length);
    if (!values.length) values.push(`<span class="isc-amount isc-none">${missed ? "no effect" : "—"}</span>`);
    return {
      img: result.img, name: result.name, dim: missed, values,
      ...(multiAttack ? { attacks: result.attacks, attackLabel, saveLabel, damageType: auto.damageType } : {}),
      chips: [
        checkChip(result.attack, { pass: "Hit", fail: "Miss", label: attackLabel }),
        checkChip(result.save, { pass: "Saved", fail: "Failed save", label: result.save?.advantage ? `${saveLabel} with advantage (${result.save.advantage})` : saveLabel }),
        result.save?.advantage ? chip("Adv", { title: `Advantage from ${result.save.advantage}: rolled 2d20, kept the lower` }) : "",
        result.save?.disadvantage ? chip("Dis", { title: `Disadvantage from ${result.save.disadvantage}: rolled 2d20, kept the higher` }) : "",
        result.pvp && result.damage ? chip("PvP ½", { title: "PvP rules: damage halved" }) : "",
        result.bonusDamage ? chip(`+${result.bonusDamage.amount}`, { tone: "note", title: `Included extra damage on a failed save: ${result.bonusDamage.formula} = ${result.bonusDamage.result}${auto.bonusDamage?.type ? ` ${auto.bonusDamage.type}` : ""}` }) : "",
        ...(result.conditions ?? []).map(condition => chip(`${condition.name}${condition.tokens ? ` ${condition.tokens}` : ""}`, { tone: "note", title: `${condition.name}${condition.tokens ? ` (${condition.tokens} tokens)` : ""}: put on the target automatically` })),
        result.crit && result.damage && critDamage ? chip("Max dmg", { tone: "crit", title: `Critical hit: damage dice maxed (${critDamage.formula} = ${critDamage.total})` }) : ""
      ]
    };
  });

  // The roll line only matters when someone was affected; on a full miss it would read like damage dealt.
  const notes = pending ? [] : [
    ...(summon ? [escape(game.i18n.format("INCARNOS.Summon.card", { name: summon.name, width: summon.width, height: summon.height, turns: summon.turns })),
      summon.corpse ? escape(game.i18n.localize("INCARNOS.Summon.corpse")) : "", escape(summon.warning)] : []),
    damage && results.some(result => result.damage && !result.crit) ? `<span title="${escape(damage.formula)}"><i class="fas fa-dice"></i> Damage ${escape(damage.result)} = <b>${damage.total}</b></span>` : "",
    critDamage && results.some(result => result.damage && result.crit) ? `<span title="${escape(critDamage.formula)}"><i class="fas fa-dice"></i> Crit damage (dice maxed) ${escape(critDamage.result)} = <b>${critDamage.total}</b></span>` : "",
    // Token rolls of conditions (e.g. sleep tokens), per target.
    ...results.flatMap(result => (result.conditions ?? []).filter(condition => condition.roll).map(condition =>
      `<span title="${escape(condition.roll.formula)}"><i class="fas fa-dice"></i> ${results.length > 1 ? `${escape(result.name)}: ` : ""}${escape(condition.name)} tokens ${escape(condition.roll.result)} = <b>${condition.tokens}</b></span>`)),
    heal && results.some(result => result.heal) ? `<span title="${escape(heal.formula)}"><i class="fas fa-dice"></i> Heal ${escape(heal.result)} = <b>${heal.total}</b></span>` : ""
  ];
  const pendingApplies = pending ? 0 : results.filter(result => result.damage || result.heal).length;
  const effect = String(system.effect ?? "").trim();
  const description = String(system.description ?? "").trim();
  const effectLabel = globalThis.game?.i18n?.localize("INCARNOS.Effect") ?? "Effect";
  const flavourLabel = globalThis.game?.i18n?.localize("INCARNOS.Flavour") ?? "Flavour";

  return renderRollCard({
    img, title: escape(option ? `${name} — ${option.name}` : name), tags, facts, rows, notes,
    effect: effect ? `<span class="isc-effect-label">${escape(effectLabel)}</span><p class="isc-effect">${escape(effect).replace(/\n/g, "<br>")}</p>` : "",
    chip: cost ? chip(cost, { tone: "info", title: "Paid" }) : "",
    empty: resolves && !results.length ? (auto.areaShape ? "No one in the area." : "No targets.") : "",
    action: (pendingApplies > 1 ? applyAllButton() : "") + (!pending && hasCriticalFailure(results) ? criticalFailureButton(criticalFailureLabel) : ""),
    details: description ? { summary: flavourLabel, html: `<div class="isc-flavour">${description}</div>` } : null
  });
}
