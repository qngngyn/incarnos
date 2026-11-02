/** Choices for a spell's cost type. */
export const SPELL_ACTION_TYPES = { action: "Action", reaction: "Reaction" };

/** Labels for what the spell text describes. Stat keys match actor abilities (Wil is stored as `wis`). */
export const SPELL_STATS = { str: "Str", dex: "Dex", con: "Con", wis: "Wil", prc: "Prc", spd: "Spd", int: "Int", cha: "Cha" };
export const SPELL_ATTACK_STATS = { "": "No attack roll", intcha: "Int / Cha (higher)", ...SPELL_STATS };
export const SPELL_SAVE_EFFECTS = { "": "Damage unaffected", half: "Half damage", none: "No damage" };
export const SPELL_AREA_ORIGINS = { placed: "Placed by caster", self: "From caster" };

/** What `parseSpellAutomation` returns when the text describes nothing to roll. */
export const SPELL_AUTOMATION_DEFAULTS = Object.freeze({
  attackStat: "", attackCount: 1, attackModifier: 0, saveStat: "", saveModifier: 0, saveEffect: "",
  damage: "", damageType: "", heal: "", areaShape: "", areaSize: 0, areaWidth: 0, areaOrigin: "placed"
});

const STAT_WORDS = { str: "str", dex: "dex", con: "con", wil: "wis", wis: "wis", prc: "prc", spd: "spd", int: "int", cha: "cha" };
const STAT = "Str|Dex|Con|Wil|Prc|Spd|Int|Cha";
// A dice count is required: "Momentum × d6" depends on play and stays manual.
const DICE = String.raw`\b\d+d\d+(?:\s*[+\-]\s*(?:\d+d\d+|\d+|\(\s*lvl\s*\*\s*\d+\s*\)))*`;
const DAMAGE_TYPES = /\b(fire|water|air|earth|thunder|lightning|blood|poison|light|dark(?:ness)?|shadow|necrotic|psychic|physical|piercing|slashing|blunt|sleep)\s+(?:dmg|damage)\b/i;
const meters = text => Number(String(text).replace(",", "."));
const toFormula = dice => dice.replace(/\s+/g, " ").trim().replace(/\blvl\b/g, "@lvl");

/**
 * Read automation settings from a spell's sheet text (check, effect, range, target).
 * Only clear patterns are filled in; conditional or tiered effects stay manual.
 * @param {object} system  Spell system data.
 * @returns {object}       Values for the SPELL_AUTOMATION_DEFAULTS fields.
 */
export function parseSpellAutomation(system = {}) {
  const result = { ...SPELL_AUTOMATION_DEFAULTS };
  const check = String(system.check ?? "");
  const target = String(system.target ?? "");
  const range = String(system.range ?? "");

  const attack = check.match(new RegExp(String.raw`\bAttack\s+(Int\s*/\s*Cha|${STAT})\b`, "i"));
  if (attack) {
    result.attackStat = attack[1].includes("/") ? "intcha" : STAT_WORDS[attack[1].toLowerCase()];
    const count = check.slice(attack.index + attack[0].length).match(/^\s*(?:\(\s*([1-9]\d*)\s*x\s*\)|([1-9]\d*)\s*x\b)/i);
    if (count) result.attackCount = Number(count[1] ?? count[2]);
  }
  const save = check.match(new RegExp(String.raw`\bTargets?\s+(?:Save\s+(${STAT})\s*([+-]\s*\d+)?|(${STAT})\s+Save)`, "i"));
  if (save) {
    result.saveStat = STAT_WORDS[(save[1] ?? save[3]).toLowerCase()];
    result.saveModifier = save[2] ? Number(save[2].replace(/\s+/g, "")) : 0;
  }

  // Spells on oneself or allies, and "Everything" spells with several sub-options, don't deal damage directly.
  const offensive = !/\b(self|ally|allies|friendly)\b/i.test(target) && !/everything/i.test(system.category ?? "");
  const lines = String(system.effect ?? "").split("\n").map(line => line.trim());
  const skip = /\bif\b|%|beginning|end of|additional|extra|instead|shield|attacks deal|^(-|melee:|ranged:|on enemy|on crit)/i;
  const damageLine = offensive && lines.find(line => /\b(dmg|damage)\b/i.test(line) && new RegExp(DICE).test(line) && !skip.test(line));
  if (damageLine) {
    result.damage = toFormula(damageLine.match(new RegExp(DICE))[0]);
    result.damageType = damageLine.match(DAMAGE_TYPES)?.[1].toLowerCase() ?? "";
    if (result.saveStat && /none when save|not .* when save/i.test(damageLine)) result.saveEffect = "none";
    else if (result.saveStat && /\bhal(f|ved|fed)\b/i.test(damageLine)) result.saveEffect = "half";
  }
  result.conditions = parseSpellConditions(lines, Boolean(result.saveStat), system.duration);
  const healLine = !/everything/i.test(system.category ?? "")
    && lines.find(line => /\bheals?\b/i.test(line) && new RegExp(DICE).test(line) && !/%|beginning|end of|additional|same amount|max health/i.test(line));
  if (healLine) result.heal = toFormula(healLine.slice(healLine.search(/\bheals?\b/i)).match(new RegExp(DICE))[0]);

  let match;
  const plain = range.replace(/,/g, ".");
  if ((match = plain.match(/^([\d.]+)\s*m radius from user/i) ?? plain.match(/^Self \(([\d.]+)\s*m radius\)/i))) {
    Object.assign(result, { areaShape: "circle", areaSize: meters(match[1]), areaOrigin: "self" });
  } else if ((match = plain.match(/^[\d.]+\s*m \(([\d.]+)\s*m radius\)/i))) {
    Object.assign(result, { areaShape: "circle", areaSize: meters(match[1]), areaOrigin: "placed" });
  } else if ((match = plain.match(/^[\d.]+\s*m\s*\(([\d.]+)\s*m\s*[x×]\s*([\d.]+)\s*m\)/i))) {
    Object.assign(result, { areaShape: "rect", areaSize: meters(match[1]), areaWidth: meters(match[2]), areaOrigin: "placed" });
  } else if (/line/i.test(target) && (match = plain.match(/^([\d.]+)\s*m(?: from user)? \(([\d.]+)\s*m width\)/i))) {
    Object.assign(result, { areaShape: "line", areaSize: meters(match[1]), areaWidth: meters(match[2]), areaOrigin: "self" });
  }
  return result;
}

const CONDITION_NAMES = { prone: "Prone", asleep: "Asleep", burn: "Burn", poisoned: "Poisoned", bleed: "Bleed", regenerating: "Regenerating", immobilized: "Immobilized" };

/**
 * Conditions a spell puts on its targets, from clear effect lines only:
 * "Target is knocked prone", "making them fall prone", "Apply 4d4 + (lvl * 2) sleep tokens", "Burn D4",
 * "Target gains Regenerating 2: heals 1d6 + (lvl * 1) at the beginning of the target's turn" (tokens = turns, `heal` = per turn).
 * Conditional lines ("If …", "On beginning of …", "After 1 turn …") and spells with a choice of effects stay manual.
 * `saveNegates`: the line says the condition doesn't happen on a successful save ("none when Save succeeded").
 * @param {string[]} lines  Effect lines.
 * @param {boolean} hasSave  Whether the spell has a target save.
 * @param {string} [duration]  Immobilized falls back to this duration when no token count is written.
 * @returns {{id: string, name: string, formula: string|null, saveNegates: boolean, heal?: string, timed?: boolean}[]}
 */
export function parseSpellConditions(lines, hasSave, duration = "") {
  const found = [];
  if (lines.some(line => /of your choice|pick a card/i.test(line))) return found;
  const add = (id, formula, line, extra = {}) => {
    if (found.some(condition => condition.id === id)) return;
    found.push({ id, name: CONDITION_NAMES[id], formula, saveNegates: hasSave && /\b(none|not \w+) when \w*\s*save/i.test(line), ...extra });
  };
  for (const line of lines) {
    // Regenerating names when it heals ("at the beginning of the target's turn"), so it comes before the conditional-line check.
    const regen = line.match(new RegExp(String.raw`\bRegenerating\s+(\d+)\b[^\n]*?\bheals?\b[^\d]*(${DICE})`, "i"));
    if (regen) { add("regenerating", regen[1], line, { heal: toFormula(regen[2]) }); continue; }
    // Conditional lines, and rule reminders like "Asleep: You cannot act …", are not effects of the cast.
    if (/\bif\b|beginning of|after \d+ turns?/i.test(line) || (/^[A-Z][a-z]+:/.test(line) && !/^On (hit|cast):/i.test(line))) continue;
    const immobilized = line.match(/\bImmobilized(?:\s+(\d+))?\b/i);
    if (immobilized) {
      const formula = immobilized[1]
        ?? String(duration ?? "").match(/^\s*(\d+)\s+turns?\s*$/i)?.[1] ?? null;
      add("immobilized", formula, line, { timed: formula !== null, saveNegates: hasSave });
    }
    if (/\b(knock(?:s|ed)?|falls?)\b[^.]*\bprone\b/i.test(line)) add("prone", null, line);
    const sleep = line.match(new RegExp(String.raw`\bapply\s+(${DICE}|\d+)\s+sleep tokens?\b`, "i"));
    if (sleep) add("asleep", toFormula(sleep[1]), line);
    for (const token of line.matchAll(/\b(Burn|Poisoned|Bleed)\s+(\d*d\d+)\b/gi)) add(token[1].toLowerCase(), token[2].toLowerCase(), line);
  }
  return found;
}

/** Modifier players apply to attacks against a monster or GM-controlled NPC: 10 − Parry. */
export function getParryModifier(parry) {
  return 10 - Math.round(Number(parry ?? 10));
}

/** The automation a cast uses, read live from the spell's own fields (Check, Range, Target, Effect). */
export function getSpellAutomation(system = {}) {
  return parseSpellAutomation(system);
}

/** Short description of what a cast will do, for the spell sheet. */
export function describeSpellAutomation(auto = {}) {
  const parts = [];
  if (auto.attackStat) parts.push(`Attack ${SPELL_ATTACK_STATS[auto.attackStat]}${auto.attackCount > 1 ? ` ×${auto.attackCount}` : ""}${auto.attackModifier ? ` ${auto.attackModifier > 0 ? "+" : ""}${auto.attackModifier}` : ""} vs Parry`);
  if (auto.saveStat) parts.push(`Target ${SPELL_STATS[auto.saveStat]} Save${auto.saveModifier ? ` ${auto.saveModifier > 0 ? "+" : ""}${auto.saveModifier}` : ""}${auto.saveEffect ? ` (${SPELL_SAVE_EFFECTS[auto.saveEffect].toLowerCase()} on save)` : ""}`);
  if (auto.damage) parts.push(`Damage ${auto.damage}${auto.damageType ? ` ${auto.damageType}` : ""}`);
  if (auto.heal) parts.push(`Heal ${auto.heal}`);
  for (const condition of auto.conditions ?? []) parts.push(`${condition.name}${condition.formula ? ` (${condition.formula} tokens${condition.heal ? `, heals ${condition.heal} each turn` : ""})` : ""}${condition.saveNegates ? " unless saved" : ""}`);
  if (auto.areaShape) parts.push(`${["line", "rect"].includes(auto.areaShape) ? `${auto.areaShape === "rect" ? "Rectangle" : "Line"} ${auto.areaSize} m × ${auto.areaWidth} m` : `Circle ${auto.areaSize} m radius`} (${auto.areaShape === "rect" ? "placed" : SPELL_AREA_ORIGINS[auto.areaOrigin]?.toLowerCase()})`);
  return parts.join(" · ");
}

/** Spell attack: roll d20 under the caster's stat plus the target's Parry modifier. */
export function getSpellAttackThreshold(statValue, targetParry, modifier = 0) {
  return Number(statValue) + getParryModifier(targetParry) + Number(modifier ?? 0);
}

/** Roll-under check: natural 1 always succeeds, natural 20 always fails. */
export function rollUnderSucceeds(d20, threshold) {
  return d20 === 1 || (d20 !== 20 && d20 <= threshold);
}

/** Damage a target takes from the spell's damage total after hit and save; PvP (player vs. player character) halves it. */
export function getSpellDamage(total, { hit = true, saved = false, saveEffect = "", pvp = false } = {}) {
  if (!hit) return 0;
  if (saved && saveEffect === "none") return 0;
  let damage = saved && saveEffect === "half" ? Math.floor(total / 2) : total;
  if (pvp) damage = Math.floor(damage / 2);
  return damage;
}

/** Whether the cost text has a variable action or IP part ("X Actions", "X * 8 IP", "3 IP times 4d4"). */
export function getVariableCost(cost = "") {
  const parts = String(cost).split(",").map(part => part.trim());
  const actionPart = parts.find(part => /\b(Actions?|Reactions?)\b/i.test(part)) ?? "";
  const mpPart = parts.find(part => /\b(?:IP|MP|PP)\b/i.test(part)) ?? "";
  return { actions: Boolean(actionPart) && !/^\d/.test(actionPart), mp: Boolean(mpPart) && !/^\d+\s*(?:IP|MP|PP)$/i.test(mpPart) };
}

/** New health value after damage (positive) or healing, kept between min and max. */
export function getHealthAfter(health = {}, amount = 0, kind = "damage") {
  const value = Number(health.value ?? 0);
  const min = Number(health.min ?? 0);
  const max = Number(health.max ?? value);
  return kind === "heal" ? Math.min(max, value + amount) : Math.max(min, value - amount);
}

const escapeHtml = value => String(value ?? "").replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);

/** Display legacy cost units as IP without changing the stored cost text. */
export function formatSpellCost(cost = "") {
  return String(cost ?? "").replace(/\b(?:IP|MP|PP)\b/gi, "IP");
}

/** One-line spell overview for sheets and chat: cost · range · target · check · duration. */
export function getSpellSummary(system = {}) {
  return [formatSpellCost(system.cost), system.range, system.target, system.check, system.duration]
    .map(value => String(value ?? "").trim())
    .filter(Boolean)
    .join(" · ");
}

/**
 * Group spells by element (alphabetically); spells without an element are listed last as "Other".
 * @param {object[]} spells
 * @returns {{element: string, spells: object[]}[]}
 */
export function groupSpellsByElement(spells = []) {
  const groups = new Map();
  for (const spell of spells) {
    const element = String(spell.system?.element ?? "").trim() || "Other";
    if (!groups.has(element)) groups.set(element, []);
    groups.get(element).push(spell);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "Other") - (b === "Other") || a.localeCompare(b))
    .map(([element, list]) => ({ element, spells: list }));
}

/** Chat card body for a cast spell: element/category, summary, effect text and flavour description. */
export function getSpellChatContent(system = {}) {
  const tags = [system.element, system.category].filter(Boolean).map(escapeHtml).join(" · ");
  const summary = getSpellSummary(system);
  const effect = String(system.effect ?? "").trim();
  return [
    tags ? `<p class="spell-tags"><em>${tags}</em></p>` : "",
    summary ? `<p class="spell-summary"><strong>${escapeHtml(summary)}</strong></p>` : "",
    effect ? `<p class="spell-effect">${escapeHtml(effect).replace(/\n/g, "<br>")}</p>` : "",
    system.description ?? ""
  ].join("");
}
