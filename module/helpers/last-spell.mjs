/** What a caster remembers of its last spell (flags.incarnos.lastSpell), for Encore. Shared by spells and summons. */

/**
 * @param {object} data  The spell item's data.
 * @param {{actions?: number, mp?: number, hp?: number}} cost  What the spell itself cost (an Abomination's HP counts as IP).
 * @param {{uuid?: string, summonIp?: number}} [extra]  The spell item's UUID and, for summons, the empower IP chosen.
 */
export const lastSpellRecord = (data, cost, { uuid = null, summonIp = null } = {}) => ({
  name: data.name, data, uuid, ...(summonIp != null ? { summonIp: Number(summonIp) || 0 } : {}),
  cost: { actions: Number(cost?.actions) || 0, mp: Math.max(Number(cost?.mp) || 0, Number(cost?.hp) || 0) }, at: Date.now()
});

/** Encore's cost for a remembered spell: its actions (X) and its IP + 2 (Y+2). */
export const encoreCost = last => ({ actions: Math.max(0, Number(last?.cost?.actions) || 0), mp: Math.max(0, Number(last?.cost?.mp) || 0) + 2 });

/** Remember a spell on its caster; never lets a failed flag write stop the cast. */
export async function rememberSpell(actor, record) {
  try { await actor?.setFlag?.("incarnos", "lastSpell", record); }
  catch (error) { console.warn("Incarnos | could not remember the last spell", error); }
}
