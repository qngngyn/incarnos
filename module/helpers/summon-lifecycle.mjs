import { escape } from "./roll-card.mjs";

export const activeSummonGM = () => [...game.users].filter(user => user.active && user.isGM).sort((a, b) => a.id.localeCompare(b.id))[0];
const ticking = new WeakMap();

/** Structural changes preserve the active combatant and never count as ending its turn. */
export function addSummonCombatant(combat, data) {
  const id = foundry.utils.randomID();
  const currentId = combat.combatant?.id;
  const turns = [...combat.combatants, { ...data, id, parent: combat }].sort((a, b) => combat._sortCombatants(a, b));
  const turn = turns.findIndex(c => c.id === currentId);
  return combat.createEmbeddedDocuments("Combatant", [{ ...data, _id: id }],
    { keepId: true, turnEvents: false, ...(turn >= 0 ? { combatTurn: turn } : {}) });
}

export function removeSummonCombatants(combat, ids) {
  const currentId = combat.combatant?.id;
  const turns = [...combat.combatants].filter(c => !ids.includes(c.id)).sort((a, b) => combat._sortCombatants(a, b));
  const turn = turns.findIndex(c => c.id === currentId);
  return combat.deleteEmbeddedDocuments("Combatant", ids, turn >= 0 ? { combatTurn: turn, turnEvents: false } : {});
}

/** Keep equal-initiative summons beside their caster, preserving the usual order of everyone else. */
export function sortSummonCombatants(a, b, compare) {
  const root = combatant => {
    const seen = new Set();
    let current = combatant;
    while (!seen.has(current.id)) {
      seen.add(current.id);
      const caster = current.parent?.combatants.get(current.flags?.incarnos?.summonAfter);
      if (!caster || caster.initiative !== combatant.initiative) break;
      current = caster;
    }
    return current;
  };
  if (a.initiative !== b.initiative) return compare(a, b);
  const ar = root(a), br = root(b);
  if (ar.id !== br.id) return compare(ar, br);
  if (a.id === ar.id) return -1;
  if (b.id === br.id) return 1;
  return compare(a, b);
}

/** End-of-caster-turn duration, called from the existing committed turn transition. */
export function tickSummons(combat, prior, current) {
  if (activeSummonGM()?.id !== game.user.id || !combat.started || !prior || !current || !(prior.round > 0)
    || prior.turn == null || current.turn == null || !prior.combatantId
    || !(current.round > prior.round || (current.round === prior.round && current.turn > prior.turn))) return;
  const casterUuid = combat.combatants.get(prior.combatantId)?.actor?.uuid;
  if (!casterUuid) return;
  const key = [combat.id, prior.round, prior.turn, prior.combatantId].join(":");
  const next = (ticking.get(combat) ?? Promise.resolve()).catch(() => {}).then(async () => {
    for (const scene of game.scenes ?? []) {
      for (const token of [...scene.tokens]) {
        const summon = token.flags?.incarnos?.summon;
        if (summon?.casterUuid !== casterUuid || !(summon.turnsLeft > 0) || summon.lastTurn === key) continue;
        if (summon.turnsLeft > 1) {
          await token.update({ "flags.incarnos.summon": { ...summon, turnsLeft: summon.turnsLeft - 1, lastTurn: key } });
          continue;
        }
        for (const encounter of game.combats ?? []) {
          const ids = [...encounter.combatants].filter(c => c.tokenId === token.id && c.sceneId === scene.id).map(c => c.id);
          if (ids.length) await removeSummonCombatants(encounter, ids);
        }
        await token.delete();
        await ChatMessage.create({ content: `<p>${escape(game.i18n.format("INCARNOS.Summon.fades", { name: token.name }))}</p>` });
      }
    }
  });
  ticking.set(combat, next);
  return next;
}
