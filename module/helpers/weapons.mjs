/**
 * Weapon traits, read live from the weapon's trait text (one "Name value: description" line per trait,
 * as in the Weapons sheet). Only traits with a clear effect on an attack roll are automated; the rest
 * show on the attack card as text.
 */

/** Split trait text into { name, value, text } entries. "(Once per Turn) Shield Bash: …" keeps its prefix in `name`. */
export function parseWeaponTraits(text = "") {
  return String(text).split("\n").map(line => line.trim()).filter(Boolean).map(line => {
    const colon = line.indexOf(":");
    const head = (colon >= 0 ? line.slice(0, colon) : line).trim();
    const description = colon >= 0 ? line.slice(colon + 1).trim() : "";
    const match = head.match(/^(.*?)\s+((?:\d+(?:[.,]\d+)?\s*m)|(?:\d+\s*-\s*\d+)|(?:\d*[dD]\d+))$/);
    return { name: (match ? match[1] : head).trim(), value: match ? match[2].replace(/\s+/g, "") : "", text: description, line };
  });
}

const die = value => {
  const match = String(value ?? "").match(/^\d*[dD](\d+)$/);
  return match ? Number(match[1]) : null;
};
const traitNamed = (traits, name) => traits.find(trait => trait.name.replace(/^\([^)]*\)\s*/, "").toLowerCase() === name.toLowerCase());

/**
 * Attack rules a weapon's traits imply.
 * @returns {{finesse:boolean, throwable:string, deadly:number|null, fatal:number|null, critRange:number,
 *   twoHand:number|null, poorPrecision:boolean, sweep:boolean, reach:string, traits:object[]}}
 */
export function getWeaponRules(system = {}) {
  const traits = parseWeaponTraits(system.traits);
  const critical = traitNamed(traits, "Critical Strike")?.value.match(/^\d+-(\d+)$/);
  return {
    finesse: Boolean(traitNamed(traits, "Finesse")),
    throwable: traitNamed(traits, "Throwable")?.value ?? "",
    deadly: die(traitNamed(traits, "Deadly")?.value),
    fatal: die(traitNamed(traits, "Fatal")?.value),
    critRange: critical ? Math.max(1, Math.min(19, Number(critical[1]))) : 1,
    twoHand: die(traitNamed(traits, "Two-Hand")?.value),
    poorPrecision: Boolean(traitNamed(traits, "Poor Precision")),
    sweep: Boolean(traitNamed(traits, "Sweep")),
    reach: traitNamed(traits, "Reach")?.value ?? "",
    traits
  };
}

/** Replace the size of the formula's first die, e.g. ("1d6 + 2", 10) → "1d10 + 2". */
export function withDieSize(formula, faces) {
  return String(formula).replace(/(\d*)d\d+/i, (_, count) => `${count || 1}d${faces}`);
}

/**
 * Damage formula for one hit after traits: Two-Hand swaps the die, Fatal swaps it on a crit,
 * Deadly adds a die on a crit.
 */
export function getTraitDamageFormula(formula, rules, { crit = false, twoHanded = false } = {}) {
  if (!formula) return formula;
  let result = formula;
  if (twoHanded && rules.twoHand) result = withDieSize(result, rules.twoHand);
  if (crit && rules.fatal) result = withDieSize(result, rules.fatal);
  if (crit && rules.deadly) result = `${result} + 1d${rules.deadly}`;
  return result;
}

/**
 * Hit result for one attack roll after traits.
 * @param {number} d20        Kept d20.
 * @param {number} needed     The die must be this or lower (threshold − attack modifier).
 * @returns {{success:boolean, crit:boolean, fumble:boolean}}
 */
export function getTraitHit(d20, needed, rules = {}) {
  const crit = d20 <= (rules.critRange ?? 1);
  const fumble = d20 === 20;
  const normal = crit || (!fumble && d20 <= needed);
  // Poor Precision: the weapon hits when the attack roll fails and misses when it succeeds.
  return { success: rules.poorPrecision ? !normal : normal, crit: crit && !rules.poorPrecision, fumble };
}

/** Short description of the automated traits, for the weapon sheet. */
export function describeWeaponRules(rules) {
  return [
    rules.finesse ? "Finesse (better of Str/Dex in melee)" : "",
    rules.throwable ? `Throwable ${rules.throwable} (can attack as ranged)` : "",
    rules.critRange > 1 ? `Crits on 1–${rules.critRange}` : "",
    rules.deadly ? `Deadly: +1d${rules.deadly} on crits` : "",
    rules.fatal ? `Fatal: d${rules.fatal} damage on crits` : "",
    rules.twoHand ? `Two-Hand option: −2 hitrate, d${rules.twoHand}` : "",
    rules.poorPrecision ? "Poor Precision: hits on a failed roll" : "",
    rules.sweep ? "Sweep: full damage with Cleave" : ""
  ].filter(Boolean).join(" · ");
}
