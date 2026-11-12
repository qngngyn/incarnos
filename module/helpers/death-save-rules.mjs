/** Pure death save and 0 HP rules. */
export const emptyDeathSaves = () => ({ successes: 0, failures: 0, rolls: [] });

export function deathSaveResult(state = {}, d20 = null) {
  if (d20 !== null && (!Number.isInteger(d20) || d20 < 1 || d20 > 20)) throw new Error("Invalid death save");
  const success = d20 !== null && d20 <= 10;
  const successes = Math.min(3, (Number(state.successes) || 0) + Number(success));
  const failures = Math.min(3, (Number(state.failures) || 0) + (success ? 0 : d20 === 20 ? 2 : 1));
  const heal = d20 === 1 ? 1 : 0;
  return { d20, success, successes, failures, heal,
    outcome: heal ? "healed" : failures >= 3 ? "dead" : successes >= 3 ? "stabilized" : success ? "success" : "failure" };
}

export function healthTransition({ type, before, after, dying, dead = false, bledOut = false, damage = false }) {
  if (type !== "character") return null;
  if (before <= 0 && after > 0) return "heal";
  if (dead || bledOut) return null;
  if (dying && (after < before || damage)) return "failure";
  return before > 0 && after <= 0 ? "dying" : null;
}

/** NPCs have no death saves: dropping to 0 HP kills them ("dead"), healing above 0 brings them back ("revived"). */
export function npcHealthTransition({ type, before, after }) {
  if (type === "character") return null;
  if (before > 0 && after <= 0) return "dead";
  if (before <= 0 && after > 0) return "revived";
  return null;
}

export const deathSaveTally = state => "✓".repeat(Math.max(0, Math.min(3, Number(state.successes) || 0)))
  + "✗".repeat(Math.max(0, Math.min(3, Number(state.failures) || 0)));

/** Scene token actors and the active encounter, including synthetic actors; deduplicate by UUID. */
export function deathSaveCharacters(tokens = [], combatants = []) {
  const actors = new Map();
  for (const entry of [...tokens, ...combatants]) {
    if (entry.actor?.type === "character") actors.set(entry.actor.uuid, entry.actor);
  }
  return [...actors.values()].sort((a, b) => Number(b.statuses?.has("dying")) - Number(a.statuses?.has("dying"))
    || a.name.localeCompare(b.name));
}

/** Chat keeps the archive even after healing resets the actor's current saves. */
export const unshownDeathSaves = messages => [...messages].filter(message => message.flags?.incarnos?.deathSave
  && !message.flags.incarnos.deathSave.shown && !message.flags.incarnos.deathSavePublic)
  .sort((a, b) => b.timestamp - a.timestamp || b.id.localeCompare(a.id));
