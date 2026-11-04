export const INCARNOS = {};

/**
 * The set of Ability Scores used within the sytem.
 * @type {Object}
 */

 INCARNOS.abilities = {
  "str": "INCARNOS.AbilityStr",
  "dex": "INCARNOS.AbilityDex",
  "con": "INCARNOS.AbilityCon",
  "int": "INCARNOS.AbilityInt",
  "wis": "INCARNOS.AbilityWis",
  "prc": "INCARNOS.AbilityPrc",
  "spd": "INCARNOS.AbilitySpd",
  "cha": "INCARNOS.AbilityCha"
};

INCARNOS.abilityAbbreviations = {
  "str": "INCARNOS.AbilityStrAbbr",
  "dex": "INCARNOS.AbilityDexAbbr",
  "con": "INCARNOS.AbilityConAbbr",
  "int": "INCARNOS.AbilityIntAbbr",
  "wis": "INCARNOS.AbilityWisAbbr",
  "prc": "INCARNOS.AbilityPrcAbbr",
  "spd": "INCARNOS.AbilitySpdAbbr",
  "cha": "INCARNOS.AbilityChaAbbr"
};
/**
 * Weapon attack modes.
 * A weapon with system.versatile = true may use both modes.
 * A weapon without an attackMode is treated as melee for backwards compatibility.
 */
INCARNOS.weaponModes = {
  melee: "Melee",
  ranged: "Ranged"
};

/**
 * System-wide attack action definitions.
 *
 * Add new attack actions here instead of storing the rules on every weapon item.
 * The roll implementation in module/documents/item.mjs reads these definitions.
 *
 * Important fields:
 * - id: stable ID used in dialogs and code
 * - name: player-facing name
 * - cost: AP cost
 * - modes: ["melee"], ["ranged"], or ["melee", "ranged"]
 * - statByMode: default stat for melee/ranged weapon attacks
 * - statChoices: optional list for attacks where the player chooses a stat, such as Weave
 * - roll.advantageDelta: +1 means 2d20 keep lowest, -1 means 2d20 keep highest
 * - roll.allowAdvantage: false means player advantage is ignored
 * - parry.apply: false means target parry modifier is ignored
 * - damage.multiplier: multiplier applied to the weapon's damage formula
 * - damage.formula: fixed damage formula that replaces weapon damage
 * - multiTarget: true means comma-separated parry modifiers are treated as multiple targets
 */
INCARNOS.attackActions = {
  normal: {
    id: "normal",
    name: "Attack: Normal",
    cost: 1,
    modes: ["melee", "ranged"],
    statByMode: { melee: "str", ranged: "dex" },
    roll: { advantageDelta: 0, allowAdvantage: true },
    parry: { apply: true },
    damage: { multiplier: 1 },
    notes: ["On success, deal normal weapon damage."]
  },
  weave: {
    id: "weave",
    name: "Attack: Weave",
    cost: 1,
    modes: ["melee", "ranged"],
    statChoices: ["int", "cha"],
    roll: { advantageDelta: 0, allowAdvantage: true },
    parry: { apply: true },
    damage: { formula: "1d8" },
    notes: ["Choose Int or Cha. On success, deal 1d8 damage."]
  },
  precision: {
    id: "precision",
    name: "Attack: Precision",
    cost: 1,
    modes: ["melee", "ranged"],
    statByMode: { melee: "str", ranged: "dex" },
    roll: { advantageDelta: 1, allowAdvantage: true },
    parry: { apply: true },
    damage: { multiplier: 0.5 },
    notes: ["Roll 2d20 and keep the lowest result. On success, deal half weapon damage."]
  },
  fury: {
    id: "fury",
    name: "Attack: Fury",
    cost: 1,
    modes: ["melee", "ranged"],
    statByMode: { melee: "str", ranged: "dex" },
    roll: { advantageDelta: -1, allowAdvantage: true },
    parry: { apply: true },
    damage: { multiplier: 2 },
    notes: ["Roll 2d20 and keep the highest result. On success, deal double weapon damage."]
  },
  relentless: {
    id: "relentless",
    name: "Attack: Relentless",
    cost: 1,
    modes: ["melee", "ranged"],
    statByMode: { melee: "str", ranged: "dex" },
    roll: { advantageDelta: 1, allowAdvantage: true },
    parry: { apply: true },
    damage: { multiplier: 1 },
    notes: ["Roll 2d20 and keep the lowest result.", "Until your next turn, you have disadvantage on Parry rolls."]
  },
  crazed: {
    id: "crazed",
    name: "Attack: Crazed",
    cost: 1,
    modes: ["melee", "ranged"],
    statByMode: { melee: "str", ranged: "dex" },
    roll: { advantageDelta: 0, allowAdvantage: true },
    parry: { apply: true },
    damage: { multiplier: 3, selfDamage: true },
    notes: ["On success, deal triple weapon damage.", "You take the same amount of damage yourself."]
  },
  cleave: {
    id: "cleave",
    name: "Attack: Cleave",
    cost: 1,
    modes: ["melee"],
    statByMode: { melee: "str" },
    roll: { advantageDelta: 0, allowAdvantage: true },
    parry: { apply: true },
    damage: { multiplier: 0.5 },
    multiTarget: true,
    notes: ["Melee only.", "Use comma-separated parry modifiers to roll once per target.", "Each successful hit deals half weapon damage."]
  },
  bypass: {
    id: "bypass",
    name: "Attack: Bypass",
    cost: 1,
    modes: ["melee", "ranged"],
    statByMode: { melee: "str", ranged: "dex" },
    roll: { advantageDelta: 0, allowAdvantage: false },
    parry: { apply: false },
    damage: { multiplier: 0.5 },
    notes: ["Ignore the target's Parry modifier.", "This attack cannot benefit from advantage.", "On success, deal half weapon damage."]
  }
};
