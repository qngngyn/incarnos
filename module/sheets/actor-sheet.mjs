import { getContestDefender, requestDefenderContest, formatContestMatchup, getContestDie, showContestDialog } from "../helpers/contest-requests.mjs";
import { getTalentSummary } from "../helpers/talents.mjs";
import { PASSIVE_STATS } from "../helpers/passives.mjs";
import { formatSignedNumber } from "../documents/item.mjs";
import { onManageActiveEffect, prepareActiveEffectCategories } from "../helpers/effects.mjs";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ActorSheetV2 } = foundry.applications.sheets;
const TextEditor = foundry.applications.ux.TextEditor.implementation;

/**
 * Incarnos Actor Sheet using the Foundry VTT ApplicationV2 sheet framework.
 * @extends {ActorSheetV2}
 */
export class IncarnosActorSheet extends HandlebarsApplicationMixin(ActorSheetV2) {

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
    context.system = actorData.system;
    // Remember the displayed total and its underlying base for safe form edits.
    const sourceSystem = actor.toObject().system;
    this._displayedStatValues = {};
    for (const path of Object.keys(PASSIVE_STATS)) {
      if (!path.startsWith("abilities.") && actor.type !== "npc") continue;
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
    const spells = {
      0: [],
      1: [],
      2: [],
      3: [],
      4: [],
      5: [],
      6: [],
      7: [],
      8: [],
      9: []
    };

    for (const item of context.items) {
      item.img = item.img || CONST.DEFAULT_TOKEN;

      if (item.type === "weapon") {
        item.attackRoll = formatSignedNumber(item.system?.modifier);
      }

      if ((item.type === "item") || (item.type === "weapon")) {
        gear.push(item);
      }
      else if (item.type === "feature") {
        item.talentSummary = getTalentSummary(item.system);
        talents.push(item);
      }
      else if (item.type === "spell") {
        const spellLevel = item.system.spellLevel ?? 0;
        if (!spells[spellLevel]) spells[spellLevel] = [];
        spells[spellLevel].push(item);
      }
    }

    context.gear = gear;
    context.talents = talents;
    context.spells = spells;
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
      const label = dataset.label ? `${dataset.label}` : "";
      const roll = new Roll(dataset.roll, this.actor.getRollData());
      await roll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor: this.actor }),
        flavor: label,
        rollMode: game.settings.get("core", "rollMode")
      });
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
    const matchup = defender?.actor ? ` - ${formatContestMatchup(this.actor.name, defender.actor.name)}` : "";

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

    let content;
    let value;
    let contestMessage;
    if (result.type === "Attack") {
      switch (result.stat) {
        case "Strength": value = abilities.str.value; break;
        case "Dexterity": value = abilities.dex.value; break;
        case "Constitution": value = abilities.con.value; break;
        case "Willpower": value = abilities.wis.value; break;
        case "Perception": value = abilities.prc.value; break;
        case "Speed": value = abilities.spd.value; break;
        case "Intelligence": value = abilities.int.value; break;
        case "Charisma": value = abilities.cha.value; break;
      }
      contestMessage = await ChatMessage.create({ speaker, flavor: `Attacker ${result.stat} Contest: ${value}${matchup}`, content: "<p>Waiting for the contest roll.</p>" });
      content = "Go get 'em!"
    } else {
      switch (result.stat) {
        case "Strength": value = abilities.str.save; break;
        case "Dexterity": value = abilities.dex.save; break;
        case "Constitution": value = abilities.con.save; break;
        case "Willpower": value = abilities.wis.save; break;
        case "Perception": value = abilities.prc.save; break;
        case "Speed": value = abilities.spd.save; break;
        case "Intelligence": value = abilities.int.save; break;
        case "Charisma": value = abilities.cha.save; break;
      }
      contestMessage = await ChatMessage.create({ speaker, flavor: `Defendant ${result.stat} Contest: ${value}`, content: "<p>Waiting for the contest roll.</p>" });
      content = "Defend yourself!"
    }


    const die = getContestDie(value);
    const rollHitText = `d${die}`;
    if (!Number.isInteger(die)) {
      await contestMessage.update({ content: "<p>Cannot roll this contest: the selected stat must be a finite integer.</p>" });
      return;
    }
    if (contestType === "Attack" && !noTarget) await requestDefenderContest({ attacker: this.actor, defender, attackMessage: contestMessage, stat: result.stat });

    const proceed = contestType === "Attack" || await showContestDialog("prompt", {
      window: { title: "Ready to roll?" },
      content: content,
      ok: { label: "Roll", callback: () => true },
      rejectClose: false,
      modal: true
    });

    if (proceed) {
      const rollHit = await new Roll(rollHitText).evaluate({ async: true });
      await contestMessage.update({
        content: await rollHit.render(),
        rolls: [rollHit.toJSON()]
      });
    }
    else {
      await contestMessage.update({ content: "<p>Contest cancelled.</p>" });
    }
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
