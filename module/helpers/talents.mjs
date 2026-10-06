/** Use the talent's Description as its Profile text. */
export function getTalentSummary(system = {}) {
  return typeof system.description === "string" ? system.description : "";
}
