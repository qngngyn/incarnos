/** Fixed severity odds, independent of the number of entries in each vault table. */
export const CRITICAL_FAILURE_SEVERITIES = [
  { id: "small", name: "Small mishap", chance: 60, min: 1, max: 6, color: "#a66b00" },
  { id: "hurts", name: "It hurts", chance: 30, min: 7, max: 9, color: "#c45b16" },
  { id: "disaster", name: "Disaster", chance: 10, min: 10, max: 10, color: "#bd2727" }
];

export function criticalFailureSeverity(d10) {
  if (!Number.isInteger(d10)) return null;
  return CRITICAL_FAILURE_SEVERITIES.find(entry => d10 >= entry.min && d10 <= entry.max) ?? null;
}

export function criticalFailureTableName(severity, kind) {
  const entry = CRITICAL_FAILURE_SEVERITIES.find(entry => entry.id === severity);
  if (!entry || !["weapon", "spell"].includes(kind)) throw new Error("Invalid critical failure table");
  return `Critical Failure – ${entry.name} (${kind === "weapon" ? "Weapon" : "Spell"})`;
}

/** Only kept attack d20s count, including each attack of a multi-attack spell. */
export const hasCriticalFailure = results => results.some(result => (result.check ?? result.attack)?.d20 === 20
  || result.attacks?.some(hit => hit.attack?.d20 === 20));
