/**
 * Define a set of template paths to pre-load
 * Pre-loaded templates are compiled and cached for fast access when rendering
 * @return {Promise}
 */
 export const preloadHandlebarsTemplates = async function() {
  return loadTemplates([

    "systems/incarnos/templates/item/item-passives.html",
    "systems/incarnos/templates/item/item-sync-status.html",
    "systems/incarnos/templates/item/item-sync-marker.html",

    // Actor partials.
    "systems/incarnos/templates/actor/parts/actor-talents.html",
    "systems/incarnos/templates/actor/parts/actor-items.html",
    "systems/incarnos/templates/actor/parts/actor-spells.html",
    "systems/incarnos/templates/actor/parts/actor-effects.html",
  ]);
};
