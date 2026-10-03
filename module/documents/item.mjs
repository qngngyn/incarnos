/**
 * Extend the basic Item with Incarnos-specific roll behavior.
 * @extends {Item}
 */
export class IncarnosItem extends Item {
  /** @inheritDoc */
  prepareData() {
    super.prepareData();
  }

  /**
   * Prepare data for rolls made by this Item.
   * @returns {object|null}
   */
  getRollData() {
    if (!this.actor) return null;

    const rollData = this.actor.getRollData();
    rollData.item = foundry.utils.deepClone(this.system);
    return rollData;
  }

  /**
   * Handle item rolls.
   * @returns {Promise<Roll|void>}
   */
  async roll() {
    const item = this;
    const speaker = ChatMessage.getSpeaker({ actor: this.actor });
    const rollMode = game.settings.get("core", "messageMode");
    const label = `<b>${item.name}</b><br><i>${item.system.description ?? ""}</i>`;

    const damageFormula = getWeaponDamageFormula(item);

    if (!damageFormula) {
      await ChatMessage.create({
        speaker,
        rollMode,
        flavor: label,
        content: item.system.description ?? ""
      });
      return;
    }

    if (this.type !== "weapon") {
      const rollData = this.getRollData() ?? { item: foundry.utils.deepClone(this.system) };

      await new Roll("1d20").toMessage({
        speaker,
        rollMode,
        flavor: label
      });

      const roll = new Roll(damageFormula, rollData);
      await roll.toMessage({
        speaker,
        rollMode,
        flavor: "Damage"
      });
      return roll;
    }

    const rollData = this.getRollData();
    if (!rollData) {
      return ui.notifications.warn("Weapon attacks must be rolled from an owned item on an actor.");
    }

    const form = await promptWeaponAttack(item, rollData);
    if (!form) return;

    return rollWeaponAttackAction({
      item,
      rollData,
      speaker,
      rollMode,
      flavor: label,
      attackId: form.attackId,
      mode: form.mode,
      stat: form.stat,
      advantageType: form.advantageType,
      advantageCount: form.advantageCount,
      // Players enter the signed modifier announced by the GM; the roll adds target Parry to the die.
      parryModifiers: form.enemyParryModifiers.map(modifier => -modifier)
    });
  }
}

/**
 * Return the weapon's effective attack modes.
 * A missing attackMode is treated as melee so old weapons continue to work.
 * A versatile weapon can attack in both melee and ranged modes.
 *
 * @param {Item} item
 * @returns {string[]}
 */
export function getWeaponAttackModes(item) {
  const configuredMode = item?.system?.attackMode || "melee";
  const baseMode = CONFIG.INCARNOS?.weaponModes?.[configuredMode] ? configuredMode : "melee";
  return item?.system?.versatile ? ["melee", "ranged"] : [baseMode];
}

/**
 * Return the attack actions that are available for a weapon.
 *
 * @param {Item} item
 * @returns {object[]}
 */
export function getAvailableAttackActions(item) {
  const weaponModes = getWeaponAttackModes(item);
  const configuredActions = CONFIG.INCARNOS?.attackActions ?? {};
  const weaveAction = configuredActions.weave;

  const attackActions =
    item.name === "Attack: Weave"
      ? weaveAction
        ? [weaveAction]
        : []
      : Object.entries(configuredActions)
          .filter(([key]) => key !== "weave")
          .map(([, action]) => action);

  return attackActions.filter(action =>
    action.modes?.some(mode => weaponModes.includes(mode))
  );
}

/**
 * Roll one system-wide attack action using weapon-specific data.
 * This is the main function to extend later when you add more attack types.
 *
 * @param {object} params
 * @param {Item} params.item                         The weapon item being rolled.
 * @param {object} params.rollData                   Actor/item roll data.
 * @param {object} params.speaker                    Chat speaker data.
 * @param {string} params.rollMode                   Foundry roll mode.
 * @param {string} params.flavor                     Base chat flavor.
 * @param {string} params.attackId                   ID from CONFIG.INCARNOS.attackActions.
 * @param {"melee"|"ranged"} params.mode            Whether this attack is used as melee or ranged.
 * @param {string|null} params.stat                  Optional stat choice for attacks such as Weave.
 * @param {"Normal"|"Advantage"|"Disadvantage"} params.advantageType
 * @param {number} params.advantageCount
 * @param {number[]} params.parryModifiers           One or more target parry modifiers.
 * @returns {Promise<Roll[]|void>}
 */
export async function rollWeaponAttackAction({
  item,
  rollData,
  speaker,
  rollMode,
  flavor,
  attackId,
  mode,
  advantageType = "Normal",
  advantageCount = 0,
  parryModifiers = [0]
} = {}) {
  const attack = CONFIG.INCARNOS?.attackActions?.[attackId];
  if (!attack) return ui.notifications.warn(`Unknown attack action: ${attackId}`);

  const allowedWeaponModes = getWeaponAttackModes(item);
  if (!allowedWeaponModes.includes(mode)) {
    return ui.notifications.warn(`${item.name} cannot be used as a ${mode} weapon.`);
  }

  if (!attack.modes.includes(mode)) {
    return ui.notifications.warn(`${attack.name} cannot be used with ${mode} attacks.`);
  }

  const selectedStat = resolveAttackStat(attack, mode, rollData);
  if (!selectedStat) {
    return ui.notifications.warn(`${attack.name} needs a valid attack stat.`);
  }

  const targetParryModifiers = (attack.multiTarget ? parryModifiers : [parryModifiers[0] ?? 0]).map(Number);
  const abilityValue = getAbilityValue(rollData, selectedStat);
  const weaponModifier = Number(item.system?.modifier ?? 0);
  const hitFormula = calculateHitFormula(advantageType, advantageCount, attack.roll?.advantageDelta ?? 0, attack.roll?.allowAdvantage !== false);
  const damageFormula = getAttackDamageFormula(item, attack);

  const rolls = [];
  const resultLines = [];

  for (let i = 0; i < targetParryModifiers.length; i++) {
    const parryModifier = attack.parry?.apply === false ? 0 : Number(targetParryModifiers[i] ?? 0);
    const hitRoll = await new Roll(hitFormula, rollData).evaluate({ async: true });
    rolls.push(hitRoll);

    const keptD20 = getKeptD20Result(hitRoll);
    const criticalSuccess = hasKeptD20Result(hitRoll, 1);
    const criticalFailure = hasKeptD20Result(hitRoll, 20);
    const modifiedRoll = keptD20 + parryModifier;
    const threshold = abilityValue + weaponModifier;
    const success = criticalSuccess || (!criticalFailure && modifiedRoll <= threshold);
    
    let damageRoll = null;
    if (success && damageFormula) {
      damageRoll = await new Roll(damageFormula, rollData).evaluate({ async: true });
      rolls.push(damageRoll);
    }
    const rollDifference = threshold - modifiedRoll;
    resultLines.push(getOutcomeText(success, criticalSuccess, criticalFailure, rollDifference));
  }

  function getOutcomeText(success, criticalSuccess, criticalFailure, rollDifference) {
    const outcome = success ? 
    criticalSuccess ? "Critical Success!" :"Success" : 
    criticalSuccess ? "Critical Failure!" : "Failure";
    const sign = rollDifference >= 0 ? '+' : '';
    return `<br><b>Result:</b> ${outcome} by ${sign}${rollDifference}`
  }

  const modeLabel = CONFIG.INCARNOS?.weaponModes?.[mode] ?? mode;
  const notes = attack.notes?.length ? `<br><b>Notes:</b><ul>${attack.notes.map(note => `<li>${note}</li>`).join("")}</ul>` : "";
  const enemyParryModifierText = attack.parry?.apply === false ? "Ignored" : targetParryModifiers.map(modifier => formatSignedNumber(-modifier)).join(", ");
  const advantageText = attack.roll?.allowAdvantage === false ? "None; this attack cannot benefit from advantage" : `${advantageCount}x ${advantageType}`;

  const text = `<br><b>${attack.name}</b>
    <br><b>Attack:</b> ${modeLabel}${formatSignedNumber(weaponModifier)} (${selectedStat})
    <br><b>Enemy Parry modifier:</b> ${enemyParryModifierText}
    <hr>${resultLines.join("<hr>")}
    `;

  const chatData = {
    user: game.user.id,
    speaker,
    flavor: flavor + text,
    content: "",
    rolls: rolls.map(roll => roll.toJSON()),
    style: CONST.CHAT_MESSAGE_STYLES.ROLL,
    sound: CONFIG.sounds.dice
  };

  ChatMessage.applyMode(chatData, rollMode);
  await ChatMessage.create(chatData);

  return rolls;
}

/**
 * Show the attack prompt and collect parameters required by rollWeaponAttackAction.
 *
 * @param {Item} item
 * @returns {Promise<object|null>}
 */
async function promptWeaponAttack(item, rollData) {
  const attacks = getAvailableAttackActions(item);
  if (!attacks.length) {
    ui.notifications.warn(`${item.name} has no available attack actions.`);
    return null;
  }

  const weaponModes = getWeaponAttackModes(item);
  const attackOptions = attacks.map(attack => `<option value="${attack.id}">${attack.name}</option>`).join("");
  const modeOptions = weaponModes.map(mode => `<option value="${mode}">${CONFIG.INCARNOS.weaponModes[mode] ?? mode}</option>`).join("");
  const hasOnlyOneMode = weaponModes.length === 1;
  const advantageOptions = ["Normal", "Advantage", "Disadvantage"].map(type => `<option value="${type}">${type}</option>`).join("");
  const modifier = Number(item.system?.modifier ?? 0);

  const form = await foundry.applications.api.DialogV2.prompt({
    window: { title: "Choose your attack" },
    content: `
      <fieldset>
        <legend>Attack action</legend>
        <div class="form-group">
          <label>Type of attack</label>
          <select name="attackId">${attackOptions}</select>
        </div>
        <div class="form-group">
          <label>Use weapon as</label>
          <select name="mode" ${hasOnlyOneMode ? "disabled" : ""}>
            ${modeOptions}
          </select>
        </div>
        <div class="form-group">
          <label>Weapon Modifier</label>
          <input type="number" value="${modifier}" readonly />
        </div>
        <div class="form-group">
          <label>Enemy Parry Modifier</label>
          <input name="enemyParryModifiers" type="text" value="0" placeholder="e.g. -6"/>
          <p class="hint">Enter the modifier exactly as the GM announces it: -6 makes the attack harder, +6 makes it easier. For Cleave, separate each target modifier with a comma. Bypass ignores this modifier.</p>
        </div>
        <div class="form-group">
          <label>Advantage</label>
          <select name="advantageType">${advantageOptions}</select>
          <input name="advantageCount" type="number" value="0" min="0" step="1"/>
        </div>
      </fieldset>
      <div class="form-group">
        <label>Final roll</label>
        <output name="rollPreview" aria-live="polite" style="font-weight: bold; text-align: right; white-space: pre-line;"></output>
      </div>`,

    ok: {
      label: "Roll",
      callback: (event, button) => ({
        attackId: button.form.elements.attackId.value,
        mode: button.form.elements.mode.value,
        enemyParryModifiers: parseNumberList(button.form.elements.enemyParryModifiers.value),
        advantageType: button.form.elements.advantageType.value,
        advantageCount: Number(button.form.elements.advantageCount.value || 0)
      })
    },

    render: (event, dialog) => {
      const select = dialog.element.querySelector('[name="advantageType"]');
      const input = dialog.element.querySelector('[name="advantageCount"]');

      if (!select || !input) return;

      const updateAdvantageCount = () => {
        const isNormal = select.value.toLowerCase() === "normal";

        input.disabled = isNormal;
        input.placeholder = isNormal ? "0" : "1";

        if (isNormal) input.value = 0;
        if (!isNormal) input.value = 1;
      };

      const element = dialog.element;
      const preview = element.querySelector('[name="rollPreview"]');
      const updatePreview = () => {
        if (!preview) return;
        preview.textContent = getWeaponAttackPreview(item, rollData, {
          attackId: element.querySelector('[name="attackId"]').value,
          mode: element.querySelector('[name="mode"]').value,
          enemyParryModifiers: parseNumberList(element.querySelector('[name="enemyParryModifiers"]').value),
          advantageType: select.value,
          advantageCount: Number(input.value || 0)
        });
      };

      select.addEventListener("change", updateAdvantageCount);
      element.addEventListener("input", updatePreview);
      element.addEventListener("change", updatePreview);
      updateAdvantageCount();
      updatePreview();
    },

    rejectClose: false,
    modal: false
  });

  return form;
}

/** Describe the pending roll without rolling dice or changing actor/item data. */
function getWeaponAttackPreview(item, rollData, { attackId, mode, enemyParryModifiers, advantageType, advantageCount }) {
  const attack = CONFIG.INCARNOS.attackActions[attackId];
  if (!attack || !attack.modes.includes(mode)) return "This attack cannot be used in the selected weapon mode.";

  const stat = resolveAttackStat(attack, mode, rollData);
  if (!stat) return "This attack needs a valid attack stat.";

  const ability = getAbilityValue(rollData, stat);
  const weaponModifier = Number(item.system?.modifier ?? 0);
  const formula = calculateHitFormula(advantageType, advantageCount, attack.roll?.advantageDelta ?? 0, attack.roll?.allowAdvantage !== false);
  const modifiers = attack.multiTarget ? enemyParryModifiers : [enemyParryModifiers[0] ?? 0];
  const lines = modifiers.map(modifier => {
    const enemyModifier = attack.parry?.apply === false ? 0 : modifier;
    const target = ability + weaponModifier + enemyModifier;
    return `${formula} ≤ ${target}`;
  });
  return lines.join("\n");
}
function resolveAttackStat(attack, mode, rollData) {
  const int = getAbilityValue(rollData, "int");  
  const cha = getAbilityValue(rollData, "cha");
  if (attack.id === "weave") {
    return int > cha ? "int" : "cha";
  }
  
  return attack.statByMode?.[mode] ?? null;
}

function getAbilityValue(rollData, stat) {
  return Number(foundry.utils.getProperty(rollData, `abilities.${stat}.value`) ?? foundry.utils.getProperty(rollData, `${stat}.value`) ?? 0);
}

function getWeaponDamageFormula(item) {
  return item.system?.damage || item.system?.formula || null;
}

function getAttackDamageFormula(item, attack) {
  if (attack.damage?.formula) return attack.damage.formula;

  const baseDamage = getWeaponDamageFormula(item);
  if (!baseDamage) return null;

  const multiplier = Number(attack.damage?.multiplier ?? 1);
  if (multiplier === 1) return baseDamage;
  return `(${baseDamage}) * ${multiplier}`;
}

function calculateHitFormula(advantageType, advantageCount, actionAdvantageDelta = 0, allowAdvantage = true) {
  let adjustment = Number(actionAdvantageDelta ?? 0);

  if (allowAdvantage) {
    const count = Math.max(0, Number(advantageCount ?? 0));
    if (advantageType === "Advantage") adjustment += count;
    else if (advantageType === "Disadvantage") adjustment -= count;
  }

  const diceCount = Math.abs(adjustment) + 1;
  if (adjustment > 0) return `${diceCount}d20kl`;
  if (adjustment < 0) return `${diceCount}d20kh`;
  return "1d20";
}

function getKeptD20Result(roll) {
  const die = roll.dice.find(d => d.faces === 20);
  const results = die?.results ?? [];
  const active = results.filter(result => result.active !== false && result.discarded !== true);
  const result = active.at(-1) ?? results.at(-1);
  return Number(result?.result ?? roll.total ?? 0);
}

function hasKeptD20Result(roll, value) {
  const die = roll.dice.find(d => d.faces === 20);
  const results = die?.results ?? [];
  const active = results.filter(result => result.active !== false && result.discarded !== true);
  return active.some(result => Number(result.result) === value);
}

function parseNumberList(value) {
  const parsed = String(value ?? "0")
    .split(",")
    .map(part => Number(part.trim()))
    .filter(number => Number.isFinite(number));
  return parsed.length ? parsed : [0];
}

function formatSignedNumber(number) {
  const value = Number(number ?? 0);
  return value >= 0 ? `+${value}` : `${value}`;
}
