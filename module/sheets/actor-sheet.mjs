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
      height: 600
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
    context.flags = actorData.flags;
    context.items = actorData.items ?? [];
    context.effects = prepareActiveEffectCategories(actor.effects);
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

    context.biographyHTML = await TextEditor.enrichHTML(context.system.biography ?? "", {
      secrets: actor.isOwner,
      relativeTo: actor,
      rollData: context.rollData
    });

    return context;
  }

  /** @inheritDoc */
  async _onRender(context, options) {
    await super._onRender(context, options);

    for (const input of this.element.querySelectorAll(".auto-select")) {
      input.addEventListener("focus", event => event.currentTarget.select());
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
    const features = [];
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

      if ((item.type === "item") || (item.type === "weapon")) {
        gear.push(item);
      }
      else if (item.type === "feature") {
        features.push(item);
      }
      else if (item.type === "spell") {
        const spellLevel = item.system.spellLevel ?? 0;
        if (!spells[spellLevel]) spells[spellLevel] = [];
        spells[spellLevel].push(item);
      }
    }

    context.gear = gear;
    context.features = features;
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

    const name = `New ${type.charAt(0).toUpperCase()}${type.slice(1)}`;
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
  static async #onContestRoll(event) {
    event.preventDefault();

    const speaker = ChatMessage.getSpeaker({ actor: this.actor });
    const abilities = this.actor.system.abilities;
    const options = ["Strength", "Dexterity", "Constitution", "Willpower", "Perception", "Speed", "Intelligence", "Charisma"]
      .map(stat => `<option value="${stat}">${stat}</option>`)
      .join("");

    const stat = await foundry.applications.api.DialogV2.prompt({
      window: { title: "Choose your Contest stat" },
      content: `
        <fieldset>
          <legend>Stats</legend>
          <div class="form-group">
            <label>Stat</label>
            <select name="stat">${options}</select>
          </div>
        </fieldset>`,
      ok: {
        label: "Contest",
        callback: (event, button) => button.form.elements.stat.value
      },
      rejectClose: false,
      modal: true
    });

    if (!stat) return;

    let value;
    switch (stat) {
      case "Strength": value = abilities.str.value; break;
      case "Dexterity": value = abilities.dex.value; break;
      case "Constitution": value = abilities.con.value; break;
      case "Willpower": value = abilities.wis.value; break;
      case "Perception": value = abilities.prc.value; break;
      case "Speed": value = abilities.spd.value; break;
      case "Intelligence": value = abilities.int.value; break;
      case "Charisma": value = abilities.cha.value; break;
    }

    await ChatMessage.create({ speaker, flavor: `${stat} Contest: ${value}` });

    const proceed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Ready to roll?" },
      content: "Roll the contest die?",
      rejectClose: false,
      modal: true
    });

    if (proceed) {
      const rollHit = await new Roll("1d20").evaluate({ async: true });
      await ChatMessage.create({ speaker, flavor: "Let's see who wins", rolls: [rollHit] });
    }
    else {
      await ChatMessage.create({ speaker, flavor: "wussed out of the contest" });
    }
  }
}
