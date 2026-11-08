import { waitForContestAnimations } from "../helpers/contest-requests.mjs";
import { castSpell } from "../helpers/spell-cast.mjs";
import { payActions } from "../helpers/action-tracker.mjs";
import { getTraitDamageFormula, getTraitHit, getWeaponRules, parseWeaponTraits } from "../helpers/weapons.mjs";
import { getTalentRules, getTalentSummary, isSpectacle, isUnarmedWeapon, unarmedConditionLabel } from "../helpers/talents.mjs";
import { isPlayerSide, isPvpHit, modifierForRoller } from "../helpers/modifiers.mjs";
import { conditionAdvantage, consumeHindered, parseAttackConditions, shadowcloneCheck } from "../helpers/conditions.mjs";
import {
  amount as cardAmount, applyAllButton, applyButton, checkChip, chip as cardChip, criticalFailureButton, escape as escapeCard, renderRollCard, rollingChip
} from "../helpers/roll-card.mjs";
import { hasCriticalFailure } from "../helpers/critical-failure-rules.mjs";

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
    const label = `<b>${item.name}</b>${item.system.description ? `<br><i>${item.system.description}</i>` : ""}`;

    // Spells pay their cost, resolve attacks/saves/damage and post a card with Apply buttons for the GM.
    if (item.type === "spell") return castSpell(item);

    const damageFormula = getWeaponDamageFormula(item);
    const typeLabel = { feature: "Talent", race: "Race", weapon: "Weapon" }[item.type] ?? "Item";
    // Talents and races show their Bonus above the description.
    const text = ["feature", "race"].includes(item.type) ? getTalentSummary(item.system) : item.system.description ?? "";
    const itemCard = rows => renderRollCard({
      img: item.img, title: escapeCard(item.name), tags: typeLabel, rows,
      details: { summary: `${typeLabel} text`, html: text, open: !rows.length }
    });

    if (!damageFormula) {
      await ChatMessage.create({ speaker, rollMode, content: itemCard([]) });
      return;
    }

    if (this.type !== "weapon") {
      const rollData = this.getRollData() ?? { item: foundry.utils.deepClone(this.system) };
      const d20 = await new Roll("1d20").evaluate();
      const roll = await new Roll(damageFormula, rollData).evaluate();
      const row = pending => [{
        img: this.actor?.img, name: this.actor?.name ?? item.name,
        chips: pending ? [rollingChip()] : [cardChip("d20", { tone: "note", small: String(d20.total) })],
        values: pending ? [] : [cardAmount(roll.total, { kind: "damage", title: `${roll.formula}: ${roll.result}` })]
      }];
      const chatData = { speaker, content: itemCard(row(true)), rolls: [d20.toJSON(), roll.toJSON()], sound: CONFIG.sounds.dice };
      ChatMessage.applyMode(chatData, rollMode);
      const message = await ChatMessage.create(chatData);
      if (message) {
        await waitForContestAnimations([message.id]);
        await message.update({ content: itemCard(row(false)) });
      }
      return roll;
    }

    const rollData = this.getRollData();
    if (!rollData) {
      return ui.notifications.warn("Weapon attacks must be rolled from an owned item on an actor.");
    }

    const form = await promptWeaponAttack(item, rollData);
    if (!form) return;

    const attackRolls = await rollWeaponAttackAction({
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
      twoHanded: form.twoHanded,
      // Players enter the signed modifier announced by the GM; the roll adds target Parry to the die.
      parryModifiers: form.enemyParryModifiers.map(modifier => -modifier)
    });
    // Hindered lasts for one attack.
    if (attackRolls) await consumeHindered(item.actor);
    return attackRolls;
  }
}

/**
 * Return the weapon's effective attack modes.
 * A missing attackMode is treated as melee so old weapons continue to work.
 * A versatile weapon can attack in both modes, with its configured mode first; Throwable makes a melee weapon versatile.
 *
 * @param {Item} item
 * @returns {string[]}
 */
export function getWeaponAttackModes(item) {
  const configuredMode = item?.system?.attackMode || "melee";
  const baseMode = CONFIG.INCARNOS?.weaponModes?.[configuredMode] ? configuredMode : "melee";
  const versatile = item?.system?.versatile || Boolean(getWeaponRules(item?.system).throwable);
  return versatile ? [baseMode, baseMode === "melee" ? "ranged" : "melee"] : [baseMode];
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
  parryModifiers = [0],
  twoHanded = false
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

  const rules = getWeaponRules(item.system);
  const talents = getTalentRules(item.actor?.items);
  const selectedStat = resolveAttackStat(attack, mode, rollData, rules);
  if (!selectedStat) {
    return ui.notifications.warn(`${attack.name} needs a valid attack stat.`);
  }

  const useTwoHands = Boolean(twoHanded && rules.twoHand);
  const targetParryModifiers = (attack.multiTarget ? parryModifiers : [parryModifiers[0] ?? 0]).map(Number);
  const abilityValue = getAbilityValue(rollData, selectedStat);
  // Two-Hand: −2 hitrate and the trait's damage die. A monster's weapon modifier is written for the heroes
  // ("Melee -2" = −2 for heroes), so the monster itself rolls with the opposite sign.
  const weaponModifier = modifierForRoller(item.system?.modifier, item.actor) - (useTwoHands ? 2 : 0);
  const hitFormula = calculateHitFormula(advantageType, advantageCount, attack.roll?.advantageDelta ?? 0, attack.roll?.allowAdvantage !== false);
  const damageFormula = getAttackDamageFormula(item, attack, rules);

  const rolls = [];
  const results = [];
  // Targeted tokens name the rows and allow Apply when there is one per attack roll.
  const targets = [...(game.user?.targets ?? [])];
  const tokenFor = index => (targets.length === targetParryModifiers.length ? targets[index] : null);

  if (!targetParryModifiers.length) return;
  const paidActions = await payActions(item.actor, attack.cost ?? 1, attack.name);
  if (paidActions === false) return;

  for (let i = 0; i < targetParryModifiers.length; i++) {
    const parryModifier = attack.parry?.apply === false ? 0 : Number(targetParryModifiers[i] ?? 0);
    const hitRoll = await new Roll(hitFormula, rollData).evaluate({ async: true });
    rolls.push(hitRoll);

    const keptD20 = getKeptD20Result(hitRoll);
    const threshold = abilityValue + weaponModifier;
    // d20 + modifier ≤ threshold is the same as d20 ≤ threshold − modifier: show what the die needed.
    const needed = threshold - parryModifier;
    const traitHit = getTraitHit(keptD20, needed, rules);
    // Shadowclone: on a d20 of 9 or lower the clone is attacked instead; the target takes nothing from this attack.
    const token = tokenFor(i);
    const cloneCheck = await shadowcloneCheck(token?.actor, async formula => {
      const cloneRoll = await new Roll(formula).evaluate();
      rolls.push(cloneRoll);
      return cloneRoll;
    });
    const clone = cloneCheck ? { d20: cloneCheck.d20, diverted: cloneCheck.diverted } : null;
    const success = traitHit.success && !clone?.diverted;
    const crit = traitHit.crit && !clone?.diverted;

    // Impressive Spectacle (talent): a one-handed hit rolled far enough under the target number doubles the damage.
    const spectacle = isSpectacle(talents.spectacle, { success, d20: keptD20, needed, oneHanded: !useTwoHands && Number(item.system?.hands ?? 1) <= 1 });
    let damageRoll = null;
    if (success && damageFormula) {
      const formula = getTraitDamageFormula(damageFormula, rules, { crit, twoHanded: useTwoHands });
      // Crits max the damage dice (after Deadly/Fatal changed them).
      damageRoll = await new Roll(spectacle ? `(${formula}) * 2` : formula, rollData).evaluate({ maximize: crit });
      rolls.push(damageRoll);
    }
    // Conditions in the weapon's traits ("Burn D4", "Prone") come with a hit; token dice are rolled now.
    const conditions = [];
    for (const { id, name, dice, timed } of success ? parseAttackConditions(item.system?.traits) : []) {
      const tokenRoll = dice ? await new Roll(dice).evaluate() : null;
      if (tokenRoll) rolls.push(tokenRoll);
      conditions.push({ id, name, ...(tokenRoll ? { tokens: tokenRoll.total } : {}), ...(timed !== undefined ? { timed } : {}) });
    }
    // Bloody Claws (talent): unarmed hits put a condition that rolls its damage each turn, tokens = turns.
    const unarmed = talents.unarmedCondition && isUnarmedWeapon(item) ? talents.unarmedCondition : null;
    if (success && unarmed) conditions.push({ id: unarmed.id, name: unarmedConditionLabel(unarmed), tokens: unarmed.turns, damage: unarmed.damage, label: true });
    // PvP rules, as for spells: a player's attack hitting another player character deals half damage.
    const pvp = isPvpHit(item.actor, token?.actor) && Boolean(damageRoll);
    results.push({
      name: token?.name ?? (targetParryModifiers.length > 1 ? `Target ${i + 1}` : "Target"),
      img: token?.document?.texture?.src, uuid: token?.actor?.uuid,
      check: { d20: keptD20, threshold: needed, success, crit },
      parryModifier, success, crit, damageRoll, pvp, damage: pvp ? Math.floor(damageRoll.total / 2) : damageRoll?.total ?? 0,
      spectacle: spectacle && damageRoll ? talents.spectacle : null,
      conditions, clone
    });
  }
  // Attack: Crazed: the attacker takes the same damage it dealt, as its own row with Apply (and Apply all).
  const selfDamage = attack.damage?.selfDamage ? results.reduce((sum, result) => sum + (result.damage || 0), 0) : 0;
  if (selfDamage) {
    results.push({ name: `${item.actor?.name ?? "Attacker"} (self)`, img: item.actor?.img, uuid: item.actor?.uuid,
      self: true, success: true, damage: selfDamage, damageRoll: null, conditions: [] });
  }

  const statLabel = selectedStat.charAt(0).toUpperCase() + selectedStat.slice(1);
  const advantageDice = /^(\d+)d20k([lh])$/.exec(hitFormula);
  const card = pending => renderWeaponAttackCard({
    item, attack, mode, statLabel, abilityValue, weaponModifier, advantageDice, results, pending, rules, twoHanded: useTwoHands, paidActions,
    criticalFailureLabel: game.i18n?.localize("INCARNOS.CriticalFailure.title")
  });
  const chatData = {
    user: game.user.id,
    speaker,
    content: card(true),
    rolls: rolls.map(roll => roll.toJSON()),
    style: CONST.CHAT_MESSAGE_STYLES.ROLL,
    sound: CONFIG.sounds.dice,
    flags: { incarnos: { ...(hasCriticalFailure(results) ? { criticalFailureAttack: { actorUuid: item.actor.uuid, kind: attackId === "weave" ? "spell" : "weapon" } } : {}), spellCast: { itemName: item.name, targets: results.map(({ name, uuid, damage, conditions }) =>
      ({ name, uuid, damage, heal: 0, conditions, appliedDamage: false, appliedHeal: false })) } } }
  };

  ChatMessage.applyMode(chatData, rollMode);
  const message = await ChatMessage.create(chatData);
  if (message) {
    await waitForContestAnimations([message.id]);
    await message.update({ content: card(false) });
  }

  return rolls;
}

/** "Bloody Claws: Bleed 2d6 for 3 turns" when a talent upgrades this unarmed attack. */
function upgradedBy(item) {
  const unarmed = isUnarmedWeapon(item) ? getTalentRules(item.actor?.items).unarmedCondition : null;
  return unarmed ? `${unarmed.source}: ${unarmedConditionLabel(unarmed)}` : "";
}

/** Weapon attack chat card on the shared roll card layout. */
export function renderWeaponAttackCard({ item, attack, mode, statLabel, abilityValue, weaponModifier, advantageDice, results, pending = false, rules = getWeaponRules(item.system), twoHanded = false, criticalFailureLabel, paidActions = 0 }) {
  const advantage = advantageDice
    ? `${advantageDice[2] === "l" ? "Advantage" : "Disadvantage"} ${formatSignedNumber((Number(advantageDice[1]) - 1) * (advantageDice[2] === "l" ? 1 : -1))}`
    : "";
  // A monster's weapon shows the modifier as written for the heroes next to what the monster rolls with.
  const forHeroes = item.actor && !isPlayerSide(item.actor) ? ` (${formatSignedNumber(Number(item.system?.modifier ?? 0))} for heroes)` : "";
  const facts = [paidActions ? game.i18n.format("INCARNOS.Actions.paid", { cost: paidActions }) : "",
    `Weapon ${formatSignedNumber(weaponModifier)}${forHeroes}`, twoHanded ? "Two-handed" : "", advantage,
    attack.parry?.apply === false ? "Ignores Parry" : "", rules.poorPrecision ? "Poor Precision" : "", upgradedBy(item)]
    .filter(Boolean).map(escapeCard).join(" · ");
  const rows = results.map((result, index) => {
    if (pending) return { img: result.img, name: result.name, chips: [rollingChip()] };
    if (result.self) {
      return { img: result.img, name: result.name, chips: [cardChip("Crazed", { tone: "bad", title: "Attack: Crazed: you take the same damage yourself" })],
        values: [cardAmount(result.damage, { kind: "damage", title: `${result.damage} damage to yourself (Crazed)` })
          + (result.uuid ? applyButton("damage", index, result.damage) : "")] };
    }
    const modifierText = attack.parry?.apply === false ? "" : ` ${formatSignedNumber(-result.parryModifier)} attack modifier`;
    const values = result.damage
      ? [cardAmount(result.damage, { kind: "damage", title: `${result.damage} damage (${result.damageRoll.formula}: ${result.damageRoll.result})` })
        + (result.uuid ? applyButton("damage", index, result.damage) : "")]
      : [`<span class="isc-amount isc-none">${result.success ? "—" : "no effect"}</span>`];
    return {
      img: result.img, name: result.name, dim: !result.success, values,
      chips: [checkChip(result.check, { pass: "Hit", fail: "Miss", label: `${statLabel} ${abilityValue} ${formatSignedNumber(weaponModifier)} weapon${modifierText}` }),
        result.spectacle ? cardChip("×2", { tone: "crit", title: `${result.spectacle.source}: one-handed hit rolled ${result.spectacle.margin}+ under the target number, damage doubled` }) : "",
        result.pvp ? cardChip("PvP ½", { title: "PvP rules: damage halved" }) : "",
        result.clone ? cardChip(result.clone.diverted ? "Clone hit" : "Clone missed", { tone: result.clone.diverted ? "good" : "note",
          title: `Shadowclone: d20 ${result.clone.d20} (${result.clone.diverted ? "9 or lower: the clone takes the attack" : "above 9: the attack goes to the target"})` }) : "",
        ...(result.conditions ?? []).map(condition => cardChip(condition.label ? condition.name : `${condition.name}${condition.tokens ? ` ${condition.tokens}` : ""}`, {
          tone: "note", title: `${condition.name}${condition.tokens && !condition.label ? ` (${condition.tokens} tokens)` : ""}: applied to the target together with the damage (Apply)` }))]
    };
  });
  const damaged = pending ? [] : results.filter(result => result.damageRoll);
  const notes = damaged.map(result => `<span title="${escapeCard(result.damageRoll.formula)}${result.crit ? " (crit: damage dice maxed)" : ""}"><i class="fas fa-dice"></i> ${damaged.length > 1 ? `${escapeCard(result.name)}: ` : ""}Damage ${escapeCard(result.damageRoll.result)}${result.pvp ? ` = ${result.damageRoll.total}, PvP halved` : ""} = <b>${result.damage}</b>${result.crit ? " · crit, max dice" : ""}</span>`)
    .concat((attack.notes ?? []).map(note => `<span>${note}</span>`));
  const applicable = pending ? 0 : results.filter(result => result.damage && result.uuid).length;
  return renderRollCard({
    img: item.img, title: escapeCard(item.name),
    tags: escapeCard([attack.name, CONFIG.INCARNOS?.weaponModes?.[mode] ?? mode].filter(Boolean).join(" · ")),
    chip: cardChip(`${statLabel} ${abilityValue}`, { tone: "info", title: `Attack stat (${statLabel})` }),
    facts, rows, notes,
    action: (applicable > 1 ? applyAllButton() : "") + (!pending && hasCriticalFailure(results) ? criticalFailureButton(criticalFailureLabel) : ""),
    details: { summary: "Traits", html: weaponTraitsHtml(item.system) }
  });
}

/** Trait list (name bold, description) plus the weapon's description, for the card's folded text. */
function weaponTraitsHtml(system = {}) {
  const traits = parseWeaponTraits(system.traits);
  const list = traits.length
    ? `<ul class="isc-traits">${traits.map(trait => `<li><b>${escapeCard([trait.name, trait.value].filter(Boolean).join(" "))}</b>${trait.text ? `: ${escapeCard(trait.text)}` : ""}</li>`).join("")}</ul>`
    : "";
  return list + (system.description ?? "");
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
  const attackOptions = attacks.map(attack => `<option value="${attack.id}">${attack.name} (${game.i18n.format("INCARNOS.Actions.paid", { cost: attack.cost ?? 1 })})</option>`).join("");
  const modeOptions = weaponModes.map(mode => `<option value="${mode}">${CONFIG.INCARNOS.weaponModes[mode] ?? mode}</option>`).join("");
  const hasOnlyOneMode = weaponModes.length === 1;
  // Conditions preselect advantage: Hidden gives advantage, Hindered disadvantage.
  const conditionAdv = conditionAdvantage(item.actor?.statuses ?? new Set(), "attack");
  const defaultAdvantage = conditionAdv.delta > 0 ? "Advantage" : conditionAdv.delta < 0 ? "Disadvantage" : "Normal";
  const advantageOptions = ["Normal", "Advantage", "Disadvantage"].map(type => `<option value="${type}"${type === defaultAdvantage ? " selected" : ""}>${type}</option>`).join("");
  const modifier = Number(item.system?.modifier ?? 0);
  const twoHand = getWeaponRules(item.system).twoHand;
  const twoHandField = twoHand ? `
        <div class="form-group">
          <label>Two-handed</label>
          <input name="twoHanded" type="checkbox"/>
          <p class="hint">−2 hitrate, damage die d${twoHand}</p>
        </div>` : "";

  const form = await foundry.applications.api.DialogV2.prompt({
    window: { title: "Choose your attack" },
    content: `
      <fieldset>
        <legend>Attack action</legend>
        <p class="hint">${game.i18n.localize("INCARNOS.Actions.attackCost")}</p>
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
          <label>${isPlayerSide(item.actor) ? "Weapon" : "Weapon (for heroes)"}</label>
          <input type="text" value="${formatSignedNumber(modifier)}" readonly />
        </div>${twoHandField}
        <div class="form-group">
          <label>Attack Modifier</label>
          <input name="enemyParryModifiers" type="text" value="0" placeholder="e.g. -6"/>
        </div>
        <div class="form-group">
          <label>Advantage</label>
          <select name="advantageType">${advantageOptions}</select>
          <input name="advantageCount" type="number" value="${Math.abs(conditionAdv.delta)}" min="0" step="1"/>
          ${conditionAdv.sources.length ? `<p class="hint">From conditions: ${conditionAdv.sources.join(", ")}</p>` : ""}
        </div>
      </fieldset>
      <output name="rollPreview" aria-label="Final roll" aria-live="polite" style="display: inline-block; flex: 0 1 auto; align-self: center; padding: 3px 8px; border-radius: 4px; background: var(--color-bg-option); font-size: 0.85em; font-weight: bold; white-space: pre-line;"></output>`,

    ok: {
      label: "Roll",
      callback: (event, button) => ({
        attackId: button.form.elements.attackId.value,
        mode: button.form.elements.mode.value,
        enemyParryModifiers: parseNumberList(button.form.elements.enemyParryModifiers.value),
        advantageType: button.form.elements.advantageType.value,
        advantageCount: Number(button.form.elements.advantageCount.value || 0),
        twoHanded: Boolean(button.form.elements.twoHanded?.checked)
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
      for (const field of element.querySelectorAll('input[type="text"], input[type="number"]')) {
        if (field.readOnly) continue;
        field.addEventListener("focus", () => {
          if (!field.disabled) field.select();
        });
        field.addEventListener("pointerdown", event => {
          if (event.button !== 0 || field.disabled || field.ownerDocument.activeElement === field) return;
          // Preserve the full selection on the first click; later clicks can place the caret.
          event.preventDefault();
          field.focus();
          field.select();
        });
      }
      const preview = element.querySelector('[name="rollPreview"]');
      const rollButton = element.querySelector('[data-action="ok"]');
      if (preview && rollButton) {
        rollButton.after(preview);
        rollButton.style.flex = "0 0 calc(66.666% - var(--dialog-button-gap, 8px) / 3)";
        preview.style.flex = "1 1 0";
        preview.style.minWidth = "0";
      }
      const updatePreview = () => {
        if (!preview) return;
        preview.textContent = getWeaponAttackPreview(item, rollData, {
          attackId: element.querySelector('[name="attackId"]').value,
          mode: element.querySelector('[name="mode"]').value,
          enemyParryModifiers: parseNumberList(element.querySelector('[name="enemyParryModifiers"]').value),
          advantageType: select.value,
          advantageCount: Number(input.value || 0),
          twoHanded: Boolean(element.querySelector('[name="twoHanded"]')?.checked)
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
function getWeaponAttackPreview(item, rollData, { attackId, mode, enemyParryModifiers, advantageType, advantageCount, twoHanded = false }) {
  const attack = CONFIG.INCARNOS.attackActions[attackId];
  if (!attack || !attack.modes.includes(mode)) return "This attack cannot be used in the selected weapon mode.";

  const stat = resolveAttackStat(attack, mode, rollData, getWeaponRules(item.system));
  if (!stat) return "This attack needs a valid attack stat.";

  const ability = getAbilityValue(rollData, stat);
  const weaponModifier = modifierForRoller(item.system?.modifier, item.actor) - (twoHanded && getWeaponRules(item.system).twoHand ? 2 : 0);
  const formula = calculateHitFormula(advantageType, advantageCount, attack.roll?.advantageDelta ?? 0, attack.roll?.allowAdvantage !== false);
  const modifiers = attack.multiTarget ? enemyParryModifiers : [enemyParryModifiers[0] ?? 0];
  const lines = modifiers.map(modifier => {
    const enemyModifier = attack.parry?.apply === false ? 0 : modifier;
    const target = ability + weaponModifier + enemyModifier;
    return `${formula} ≤ ${target}`;
  });
  return lines.join("\n");
}
function resolveAttackStat(attack, mode, rollData, rules = {}) {
  const int = getAbilityValue(rollData, "int");
  const cha = getAbilityValue(rollData, "cha");
  if (attack.id === "weave") {
    return int > cha ? "int" : "cha";
  }
  const stat = attack.statByMode?.[mode] ?? null;
  // Finesse: melee attacks may use Dexterity instead of Strength; take the better one.
  if (rules.finesse && mode === "melee" && stat === "str" && getAbilityValue(rollData, "dex") > getAbilityValue(rollData, "str")) return "dex";
  return stat;
}

function getAbilityValue(rollData, stat) {
  return Number(foundry.utils.getProperty(rollData, `abilities.${stat}.value`) ?? foundry.utils.getProperty(rollData, `${stat}.value`) ?? 0);
}

function getWeaponDamageFormula(item) {
  return item.system?.damage || item.system?.formula || null;
}

function getAttackDamageFormula(item, attack, rules = {}) {
  if (attack.damage?.formula) return attack.damage.formula;

  const baseDamage = getWeaponDamageFormula(item);
  if (!baseDamage) return null;

  // Sweep: Attack: Cleave deals full damage.
  const multiplier = attack.id === "cleave" && rules.sweep ? 1 : Number(attack.damage?.multiplier ?? 1);
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


function parseNumberList(value) {
  const parsed = String(value ?? "0")
    .split(",")
    .map(part => Number(part.trim()))
    .filter(number => Number.isFinite(number));
  return parsed.length ? parsed : [0];
}

export function formatSignedNumber(number) {
  const value = Number(number ?? 0);
  return value >= 0 ? `+${value}` : `${value}`;
}
