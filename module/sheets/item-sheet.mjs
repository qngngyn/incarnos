import { TALENT_TYPES, getTalentDetails } from "../helpers/talents.mjs";
import { PASSIVE_STATS } from "../helpers/passives.mjs";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ItemSheetV2 } = foundry.applications.sheets;
const TextEditor = foundry.applications.ux.TextEditor.implementation;

/**
 * Incarnos Item Sheet using the Foundry VTT ApplicationV2 sheet framework.
 * @extends {ItemSheetV2}
 */
export class IncarnosItemSheet extends HandlebarsApplicationMixin(ItemSheetV2) {

  /** @inheritDoc */
  static DEFAULT_OPTIONS = {
    classes: ["incarnos", "sheet", "item"],
    tag: "form",
    position: {
      width: 520,
      height: 480
    },
    window: {
      resizable: true
    },
    form: {
      closeOnSubmit: false,
      submitOnChange: true
    },
    actions: {
      editImage: IncarnosItemSheet.#onEditImage,
      passiveAdd: IncarnosItemSheet.#onPassiveAdd,
      passiveDelete: IncarnosItemSheet.#onPassiveDelete
    }
  };

  /** @inheritDoc */
  static TABS = {
    primary: {
      initial: "description",
      tabs: [
        { id: "description", group: "primary", label: "Description" },
        { id: "attributes", group: "primary", label: "Attributes" },
        { id: "passives", group: "primary", label: "Passives" }
      ]
    }
  };

  /** @inheritDoc */
  static PARTS = {
    form: {
      template: "systems/incarnos/templates/item/item-sheet.html"
    }
  };

  /** @inheritDoc */
  _configureRenderParts(options) {
    return {
      form: {
        template: `systems/incarnos/templates/item/item-${this.item.type}-sheet.html`
      }
    };
  }

  /** @inheritDoc */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const item = this.item;
    const itemData = item.toObject(false);

    context.item = item;
    context.system = itemData.system;
    context.flags = itemData.flags;
    context.system.passivesEnabled ??= true;
    context.system.passives ??= {};
    context.passiveStats = PASSIVE_STATS;
    context.owner = item.isOwner;
    context.editable = this.isEditable;
    context.tabs = this._prepareTabs("primary");
    context.cssClass = this.options.classes.join(" ");

    context.rollData = {};
    const actor = item.actor ?? null;
    if (actor) context.rollData = actor.getRollData();

    context.descriptionHTML = await TextEditor.enrichHTML(context.system.description ?? "", {
      secrets: item.isOwner,
      relativeTo: item,
      rollData: context.rollData
    });

    if (item.type === "feature") {
      Object.assign(context.system, getTalentDetails(context.system));
      context.talentTypes = TALENT_TYPES;
      context.isActiveTalent = context.system.talentType === "active";
    }

    if (item.type === "weapon") {
      context.system.attackMode ??= "melee";
      context.system.versatile ??= false;
      context.system.modifier ??= 0;
      context.system.damage ??= context.system.formula ?? "d6";
      context.weaponModes = CONFIG.INCARNOS?.weaponModes ?? { melee: "Melee", ranged: "Ranged" };
    }

    return context;
  }

  /** @inheritDoc */
  async _onRender(context, options) {
    await super._onRender(context, options);

    for (const input of this.element.querySelectorAll(".auto-select")) {
      input.addEventListener("focus", event => event.currentTarget.select());
    }
  }

  static async #onPassiveAdd(event) {
    event.preventDefault();
    if (!this.isEditable) return;
    const id = foundry.utils.randomID();
    await this.item.update({ [`system.passives.${id}`]: { stat: "abilities.str.value", value: 0, description: "" } });
  }

  static async #onPassiveDelete(event, target) {
    event.preventDefault();
    if (!this.isEditable) return;
    const id = target.dataset.passiveId;
    if (!Object.hasOwn(this.item.system.passives ?? {}, id)) return;
    await this.item.update({ [`system.passives.-=${id}`]: null });
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
