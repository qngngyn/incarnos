/**
 * Talent and race rules read from their Bonus text (system.bonus), like weapon traits:
 * flat stat bonuses ("+1 Parry", "You gain +2m movement") become item passives at import,
 * the rest is read live from the actor's talents and race (save advantage and bonuses, darkvision,
 * Impressive Spectacle, movement multipliers, Abomination's HP instead of IP).
 */

/** Item types whose Bonus text counts: talents (internal type "feature") and races. */
export const BONUS_ITEM_TYPES = ["feature", "race"];

const escapeHtml = text => String(text).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

/** Profile text: the Bonus (rules) first, then the Description. */
export function getTalentSummary(system = {}) {
  const bonus = typeof system.bonus === "string" ? system.bonus.trim() : "";
  const description = typeof system.description === "string" ? system.description : "";
  return [bonus ? `<p class="talent-bonus">${escapeHtml(bonus).replace(/\n/g, "<br>")}</p>` : "", description].filter(Boolean).join("");
}

/** Stat names in Bonus lines -> passive paths (see PASSIVE_STATS). */
const STAT_PATHS = {
  strength: "abilities.str.value", str: "abilities.str.value",
  dexterity: "abilities.dex.value", dex: "abilities.dex.value",
  constitution: "abilities.con.value", con: "abilities.con.value",
  willpower: "abilities.wis.value", wil: "abilities.wis.value",
  perception: "abilities.prc.value", prc: "abilities.prc.value",
  speed: "abilities.spd.value", spd: "abilities.spd.value",
  intelligence: "abilities.int.value", int: "abilities.int.value",
  charisma: "abilities.cha.value", cha: "abilities.cha.value",
  parry: "attributes.parry.value",
  health: "health.max", hp: "health.max",
  incarna: "power.max", ip: "power.max", "incarna points": "power.max",
  power: "power.max", "power points": "power.max", mana: "power.max", mp: "power.max", pp: "power.max",
  "action points": "actionpoints.max", ap: "actionpoints.max"
};

/** Stat names -> ability keys, for save advantage. */
const ABILITY_KEYS = {
  strength: "str", dexterity: "dex", constitution: "con", willpower: "wis", wil: "wis",
  perception: "prc", speed: "spd", intelligence: "int", charisma: "cha"
};

const number = text => Number(String(text).replace(",", "."));

/**
 * Flat stat bonuses in a Bonus text. Only whole lines like "+2 Strength" / "-1 Charisma" and
 * "+2m movement" count, so check bonuses ("+4 in Repairing Checks") stay text.
 * @returns {{stat: string, value: number, text: string}[]}
 */
export function parseTalentPassives(bonus = "") {
  const passives = [];
  for (const raw of String(bonus ?? "").split("\n")) {
    const line = raw.trim().replace(/[.!]$/, "");
    const stat = line.match(/^([+-]\d+)\s+([a-z ]+)$/i);
    const path = stat && STAT_PATHS[stat[2].trim().toLowerCase()];
    if (path) { passives.push({ stat: path, value: Number(stat[1]), text: raw.trim() }); continue; }
    const movement = line.match(/^(?:you\s+gain\s+)?([+-]\d+(?:[.,]\d+)?)\s*m\s+movement$/i);
    if (movement) { passives.push({ stat: "attributes.movement.value", value: number(movement[1]), text: raw.trim() }); continue; }
    // Harpy: "+1 Stat Bonus" leaves the stat open; the player picks it on the Passives tab.
    const open = line.match(/^([+-]\d+)\s+stat\s+bonus$/i);
    if (open) passives.push({ stat: "", value: Number(open[1]), text: `${raw.trim()} (choose the stat)` });
  }
  return passives;
}

const abilityKeys = names => names.split(/\/|,|\band\b/i).map(name => ABILITY_KEYS[name.trim().toLowerCase()]).filter(Boolean);

/**
 * Rules of one Bonus text that need code at roll time.
 * @returns {{saveAdvantage: string[], saveBonus: {keys: string[], value: number}|null, darkvision: number,
 *   spectacle: {margin: number}|null, movementMultiplier: number, hpMagic: boolean}}
 */
export function parseTalentRules(bonus = "") {
  const text = String(bonus ?? "");
  const saves = text.match(/advantage on ([a-z/,\s]+?) saving throws/i)?.[1] ?? "";
  const saveAdvantage = abilityKeys(saves);
  // Dwarf: "+2 on Constitution, Willpower, Charisma, Intelligence Saving Throws" (roll-under: the save target goes up).
  const bonusMatch = text.match(/([+-]\d+) on ([a-z/,\s]+?) saving throws/i);
  const bonusKeys = bonusMatch ? abilityKeys(bonusMatch[2]) : [];
  const saveBonus = bonusKeys.length ? { keys: bonusKeys, value: Number(bonusMatch[1]) } : null;
  // Carayalos "1.5x movementspeed", Centaur "2x movementspeed"; Rambystouma's first factor is its normal-terrain speed.
  const multiplier = text.match(/(\d+(?:[.,]\d+)?)\s*x\s*movement\s*speed/i);
  // Abomination: "You have no IP. Instead gain HP and all spells use HP."
  const hpMagic = /\bno\s+(?:IP|MP|PP|Incarna(?: Points)?|Mana|Power(?: Points)?)\b[\s\S]*spells use HP/i.test(text);
  const vision = text.match(/vision up to (\d+(?:[.,]\d+)?)\s*m in darkness/i);
  // Impressive Spectacle: "If you attack with a one-handed weapon, and you succeed an attack by over 10 (…), your damage is doubled".
  const spectacle = text.match(/one-handed weapon[\s\S]*?succeed an attack by over (\d+)[\s\S]*?damage is doubled/i);
  // Bloody Claws: "Unarmed attacks inflict bleeding status: 2d6 dmg at the beginning of the victim's turn for 3 turns".
  const unarmed = text.match(/unarmed attacks inflict (bleed(?:ing)?|burn(?:ing)?|poison(?:ed)?) status:?\s*(\d*d\d+(?:\s*[+-]\s*\d+)?)\s*dmg[\s\S]*?for (\d+) turns/i);
  const unarmedId = unarmed && { bleed: "bleed", burn: "burn", poison: "poisoned" }[unarmed[1].toLowerCase().replace(/ing$|ed$/, "")];
  return {
    saveAdvantage, saveBonus, darkvision: vision ? number(vision[1]) : 0, spectacle: spectacle ? { margin: Number(spectacle[1]) } : null,
    movementMultiplier: multiplier ? number(multiplier[1]) : 1, hpMagic,
    unarmedCondition: unarmedId ? { id: unarmedId, damage: unarmed[2].replace(/\s+/g, ""), turns: Number(unarmed[3]) } : null
  };
}

/** "Bleed 2d6 for 3 turns" */
export const unarmedConditionLabel = ({ id, damage, turns }) =>
  `${{ bleed: "Bleed", burn: "Burn", poisoned: "Poisoned" }[id] ?? id} ${damage} for ${turns} turns`;

/** Weapons that count as unarmed attacks for talents like Bloody Claws: Unarmed and natural Claws. */
export const isUnarmedWeapon = item => /^(unarmed|claws?)$/i.test(String(item?.name ?? "").trim());

/** Combined live rules of an actor's talents and race, each tagged with the talent or race that gives it. */
export function getTalentRules(items = []) {
  const rules = { saveAdvantage: {}, saveBonus: {}, darkvision: 0, darkvisionSource: "", spectacle: null, movementMultiplier: null, hpMagic: null, unarmedCondition: null };
  for (const item of items ?? []) {
    if (!BONUS_ITEM_TYPES.includes(item?.type)) continue;
    const parsed = parseTalentRules(item.system?.bonus);
    for (const key of parsed.saveAdvantage) rules.saveAdvantage[key] ??= item.name;
    for (const key of parsed.saveBonus?.keys ?? []) {
      const current = rules.saveBonus[key];
      rules.saveBonus[key] = { value: (current?.value ?? 0) + parsed.saveBonus.value, source: current ? `${current.source}, ${item.name}` : item.name };
    }
    if (parsed.movementMultiplier !== 1 && !rules.movementMultiplier) rules.movementMultiplier = { value: parsed.movementMultiplier, source: item.name };
    if (parsed.hpMagic && !rules.hpMagic) rules.hpMagic = { source: item.name };
    if (parsed.darkvision > rules.darkvision) Object.assign(rules, { darkvision: parsed.darkvision, darkvisionSource: item.name });
    if (parsed.spectacle && !rules.spectacle) rules.spectacle = { ...parsed.spectacle, source: item.name };
    if (parsed.unarmedCondition && !rules.unarmedCondition) rules.unarmedCondition = { ...parsed.unarmedCondition, source: item.name };
  }
  return rules;
}

/**
 * Apply the derived-stat rules of talents and race to prepared actor data (IncarnosActor.prepareDerivedData).
 * @param {object} system  Prepared actor system data, changed in place.
 * @param {object} rules   getTalentRules(actor.items).
 * @param {"saves"|"resources"} stage  "saves": save bonuses and the movement multiplier, after the base derivation and
 *   before flat item passives (so +2m movement is not multiplied). "resources": Abomination's IP → HP, after all passives.
 */
export function applyTalentRules(system, rules, stage) {
  if (stage === "saves") {
    for (const [key, { value }] of Object.entries(rules.saveBonus)) {
      const ability = system.abilities?.[key];
      if (ability && Number.isFinite(Number(ability.save))) ability.save = Number(ability.save) + value;
    }
    const movement = system.attributes?.movement;
    if (rules.movementMultiplier && movement && Number.isFinite(Number(movement.value))) movement.value = Number(movement.value) * rules.movementMultiplier.value;
  } else if (stage === "resources" && rules.hpMagic && system.health && system.power) {
    system.health.max = Number(system.health.max) + Math.max(0, Number(system.power.max) || 0);
    system.power.max = 0;
    system.power.value = 0;
  }
}

/** Impressive Spectacle: a one-handed hit whose d20 is at least `margin` under the number it needed (needs 12, rolled 2 → counts, as in its example). */
export function isSpectacle(spectacle, { success, d20, needed, oneHanded }) {
  return Boolean(spectacle && success && oneHanded && needed - d20 >= spectacle.margin);
}

/** Short "In play:" line for the talent sheet. */
export function describeTalent(system = {}) {
  const names = { "abilities.str.value": "Str", "abilities.dex.value": "Dex", "abilities.con.value": "Con", "abilities.wis.value": "Wil",
    "abilities.prc.value": "Prc", "abilities.spd.value": "Spd", "abilities.int.value": "Int", "abilities.cha.value": "Cha",
    "attributes.parry.value": "Parry", "attributes.movement.value": "Movement", "health.max": "Max HP", "power.max": "Max IP", "actionpoints.max": "Max AP" };
  const signed = value => (value < 0 ? `${value}` : `+${value}`);
  const parts = Object.values(system.passives ?? {}).filter(passive => names[passive?.stat] && Number(passive.value))
    .map(passive => `${names[passive.stat]} ${signed(Number(passive.value))}${passive.stat === "attributes.movement.value" ? " m" : ""}`);
  for (const passive of Object.values(system.passives ?? {})) {
    if (passive && !passive.stat && Number(passive.value)) parts.push(`${signed(Number(passive.value))} to a stat you pick on the Passives tab`);
  }
  return [...parts, ...talentRuleLabels(system.bonus)].join(" · ");
}

/** Rules of a Bonus text that Foundry applies by itself (beyond flat stat passives), as short labels. */
export function talentRuleLabels(bonus = "") {
  const rules = parseTalentRules(bonus);
  const saveNames = { str: "Str", dex: "Dex", con: "Con", wis: "Wil", prc: "Prc", spd: "Spd", int: "Int", cha: "Cha" };
  const signed = value => (value < 0 ? `${value}` : `+${value}`);
  const labels = [];
  if (rules.saveAdvantage.length) labels.push(`advantage on ${rules.saveAdvantage.map(key => saveNames[key]).join("/")} saves`);
  if (rules.saveBonus) labels.push(`${signed(rules.saveBonus.value)} on ${rules.saveBonus.keys.map(key => saveNames[key]).join("/")} saves`);
  if (rules.movementMultiplier !== 1) labels.push(`Movement ×${rules.movementMultiplier}`);
  if (rules.hpMagic) labels.push("no IP: Max IP is added to Max HP and spells cost HP");
  if (rules.darkvision) labels.push(`darkvision ${rules.darkvision} m on the token`);
  if (rules.spectacle) labels.push(`one-handed hits rolled ${rules.spectacle.margin}+ under the target number deal double damage`);
  if (rules.unarmedCondition) labels.push(`unarmed hits: ${unarmedConditionLabel(rules.unarmedCondition)}`);
  return labels;
}

/** The Bonus text without its flat stat lines ("+1 Parry"): what still matters in play beyond the stat passives. */
export function talentRuleText(bonus = "") {
  return String(bonus ?? "").split("\n").map(line => line.trim())
    .filter(line => line && !parseTalentPassives(line).length).join("\n");
}

/** A rule cut to its gist for tooltips: the first line and sentence, at most 60 characters. */
export function shortRule(text = "", max = 60) {
  const first = String(text ?? "").trim().split("\n")[0].split(/(?<=[.!])\s/)[0].replace(/[.!]$/, "").trim();
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

/**
 * Everything a talent or race does beyond its flat stat passives, as short labels: what Foundry applies
 * ("Movement ×2"), or else the gist of the Bonus for the table. Gives every talent or race with a Bonus a passive.
 * @returns {{label: string, applied: boolean}[]}
 */
export function talentRulePassives(bonus = "") {
  const applied = talentRuleLabels(bonus).map(label => ({ label, applied: true }));
  if (applied.length) return applied;
  const text = talentRuleText(bonus);
  return text ? [{ label: shortRule(text), applied: false }] : [];
}

/**
 * Give an actor's token the darkvision of its talents (Nightvision: "Vision up to 9m in Darkness").
 * The token's own sight is remembered in flags.incarnos.talentVision and restored when the talent goes.
 * @param {Actor} actor
 */
export async function syncTalentVision(actor) {
  if (!actor) return;
  const { darkvision } = getTalentRules(actor.items);
  const remembered = actor.getFlag("incarnos", "talentVision");
  const tokenDoc = actor.isToken ? actor.token : null;
  const sight = (tokenDoc ?? actor.prototypeToken).sight;
  let next;
  if (darkvision) {
    if (remembered?.range === darkvision && sight.visionMode === "darkvision" && sight.range === darkvision) return;
    next = { enabled: true, range: darkvision, visionMode: "darkvision" };
    await actor.update({ "flags.incarnos.talentVision": { previous: remembered?.previous ?? { range: sight.range, visionMode: sight.visionMode }, range: darkvision } });
  } else if (remembered) {
    next = { range: remembered.previous?.range ?? 0, visionMode: remembered.previous?.visionMode ?? "basic" };
    await actor.update({ "flags.incarnos.-=talentVision": null });
  } else return;

  if (tokenDoc) return tokenDoc.update({ sight: next });
  await actor.update({ prototypeToken: { sight: next } });
  // Tokens of this actor already on scenes (linked or not) follow the prototype.
  for (const scene of game.scenes) {
    const tokens = scene.tokens.filter(token => token.actorId === actor.id);
    if (tokens.length) await scene.updateEmbeddedDocuments("Token", tokens.map(token => ({ _id: token.id, sight: next })));
  }
}

/**
 * Keep token darkvision in step with the actor's talents and race, and keep one race per actor
 * (adding a race replaces the old one). Runs for the user who changed the item.
 */
export function registerTalentHooks() {
  const sync = (item, userId) => {
    if (!BONUS_ITEM_TYPES.includes(item.type) || item.parent?.documentName !== "Actor" || userId !== game.user.id) return;
    syncTalentVision(item.parent).catch(error => console.error("Incarnos | talent vision", error));
  };
  // Runs before the new race exists, so only races the actor already had are removed (not others created in the same drop).
  Hooks.on("preCreateItem", (item, data, options, userId) => {
    if (item.type !== "race" || item.parent?.documentName !== "Actor" || userId !== game.user.id) return;
    const old = item.parent.items.filter(other => other.type === "race").map(other => other.id);
    if (old.length) item.parent.deleteEmbeddedDocuments("Item", old).catch(error => console.error("Incarnos | replace race", error));
  });
  Hooks.on("createItem", (item, options, userId) => sync(item, userId));
  Hooks.on("updateItem", (item, change, options, userId) => { if ("system" in change || "name" in change) sync(item, userId); });
  Hooks.on("deleteItem", (item, options, userId) => sync(item, userId));
}
