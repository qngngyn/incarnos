/** Supported passive targets. Values are signed flat modifiers. */
export const PASSIVE_STATS = {
  "abilities.str.value": "Strength",
  "abilities.dex.value": "Dexterity",
  "abilities.con.value": "Constitution",
  "abilities.wis.value": "Willpower",
  "abilities.prc.value": "Perception",
  "abilities.spd.value": "Speed",
  "abilities.int.value": "Intelligence",
  "abilities.cha.value": "Charisma",
  "health.max": "Maximum Health",
  "power.max": "Maximum Incarna",
  "actionpoints.max": "Maximum Action Points",
  "attributes.parry.value": "Parry",
  "attributes.movement.value": "Movement",
  // Not an actor value: added to the roller's weapon attacks when they roll (Incarna Weapon Modifier).
  attack: "Weapon Attack"
};

/** Weapon attack bonus from the actor's item passives ("+1 Attack"), read when an attack is rolled. */
export const itemAttackBonus = (items = []) => getItemPassiveModifiers(items).attack ?? 0;

/** Describe owned item passives for the Effects tab, including inactive entries. */
export function getItemPassiveEntries(items = []) {
  const entries = [];
  for (const item of items) {
    const system = item.system ?? {};
    const enabled = system.passivesEnabled !== false;
    const hasQuantity = system.quantity == null || !(Number(system.quantity) <= 0);
    for (const [id, passive] of Object.entries(system.passives ?? {})) {
      if (!passive || !Object.hasOwn(PASSIVE_STATS, passive.stat)) continue;
      const value = Number(passive.value);
      if (!Number.isFinite(value)) continue;
      const statLabel = PASSIVE_STATS[passive.stat];
      entries.push({
        id,
        itemId: item.id,
        sourceName: item.name,
        img: item.img ?? "icons/svg/aura.svg",
        stat: passive.stat,
        value,
        name: item.name,
        summary: value < 0 ? `Subtracts ${Math.abs(value)} from ${statLabel}.` : `Adds ${value} to ${statLabel}.`,
        description: typeof passive.description === "string" ? passive.description : "",
        active: enabled && hasQuantity,
        status: !enabled ? "Inactive: item passives disabled" : !hasQuantity ? "Inactive: quantity zero" : "Active"
      });
    }
  }
  return entries;
}

/** Collect active modifiers once per owned item, regardless of stack quantity. */
export function getItemPassiveModifiers(items = []) {
  const modifiers = {};
  for (const { stat, value, active } of getItemPassiveEntries(items)) {
    if (!active) continue;
    modifiers[stat] = (modifiers[stat] ?? 0) + value;
  }
  return modifiers;
}

/** Apply ability passives before calculation, and derived passives afterward. */
export function applyItemPassiveModifiers(system, modifiers, abilities) {
  for (const [path, modifier] of Object.entries(modifiers)) {
    if (!Object.hasOwn(PASSIVE_STATS, path) || path.startsWith("abilities.") !== abilities) continue;
    const parts = path.split(".");
    const field = parts.pop();
    const parent = parts.reduce((data, key) => data?.[key], system);
    if (!parent || !Number.isFinite(Number(parent[field]))) continue;
    parent[field] = Number(parent[field]) + modifier;
  }
}
