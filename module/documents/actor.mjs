import { getItemPassiveModifiers, applyItemPassiveModifiers } from "../helpers/passives.mjs";
import { applyTalentRules, getTalentRules } from "../helpers/talents.mjs";

/** Parry bonus of the Shadowform condition. */
export const SHADOWFORM_PARRY = 3;

/**
 * Extend the base Actor document by defining a custom roll data structure which is ideal for the Simple system.
 * @extends {Actor}
 */
export class IncarnosActor extends Actor {
  /**
   * @override
   * Augment the basic actor data with additional dynamic data. Typically,
   * you'll want to handle most of your calculated/derived data in this step.
   * Data calculated in this step should generally not exist in template.json
   * (such as ability modifiers rather than ability scores) and should be
   * available both inside and outside of character sheets (such as if an actor
   * is queried and has a roll executed directly from it).
   */
  prepareDerivedData() {
    const modifiers = getItemPassiveModifiers(this.items);
    // Foundry resets prepared data from the source before each preparation cycle.
    applyItemPassiveModifiers(this.system, modifiers, true);
    if (this.type === "character") {
      for (const ability of Object.values(this.system.abilities)) {
        ability.value = Number(ability.value) + Number(ability.bonus ?? 0);
      }
    }
    this._prepareCharacterData(this);
    this._prepareNpcData(this);
    // Race and talent rules: save bonuses (Dwarf), movement multipliers (Centaur), IP → HP (Abomination).
    const talentRules = getTalentRules(this.items);
    applyTalentRules(this.system, talentRules, "saves");
    applyItemPassiveModifiers(this.system, modifiers, false);
    applyTalentRules(this.system, talentRules, "resources");
    // Shadowform: +3 Parry while it lasts.
    if (this.statuses?.has("shadowform") && this.system.attributes?.parry) {
      this.system.attributes.parry.value = Number(this.system.attributes.parry.value ?? 0) + SHADOWFORM_PARRY;
    }
  }

  /**
   * Prepare Character type specific data
   */
  _prepareCharacterData(actorData) {
    if (actorData.type !== 'character') return;

    // Make modifications to data here. For example:
    const systemData = actorData.system;
    const abilityScore = systemData.abilities;
    const attributeScore = systemData.attributes;

    // Set Max HP and Incarna 
    const healthbonus = systemData.health.bonus 
    systemData.health.max = 2*abilityScore.con.value + abilityScore.str.value + healthbonus
    // system.power holds Incarna (IP); keep this legacy data path for existing worlds.
    const powerbonus = systemData.power.bonus
    systemData.power.max = 2*abilityScore.wis.value + abilityScore.int.value + powerbonus

    // Set Parry
    const parrybonus = attributeScore.parry.bonus
    attributeScore.parry.value = Math.floor((2*abilityScore.prc.value + abilityScore.dex.value)/3) + parrybonus

    // Set Movementspeed
    const movementbonus = attributeScore.movement.bonus
    attributeScore.movement.value = ((abilityScore.spd.value/2)*1.5) + movementbonus

    // Loop through ability scores, and add their modifiers to our sheet output
    for (let [key, ability] of Object.entries(abilityScore)) {
      // Calculate the saving throw value for its correspondant ability score
      if (key == "str" || key == "dex" || key == "spd" || key == "con") {
        ability.save = Math.floor((ability.value*2 + abilityScore.con.value)/3)
      }
      if (key == "int" || key == "prc" || key == "wis" || key == "cha") {
        ability.save = Math.floor((ability.value*2 + abilityScore.wis.value)/3)
      }
    }
  }

  /**
   * Prepare NPC type specific data.
   */
  _prepareNpcData(actorData) {
    if (actorData.type !== 'npc') return;

     // Make modifications to data here. For example:
     const systemData = actorData.system;
     const abilityScore = systemData.abilities;
 
     // Loop through ability scores, and add their modifiers to our sheet output.
     for (let [key, ability] of Object.entries(abilityScore)) {
      // Calculate the saving throw value for its correspondant ability score.
      if (key == "str" || key == "dex" || key == "spd" || key == "con") {
        ability.save = Math.floor((ability.value*2 + abilityScore.con.value)/3)
      }
      if (key == "int" || key == "prc" || key == "wis" || key == "cha") {
        ability.save = Math.floor((ability.value*2 + abilityScore.wis.value)/3)
      }
    }
  }

  /**
   * Override getRollData() that's supplied to rolls.
   */
  getRollData() {
    const data = super.getRollData();

    // Prepare character roll data.
    this._getCharacterRollData(data);
    this._getNpcRollData(data);

    return data;
  }

  /**
   * Prepare character roll data.
   */
  _getCharacterRollData(data) {
    if (this.type !== 'character') return;

    // Copy the ability scores to the top level, so that rolls can use
    // formulas like `@str.mod + 4`.
    if (data.abilities) {
      for (let [k, v] of Object.entries(data.abilities)) {
        data[k] = foundry.utils.deepClone(v);
      }
    }

    // Add level for easier access, or fall back to 0.
    if (data.attributes.level) {
      data.lvl = data.attributes.level.value ?? 0;
    }
  }

  /**
   * Prepare NPC roll data.
   */
  _getNpcRollData(data) {
    if (this.type !== 'npc') return;

    // Process additional NPC data here.
  }

}