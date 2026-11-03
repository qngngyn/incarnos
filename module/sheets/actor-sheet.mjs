import { ACTIONS, actionLabel, actionTooltip } from "../data/actions.mjs";
import { useCombatAction } from "../helpers/combat-actions.mjs";
import { changeActions, actorParticipatesInCombat } from "../helpers/action-tracker.mjs";
import { CONTEST_STATS, getContestDefender, requestDefenderContest, getContestDie, renderNewContestBoard, rollBoardSide, showContestDialog, waitForContestAnimations } from "../helpers/contest-requests.mjs";
import { renderCheckCard } from "../helpers/roll-card.mjs";
import { getTalentRules, getTalentSummary } from "../helpers/talents.mjs";
import { getParryModifier, getSpellSummary, groupSpellsByElement } from "../helpers/spells.mjs";
import { PASSIVE_STATS } from "../helpers/passives.mjs";
import { itemSyncStatus } from "../helpers/item-sync.mjs";
import { formatSignedNumber } from "../documents/item.mjs";
import { advantageFormula, conditionAdvantage, proneParry, hasDodge, consumeDodge } from "../helpers/conditions.mjs";
import { onManageActiveEffect, prepareActiveEffectCategories } from "../helpers/effects.mjs";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ActorSheetV2 } = foundry.applications.sheets;
const TextEditor = foundry.applications.ux.TextEditor.implementation;

/**
 * Incarnos Actor Sheet using the Foundry VTT ApplicationV2 sheet framework.
 * @extends {ActorSheetV2}
 */
export class IncarnosActorSheet extends HandlebarsApplicationMixin(ActorSheetV2) {

  /** Display only the actor type in the window header. */
  get title() {
    const type = this.actor.type;
    const key = `TYPES.Actor.${type}`;
    const label = game.i18n.localize(key);
    return label !== key ? label : type.charAt(0).toUpperCase() + type.slice(1);
  }

  /** @inheritDoc */
  static DEFAULT_OPTIONS = {
    classes: ["incarnos", "sheet", "actor"],
    tag: "form",
    position: {
      width: 600,
      height: 700
    },
    window: {
      resizable: true
    },
    form: {
      closeOnSubmit: false,
      submitOnChange: true
    },
    actions: {
      roll: IncarnosActorSheet.#onRoll,
      spendAction: function () { return changeActions(this.actor, "spend"); },
      restoreAction: function () { return changeActions(this.actor, "restore"); },
      resetActions: function () { return changeActions(this.actor, "reset"); },
      combatAction: function (event, target) { event.preventDefault(); return useCombatAction(this.actor, target.dataset.combatAction); },
      contestRoll: IncarnosActorSheet.#onContestRoll,
      editImage: IncarnosActorSheet.#onEditImage,
      itemCreate: IncarnosActorSheet.#onItemCreate,
      itemEdit: IncarnosActorSheet.#onItemEdit,
      itemDelete: IncarnosActorSheet.#onItemDelete,
      effectCreate: IncarnosActorSheet.#onEffectControl,
      effectEdit: IncarnosActorSheet.#onEffectControl,
      effectDelete: IncarnosActorSheet.#onEffectControl,
      effectToggle: IncarnosActorSheet.#onEffectControl
    }
  };

  /** @inheritDoc */
  static TABS = {
    primary: {
      initial: "features",
      tabs: [
        { id: "features", group: "primary", label: "Profile" },
        { id: "description", group: "primary", label: "Notes" },
        { id: "items", group: "primary", label: "Items" },
        { id: "spells", group: "primary", label: "Spells" },
        { id: "effects", group: "primary", label: "Effects" }
      ]
    }
  };

  /** @inheritDoc */
  static PARTS = {
    form: {
      template: "systems/incarnos/templates/actor/actor-character-sheet.html"
    }
  };

  /** @inheritDoc */
  _configureRenderParts(options) {
    return {
      form: {
        template: `systems/incarnos/templates/actor/actor-${this.actor.type}-sheet.html`
      }
    };
  }

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const actor = this.actor;
    const actorData = actor.toObject(false);

    context.actor = actor;
    context.actionGroups = ["contest", "misc"].map(kind => ({
      label: game.i18n.localize(`INCARNOS.Actions.${kind}`),
      actions: ACTIONS.filter(action => action.kind === kind).map(action => ({ id: action.id, label: actionLabel(action), tooltip: actionTooltip(action) }))
    }));
    context.showActionTracker = actorParticipatesInCombat(actor);
    context.system = actorData.system;
    // Remember the displayed total and its underlying base for safe form edits.
    const sourceSystem = actor.toObject().system;
    this._displayedStatValues = {};
    for (const path of Object.keys(PASSIVE_STATS)) {
      if (!path.startsWith("abilities.") && path !== "actionpoints.max" && actor.type !== "npc") continue;
      let displayed = foundry.utils.getProperty(context.system, path);
      const base = foundry.utils.getProperty(sourceSystem, path);
      // The NPC parry input uses numberFormat with zero decimal places.
      if (path === "attributes.parry.value") displayed = Math.round(Number(displayed));
      if (Number.isFinite(Number(displayed)) && Number.isFinite(Number(base))) {
        this._displayedStatValues[path] = { displayed: Number(displayed), base: Number(base) };
      }
    }
    context.flags = actorData.flags;
    context.items = actorData.items ?? [];
    context.effects = prepareActiveEffectCategories(actor.effects, actor.items);
    context.tabs = this._prepareTabs("primary");
    context.rollData = actor.getRollData();
    context.owner = actor.isOwner;
    context.editable = this.isEditable;
    context.cssClass = this.options.classes.join(" ");

    if (actor.type === "character") {
      this._prepareItems(context);
      this._prepareCharacterData(context);
    }

    if (actor.type === "npc") {
      this._prepareItems(context);
      this._prepareNpcData(context);
      // Players apply this to attacks against the NPC (10 − Parry).
      context.parryModifier = formatSignedNumber(getParryModifier(actor.system.attributes?.parry?.value));
    }

    await Promise.all((context.talents ?? []).map(async talent => {
      talent.descriptionHTML = await TextEditor.enrichHTML(talent.talentSummary, {
        secrets: actor.isOwner,
        relativeTo: actor.items.get?.(talent._id) ?? actor,
        rollData: context.rollData
      });
    }));

    context.biographyHTML = await TextEditor.enrichHTML(context.system.biography ?? "", {
      secrets: actor.isOwner,
      relativeTo: actor,
      rollData: context.rollData
    });

    return context;
  }

  /** Preserve stored base stats when the form submits displayed effective totals. */
  _processFormData(event, form, formData) {
    const data = super._processFormData(event, form, formData);
    for (const [path, { displayed, base }] of Object.entries(this._displayedStatValues ?? {})) {
      const field = `system.${path}`;
      const value = foundry.utils.getProperty(data, field);
      if (value === undefined || value === null || value === "" || !Number.isFinite(Number(value))) continue;
      // An unchanged total saves the original base. Editing a total changes only the base.
      foundry.utils.setProperty(data, field, base + Number(value) - displayed);
    }
    return data;
  }

  /** @inheritDoc */
  async _onRender(context, options) {
    await super._onRender(context, options);

    const fields = 'input:not([type]), input[type="text"], input[type="number"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input[type="password"], textarea';
    for (const input of this.element.querySelectorAll(fields)) {
      if (input.disabled || input.readOnly) continue;
      input.addEventListener("focus", () => input.select());
      input.addEventListener("pointerdown", event => {
        if (event.button !== 0 || input.ownerDocument.activeElement === input) return;
        // Keep the initial click from collapsing the selection after focus.
        event.preventDefault();
        input.focus();
        input.select();
      });
    }
  }

  /**
   * Prepare Character type specific sheet data.
   * @param {object} context
   */
  _prepareCharacterData(context) {
    for (const [key, ability] of Object.entries(context.system.abilities)) {
      ability.label = game.i18n.localize(CONFIG.INCARNOS.abilities[key]) ?? key;
    }
  }

  /**
   * Prepare NPC type specific sheet data.
   * @param {object} context
   */
  _prepareNpcData(context) {
    for (const [key, ability] of Object.entries(context.system.abilities)) {
      ability.label = game.i18n.localize(CONFIG.INCARNOS.abilities[key]) ?? key;
    }
  }

  /**
   * Organize and classify Items for actor sheets.
   * @param {object} context
   */
  _prepareItems(context) {
    const gear = [];
    const talents = [];
    const spells = [];

    for (const item of context.items) {
      item.syncCustomized = itemSyncStatus(item)?.customized ?? false;
      item.img = item.img || CONST.DEFAULT_TOKEN;

      if (item.type === "weapon") {
        item.attackRoll = formatSignedNumber(item.system?.modifier);
      }

      if ((item.type === "item") || (item.type === "weapon")) {
        gear.push(item);
      }
      else if (item.type === "feature" || item.type === "race") {
        item.talentSummary = getTalentSummary(item.system);
        item.isRace = item.type === "race";
        talents.push(item);
      }
      else if (item.type === "spell") {
        item.spellSummary = getSpellSummary(item.system);
        spells.push(item);
      }
    }

    context.gear = gear;
    context.talents = talents.sort((a, b) => Number(b.isRace) - Number(a.isRace));
    context.spells = groupSpellsByElement(spells);
  }

  /**
   * Create a new embedded Item.
   * @this {IncarnosActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onItemCreate(event, target) {
    event.preventDefault();

    const type = target.dataset.type;
    const system = foundry.utils.deepClone(target.dataset);
    delete system.type;

    const name = type === "feature" ? "New Talent" : `New ${type.charAt(0).toUpperCase()}${type.slice(1)}`;
    const itemData = { name, type, system };

    return this.actor.createEmbeddedDocuments("Item", [itemData]);
  }

  /**
   * Open an embedded Item sheet.
   * @this {IncarnosActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onItemEdit(event, target) {
    event.preventDefault();

    const itemId = target.closest("[data-item-id]")?.dataset.itemId;
    const item = this.actor.items.get(itemId);
    item?.sheet.render({ force: true });
  }

  /**
   * Delete an embedded Item.
   * @this {IncarnosActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onItemDelete(event, target) {
    event.preventDefault();

    const itemId = target.closest("[data-item-id]")?.dataset.itemId;
    const item = this.actor.items.get(itemId);
    if (!item) return;

    await item.delete();
    this.render({ force: true });
  }

  /**
   * Manage Active Effects from sheet controls.
   * @this {IncarnosActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static #onEffectControl(event, target) {
    event.preventDefault();

    const action = target.dataset.action.replace(/^effect/, "").toLowerCase();
    target.dataset.effectAction = action;
    return onManageActiveEffect(event, this.actor, target);
  }

  /**
   * Handle clickable rolls.
   * @this {IncarnosActorSheet}
   * @param {PointerEvent} event
   * @param {HTMLElement} target
   */
  static async #onRoll(event, target) {
    event.preventDefault();
    const dataset = target.dataset;

    if (dataset.rollType) {
      if (["item", "weapon", "spell"].includes(dataset.rollType)) {
        const itemId = target.closest("[data-item-id]")?.dataset.itemId;
        const item = this.actor.items.get(itemId);
        if (item) return item.roll();
      }
    }

    if (dataset.roll) {
      const speaker = ChatMessage.getSpeaker({ actor: this.actor });
      const rollMode = game.settings.get("core", "rollMode");
      // Talents such as Cold-Hearted give advantage on some saves: roll 2d20, keep the lower.
      const talentRules = getTalentRules(this.actor.items);
      const advantageSource = dataset.check === "save" ? talentRules.saveAdvantage[dataset.stat] : null;
      // Race save bonuses (Dwarf) are already in ability.save; the card names them.
      const saveBonus = dataset.check === "save" ? talentRules.saveBonus[dataset.stat] ?? null : null;
      // Conditions on Parry: Hidden gives advantage. Prone (disadvantage against melee, advantage against ranged)
      // rolls enough dice to show both cases instead of asking.
      const statuses = this.actor.statuses ?? new Set();
      const proneParryRoll = dataset.check === "parry" && statuses.has("prone");
      const dodging = dataset.check === "parry" && hasDodge(this.actor);
      const conditionAdv = dataset.check === "parry" ? conditionAdvantage(statuses, "parry", null, { dodge: dodging }) : { delta: 0, sources: [] };
      const advantageDelta = (advantageSource ? 1 : 0) + conditionAdv.delta;
      const advantageSources = [advantageSource, ...conditionAdv.sources].filter(Boolean).join(", ");
      const formula = proneParryRoll ? `${conditionAdv.delta + 2}d20` : advantageDelta ? advantageFormula(advantageDelta) : dataset.roll;
      const roll = await new Roll(formula, this.actor.getRollData()).evaluate();
      if (dodging) await consumeDodge(this.actor);
      const parryCases = proneParryRoll ? proneParry(roll.dice[0].results.map(result => result.result), conditionAdv.delta) : null;
      const ability = this.actor.system.abilities?.[dataset.stat];
      const value = dataset.check === "parry" ? Number(this.actor.system.attributes?.parry?.value)
        : dataset.check === "save" ? Number(ability?.save) : Number(ability?.value);
      // Roll-under checks get the shared card; anything else keeps Foundry's plain roll message.
      if (!dataset.check || !Number.isFinite(value)) {
        await roll.toMessage({ speaker, flavor: dataset.label ?? "", rollMode });
        return roll;
      }
      const card = pending => renderCheckCard({
        roller: { name: this.actor.name, img: this.actor.img }, kind: dataset.check,
        statLabel: game.i18n.localize(CONFIG.INCARNOS.abilities[dataset.stat] ?? dataset.stat ?? ""),
        value: Math.round(value), d20: parryCases ? parryCases.melee : roll.total, pending,
        advantage: advantageDelta ? { source: advantageSources, dice: roll.dice[0]?.results.map(result => result.result) ?? [], low: advantageDelta > 0 } : null,
        bonus: saveBonus,
        cases: parryCases ? [{ label: "vs melee", d20: parryCases.melee }, { label: "vs ranged", d20: parryCases.ranged }] : null,
        casesTag: parryCases ? `Prone${conditionAdv.sources.length ? `, ${conditionAdv.sources.join(", ")}` : ""}` : ""
      });
      const chatData = { speaker, content: card(true), rolls: [roll.toJSON()], sound: CONFIG.sounds.dice };
      ChatMessage.applyMode(chatData, rollMode);
      const message = await ChatMessage.create(chatData);
      if (message) {
        await waitForContestAnimations([message.id]);
        await message.update({ content: card(false) });
      }
      return roll;
    }
  }

  /**
   * Handle the contest-roll prompt.
   * @this {IncarnosActorSheet}
   * @param {PointerEvent} event
   */
  static async #onContestRoll(event, target) {
    event.preventDefault();

    const speaker = ChatMessage.getSpeaker({ actor: this.actor });
    const abilities = this.actor.system.abilities;
    const options = ["Strength", "Dexterity", "Constitution", "Willpower", "Perception", "Speed", "Intelligence", "Charisma"]
      .map(stat => `<option value="${stat}">${stat}</option>`)
      .join("");
    const contestType = target?.dataset.contestType === "save" ? "Save" : "Attack";
    const noTarget = contestType === "Attack" && !(game.user?.targets?.size);
    if (noTarget) {
      const rollAnyway = await showContestDialog("confirm", {
        window: { title: "No contest target selected" },
        content: "<p>A target is required to request a defender's contest roll. No token is currently targeted.</p><p>Do you want to roll this contest anyway, without prompting a defender?</p>",
        yes: { label: "Roll anyway" },
        no: { label: "Cancel" },
        rejectClose: false,
        modal: true
      });
      if (!rollAnyway) return;
    }
    const defender = contestType === "Attack" && !noTarget ? getContestDefender(this.actor) : null;

    const result = await showContestDialog("prompt", {
      window: { title: `Choose your ${contestType.toLowerCase()} contest stat` },
      content: `
        <fieldset>
          <legend>Stats</legend>
          <div class="form-group">
            <label>Stat</label>
            <select name="stat">${options}</select>
          </div>
        </fieldset>`,
      ok: {
        label: "Roll!",
        callback: (event, button) => 
          ({
            type: contestType,
            stat: button.form.elements.stat.value
          })
      },
      rejectClose: false,
      modal: true
    });

    if (!result) return;

    // One board shows both sides of the contest and is updated as each side rolls.
    const role = result.type === "Attack" ? "attack" : "save";
    const value = Number(abilities[CONTEST_STATS[result.stat]]?.[role === "attack" ? "value" : "save"]);
    const die = getContestDie(value);
    const attacker = { uuid: this.actor.uuid, name: this.actor.name, img: this.actor.img, stat: result.stat, value, die, role };
    const opponent = role === "attack" && defender?.actor ? { uuid: defender.actor.uuid, name: defender.actor.name, img: defender.actor.img } : null;
    const invalid = Number.isInteger(die) ? "" : "Cannot roll this contest: the selected stat must be a finite integer.";
    const board = await ChatMessage.create({
      speaker,
      content: renderNewContestBoard({ stat: result.stat, attacker, defender: opponent }),
      flags: { incarnos: { contestBoard: { round: 1, stat: result.stat, attacker, defender: opponent } } }
    });
    if (invalid) {
      await board.update({ content: renderNewContestBoard({ stat: result.stat, attacker, note: invalid }), "flags.incarnos.contestBoard.cancelled": true });
      return;
    }
    if (role === "attack" && !noTarget) await requestDefenderContest({ attacker: this.actor, defender, attackMessage: board, stat: result.stat });

    const proceed = role === "attack" || await showContestDialog("prompt", {
      window: { title: "Ready to roll?" },
      content: "Defend yourself!",
      ok: { label: "Roll", callback: () => true },
      rejectClose: false,
      modal: true
    });

    if (proceed) await rollBoardSide(board, attacker);
    else await board.update({ content: renderNewContestBoard({ stat: result.stat, attacker, note: "Contest cancelled." }), "flags.incarnos.contestBoard.cancelled": true });
  }
  
  static async #onEditImage(event, target) {
  event.preventDefault();

  const field = target.dataset.field ?? "img";
  const current = foundry.utils.getProperty(this.document, field) ?? "";

  const picker = new foundry.applications.apps.FilePicker({
    type: "image",
    current,
    callback: path => {
      return this.document.update({ [field]: path });
    }
  });

  picker.render(true);
}
}
