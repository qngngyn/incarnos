/**
 * Who a spell may target, from its Target line (rules: Incarnos Rules section 7, "Targets").
 * Enemy = another token disposition than the caster's. Ally = same disposition, never the caster.
 * Target = anyone, the caster included. Friendlies = same disposition, the caster included.
 */

/**
 * @param {string} target  The spell's (or chosen option's) Target line.
 * @returns {{kind: "self"|"pick"|"all"|"free", side: "enemy"|"ally"|"friendly"|"any", min: number, max: number,
 *   self: boolean, requires: "asleep"|"downed"|"shadowmarked"|null}}
 */
export function parseSpellTargets(target = "") {
  const text = String(target ?? "").trim().replace(/\s+/g, " ");
  const rule = (kind, side = "any", min = 1, max = 1, extra = {}) => ({ kind, side, min, max, self: side === "friendly" || side === "any", requires: null, ...extra });
  let match;
  if (/^self$/i.test(text)) return rule("self", "any", 0, 0, { self: true });
  if (/^self \+ single target$/i.test(text)) return rule("pick", "any", 1, 1, { self: false });
  if (/^single enemy$/i.test(text)) return rule("pick", "enemy");
  if (/^single ally$/i.test(text)) return rule("pick", "ally");
  if (/^single target$/i.test(text)) return rule("pick");
  if (/^asleep single target$/i.test(text)) return rule("pick", "any", 1, 1, { requires: "asleep" });
  if (/^single downed target$/i.test(text)) return rule("pick", "any", 1, 1, { requires: "downed" });
  if ((match = text.match(/^(\d+) single enem(?:y|ies)$/i))) return rule("pick", "enemy", 1, Number(match[1]));
  if (/^one\s*\/\s*two enemies$/i.test(text)) return rule("pick", "enemy", 1, 2);
  if ((match = text.match(/^up to (\d+) enemies$/i))) return rule("pick", "enemy", 1, Number(match[1]));
  if (/^shadowmarked enemies$/i.test(text)) return rule("all", "enemy", 1, Infinity, { requires: "shadowmarked" });
  if (/^(?:\w+ )?enemies$/i.test(text)) return rule("all", "enemy", 1, Infinity);
  if (/^allies$/i.test(text)) return rule("all", "ally", 1, Infinity);
  if (/^friendlies$/i.test(text)) return rule("all", "friendly", 1, Infinity);
  // Areas without a side (Ground Circle, Line from User …), objects (Single Weapon, Oils …) and free text: no check.
  return rule("free", "any", 0, Infinity);
}

/** How a token stands to the caster: "self", "ally" (same disposition) or "enemy". */
export function relationTo(caster, token) {
  if (!token) return "enemy";
  if (caster?.token && (token === caster.token || token.id === caster.token.id)) return "self";
  if (caster?.actor && token.actor === caster.actor && !caster.token) return "self";
  const mine = caster?.token?.document?.disposition ?? caster?.actor?.prototypeToken?.disposition;
  const theirs = token.document?.disposition;
  // Unknown dispositions (no token data): "unknown" fits any side, so missing data never blocks a cast.
  if (mine == null || theirs == null) return "unknown";
  return theirs === mine ? "ally" : "enemy";
}

const sideAllows = (side, relation, self) => relation === "unknown" ? true : relation === "self" ? self
  : side === "enemy" ? relation === "enemy" : side === "ally" || side === "friendly" ? relation === "ally" : true;

/** Tokens of an area that fit the rule's side (the caster only where the rule allows it). */
export function filterBySide(rule, tokens, caster) {
  return tokens.filter(token => sideAllows(rule.side, relationTo(caster, token), rule.self));
}

const plural = (count, word, words) => `${count} ${count === 1 ? word : words}`;

/** Short English description for warnings: "1 enemy", "1–2 enemies", "1 ally (not yourself)". */
export function describeSpellTargets(rule) {
  const noun = { enemy: ["enemy", "enemies"], ally: ["ally", "allies"], friendly: ["friendly creature", "friendly creatures"], any: ["target", "targets"] }[rule.side];
  const count = rule.max === Infinity ? `any number of ${noun[1]}`
    : rule.min === rule.max ? plural(rule.max, ...noun) : `${rule.min}–${rule.max} ${noun[1]}`;
  const extra = rule.requires === "asleep" ? " who is asleep" : rule.requires === "downed" ? " who is downed (0 HP)"
    : rule.requires === "shadowmarked" ? " marked with the mark of shadows" : "";
  const self = rule.side === "ally" ? " (not yourself)" : rule.side === "enemy" || rule.self ? "" : " other than yourself";
  return count + extra + self;
}

/**
 * Check chosen targets against the rule.
 * @param {object} rule  From parseSpellTargets.
 * @param {{relation: string, asleep?: boolean, downed?: boolean, inRange?: boolean}[]} entries
 * @returns {string|null}  A problem ("count", "side", "asleep", "downed", "shadowmarked", "range") or null when they fit.
 */
export function checkSpellTargets(rule, entries) {
  if (rule.kind === "free" || rule.kind === "self") return null;
  if (entries.length < rule.min || entries.length > rule.max) return "count";
  if (entries.some(entry => !sideAllows(rule.side, entry.relation, rule.self))) return "side";
  if (rule.requires === "asleep" && entries.some(entry => !entry.asleep)) return "asleep";
  if (rule.requires === "downed" && entries.some(entry => !entry.downed)) return "downed";
  if (rule.requires === "shadowmarked" && entries.some(entry => !entry.shadowmarked)) return "shadowmarked";
  if (entries.some(entry => entry.inRange === false)) return "range";
  return null;
}
