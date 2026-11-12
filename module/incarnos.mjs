import { registerSceneScaleHooks } from "./helpers/scene-scale.mjs";
import { registerActionTrackerHooks } from "./helpers/action-tracker.mjs";
import { registerCombatActionHooks } from "./helpers/action-effects.mjs";
import { registerContestRequestHooks } from "./helpers/contest-requests.mjs";
import { registerSpellCastHooks } from "./helpers/spell-cast.mjs";
import { registerSummonHooks } from "./helpers/summons.mjs";
import { registerTalentHooks } from "./helpers/talents.mjs";
import { registerConditionHooks } from "./helpers/conditions.mjs";
import { registerStageHooks } from "./helpers/entertainer.mjs";
import { registerItemSyncHooks } from "./helpers/item-sync.mjs";
import { syncCompendiumsFromSource } from "./helpers/compendium-sync.mjs";
import { criticalFailure, registerCriticalFailureHooks } from "./helpers/critical-failure.mjs";
import { deathSave, registerDeathSaveHooks } from "./helpers/death-saves.mjs";
// Import document classes.
import { IncarnosActor } from "./documents/actor.mjs";
import { IncarnosItem } from "./documents/item.mjs";
// Import sheet classes.
import { IncarnosActorSheet } from "./sheets/actor-sheet.mjs";
import { IncarnosItemSheet } from "./sheets/item-sheet.mjs";
// Import helper/utility classes and constants.
import { preloadHandlebarsTemplates } from "./helpers/templates.mjs";
import { INCARNOS } from "./helpers/config.mjs";

/* -------------------------------------------- */
/*  Init Hook                                   */
/* -------------------------------------------- */

registerContestRequestHooks();
registerCombatActionHooks();
registerSpellCastHooks();
registerSummonHooks();
registerCriticalFailureHooks();
registerTalentHooks();
registerConditionHooks();
registerStageHooks();
registerDeathSaveHooks();
registerItemSyncHooks(syncCompendiumsFromSource);
registerActionTrackerHooks();
registerSceneScaleHooks();

Hooks.once('init', async function() {

  // Add utility classes to the global game object so that they're more easily
  // accessible in global contexts.
  game.incarnos = {
    IncarnosActor,
    IncarnosItem,
    rollItemMacro,
    criticalFailure,
    deathSave
  };

  // Add custom constants for configuration.
  CONFIG.INCARNOS = INCARNOS;

  /**
   * Set an initiative formula for the system
   * @type {String}
   */
  CONFIG.Combat.initiative = {
    formula: "@abilities.prc.value + @abilities.spd.value + 1d20",
    decimals: 2
  };

  // Define custom Document classes
  CONFIG.Actor.documentClass = IncarnosActor;
  CONFIG.Item.documentClass = IncarnosItem;

  // Register sheet application classes.
  Actors.registerSheet("incarnos", IncarnosActorSheet, {
    types: ["character", "npc"],
    makeDefault: true
  });
  Items.registerSheet("incarnos", IncarnosItemSheet, {
    types: ["item", "weapon", "feature", "race", "spell"],
    makeDefault: true
  });

  // Preload Handlebars templates.
  return preloadHandlebarsTemplates();
});

/* -------------------------------------------- */
/*  Handlebars Helpers                          */
/* -------------------------------------------- */

// If you need to add Handlebars helpers, here are a few useful examples:
Handlebars.registerHelper('concat', function() {
  var outStr = '';
  for (var arg in arguments) {
    if (typeof arguments[arg] != 'object') {
      outStr += arguments[arg];
    }
  }
  return outStr;
});

Handlebars.registerHelper('toLowerCase', function(str) {
  return str.toLowerCase();
});

/* -------------------------------------------- */
/*  Ready Hook                                  */
/* -------------------------------------------- */

Hooks.once("ready", async function() {
});

// Wait to register hotbar drop hook on ready so that modules could register earlier if they want to
Hooks.on("hotbarDrop", (bar, data, slot) => {
  // Only items become item macros; everything else (e.g. the Critical Failure macro) uses Foundry's own drop.
  if (data.type !== "Item") return true;
  createItemMacro(data, slot);
  return false;
});

/* -------------------------------------------- */
/*  Hotbar Macros                               */
/* -------------------------------------------- */

/**
 * Create a Macro from an Item drop.
 * Get an existing item macro if one exists, otherwise create a new one.
 * @param {Object} data     The dropped data
 * @param {number} slot     The hotbar slot to use
 * @returns {Promise}
 */
async function createItemMacro(data, slot) {
  // First, determine if this is a valid owned item.
  console.log("before check")
  if (data.type !== "Item") {
    console.log("not an item" + data.type)
    return;
  }
    console.log("after check")
  if (!data.uuid.includes('Actor.') && !data.uuid.includes('Token.')) {
    return ui.notifications.warn("You can only create macro buttons for owned Items");
  }
  // If it is, retrieve it based on the uuid.
  const item = await Item.fromDropData(data);

  // Create the macro command using the uuid.
  const command = `game.incarnos.rollItemMacro("${data.uuid}");`;
  console.log("before command")
  // let macro = game.macros.find(m => (m.name === item.name) && (m.command === command));
  // if (!macro) {
    let macro = await Macro.create({
      name: item.name,
      type: "script",
      img: item.img,
      command: command,
      flags: { "incarnos.itemMacro": true }
    });
  // }
  console.log("after command")
  console.log(macro)
  game.user.assignHotbarMacro(macro, slot);
  return false;
}

/**
 * Create a Macro from an Item drop.
 * Get an existing item macro if one exists, otherwise create a new one.
 * @param {string} itemUuid
 */
function rollItemMacro(itemUuid) {
  // Reconstruct the drop data so that we can load the item.
  const dropData = {
    type: 'Item',
    uuid: itemUuid
  };
  // Load the item from the uuid.
  Item.fromDropData(dropData).then(item => {
    // Determine if the item loaded and if it's an owned item.
    if (!item || !item.parent) {
      const itemName = item?.name ?? itemUuid;
      return ui.notifications.warn(`Could not find item ${itemName}. You may need to delete and recreate this macro.`);
    }

    // Trigger the item roll
    item.roll();
  });
}
