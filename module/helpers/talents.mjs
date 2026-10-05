/** Gameplay details are descriptive; using a talent does not spend AP automatically. */
export const TALENT_TYPES = { passive: "Passive", active: "Active" };

/** Defaults also support existing feature items without a migration. */
export function getTalentDetails(system = {}) {
  const talentType = Object.hasOwn(TALENT_TYPES, system.talentType) ? system.talentType : "passive";
  const cost = Number(system.apCost ?? 0);
  return {
    talentType,
    apCost: Number.isFinite(cost) ? Math.max(0, Math.floor(cost)) : 0,
    trigger: typeof system.trigger === "string" ? system.trigger : "",
    duration: typeof system.duration === "string" ? system.duration : ""
  };
}

/** Compact Profile summary, with no AP cost shown for passive talents. */
export function getTalentSummary(system = {}) {
  const details = getTalentDetails(system);
  const parts = [TALENT_TYPES[details.talentType]];
  if (details.talentType === "active") parts.push(`${details.apCost} AP`);
  if (details.trigger.trim()) parts.push(`Trigger: ${details.trigger.trim()}`);
  if (details.duration.trim()) parts.push(`Duration: ${details.duration.trim()}`);
  return parts.join(" ? ");
}
