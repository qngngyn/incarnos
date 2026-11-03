/** Active combat actions. Stat names resolve through CONTEST_STATS; Wil uses the stored wis key. */
export const ACTIONS = [
  { id: "shove", name: "Shove", stats: ["Strength"], saves: ["Strength", "Constitution"], effect: { choice: true } },
  { id: "grapple", name: "Grapple", stats: ["Strength"], saves: ["Strength", "Speed"], effect: { condition: "grappled" } },
  { id: "escape", name: "Escape Grapple", stats: ["Strength"], saves: ["Strength"], effect: { condition: "grappled", self: true, remove: true } },
  { id: "find", name: "Find", stats: ["Perception"], saves: ["Dexterity"], effect: { condition: "hidden", remove: true } },
  { id: "intimidate", name: "Intimidate", stats: ["Charisma"], saves: ["Charisma"], effect: { condition: "intimidated", untilEndOfTurn: true } },
  { id: "taunt", name: "Taunt", stats: ["Charisma"], saves: ["Willpower"], effect: { condition: "taunted", untilEndOfTurn: true } },
  { id: "scale", name: "Scale", stats: ["Speed", "Dexterity"], saves: ["Speed", "Dexterity"], effect: { condition: "mounted", self: true }, note: "INCARNOS.Actions.scaleManual" },
  { id: "dodge", name: "Dodge", effect: { dodge: true } },
  { id: "hinder", name: "Hinder", effect: { condition: "hindered" } },
  { id: "hide", name: "Hide", stats: ["Dexterity"], effect: { condition: "hidden", self: true } },
  { id: "insight", name: "Combat Insight", stats: ["Intelligence"], effect: { insight: true } }
].map(action => Object.freeze({ ...action, kind: action.saves ? "contest" : "misc", tooltip: `INCARNOS.Actions.${action.id}Cheat` }));
export const actionById = id => ACTIONS.find(action => action.id === id);
export const actionName = action => game.i18n.localize(`INCARNOS.Actions.${action.id}`);
export const actionLabel = action => game.i18n.localize(`INCARNOS.Actions.${action.id}Label`);
export const actionTooltip = action => `${game.i18n.localize("INCARNOS.Actions.cost")} · ${game.i18n.localize(action.tooltip)}`;
export const statAbbreviation = stat => ({ Strength: "Str", Dexterity: "Dex", Constitution: "Con", Willpower: "Wil", Perception: "Prc", Speed: "Spd", Intelligence: "Int", Charisma: "Cha" })[stat] ?? stat;
export const actionMatchup = (action, stat = action.stats?.[0]) => `${actionName(action)}: ${statAbbreviation(stat)} vs ${action.saves.map(statAbbreviation).join("/")} ${game.i18n.localize("INCARNOS.Actions.save")}`;
/** An absent/invalid level is treated as level 1. Higher levels continue the same pattern. */
export function insightModifier(level) {
  const value = Number(level);
  return 4 - 2 * (Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : 1);
}
