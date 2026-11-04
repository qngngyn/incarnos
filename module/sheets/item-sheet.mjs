import { PASSIVE_STATS } from "../helpers/passives.mjs";
import { SPELL_ACTION_TYPES, describeSpellAutomation, getSpellAutomation } from "../helpers/spells.mjs";
import { describeWeaponRules, getWeaponRules } from "../helpers/weapons.mjs";
import { describeTalent, talentRulePassives } from "../helpers/talents.mjs";
import { isPlayerSide } from "../helpers/modifiers.mjs";
import { itemSyncStatus, canResetItemSync, resetItemToCompendium } from "../helpers/item-sync.mjs";

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
      passiveDelete: IncarnosItemSheet.#onPassiveDelete,
      resetCompendium: IncarnosItemSheet.#onResetCompendium
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
  _getTabsConfig(group) {
    if (this.item.type === "spell" && group === "primary") return {
      initial: "spell",
      tabs: [
        { id: "spell", group: "primary", label: "INCARNOS.Spell" },
        { id: "flavour", group: "primary", label: "INCARNOS.Flavour" },
        { id: "passives", group: "primary", label: "Passives" }
      ]
    };
    return super._getTabsConfig(group);
  }

  /** @inheritDoc */
  _prepareTabs(group) {
    // ApplicationV2 initializes tabGroups from static TABS before the item-specific config is read.
    if (this.item.type === "spell" && group === "primary" && !["spell", "flavour", "passives"].includes(this.tabGroups.primary)) {
      this.tabGroups.primary = "spell";
    }
    return super._prepareTabs(group);
  }

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
    // Compare stored content, before any display defaults or derived data can change the fingerprint.
    context.itemSync = item.pack ? null : itemSyncStatus({ ...item.toObject(), type: item.type });
    context.canResetCompendium = canResetItemSync(item);
    context.tabs = this._prepareTabs("primary");
    if (item.type === "feature" || item.type === "race") delete context.tabs.attributes;
    context.cssClass = this.options.classes.join(" ");

    context.rollData = {};
    const actor = item.actor ?? null;
    if (actor) context.rollData = actor.getRollData();

    context.descriptionHTML = await TextEditor.enrichHTML(context.system.description ?? "", {
      secrets: item.isOwner,
      relativeTo: item,
      rollData: context.rollData
    });

    if (item.type === "weapon") {
      context.system.attackMode ??= "melee";
      context.system.versatile ??= false;
      context.system.modifier ??= 0;
      context.system.damage ??= context.system.formula ?? "d6";
      context.weaponModes = CONFIG.INCARNOS?.weaponModes ?? { melee: "Melee", ranged: "Ranged" };
      context.system.hands ??= 1;
      context.system.range ??= "";
      context.system.traits ??= "";
      context.weaponRulesText = describeWeaponRules(getWeaponRules(item.system));
      // Monster weapons carry the modifier heroes apply (see helpers/modifiers.mjs).
      context.enemyWeapon = Boolean(item.actor) && !isPlayerSide(item.actor);
    }

    if (item.type === "feature" || item.type === "race") {
      context.system.bonus ??= "";
      context.talentRulesText = describeTalent(item.system);
      // Rules of the Bonus beyond flat stats, shown as passives (applied by Foundry, or used at the table).
      context.rulePassives = talentRulePassives(context.system.bonus);
    }

    if (item.type === "spell") {
      context.system.actionType ??= "action";
      context.spellAutomationText = describeSpellAutomation(getSpellAutomation(item.system));
      context.spellActionTypes = SPELL_ACTION_TYPES;
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

  static async #onResetCompendium(event) {
    event.preventDefault();
    return resetItemToCompendium(this.item);
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
