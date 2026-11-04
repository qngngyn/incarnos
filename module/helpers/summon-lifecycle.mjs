import { escape } from "./roll-card.mjs";
import { conditionTokens, setConditionTokens } from "./conditions.mjs";

export const activeSummonGM = () => [...game.users].filter(user => user.active && user.isGM).sort((a, b) => a.id.localeCompare(b.id))[0];
const ticking = new WeakMap();
const syncing = new WeakSet();
const counterWrites = new WeakMap();
const expiring = new WeakSet();

export const summonTurns = token => Math.max(0, Math.floor(Number(token.flags?.incarnos?.summon?.turnsLeft) || 0));

/** The synthetic actor owns the status; turnsLeft owns the countdown. */
export function syncSummoned(token) {
  if (!token?.actor || !token.flags?.incarnos?.summon) return Promise.resolve();
  const task = (counterWrites.get(token) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const actor = token.actor, turns = summonTurns(token);
    if (conditionTokens(actor, "summoned") === turns) return;
    syncing.add(actor);
    try { await setConditionTokens(actor, "summoned", turns); }
    finally { syncing.delete(actor); }
  });
  counterWrites.set(token, task);
  return task;
}

/** Accept a GM's HUD edit, ignoring our own statuscounter writes. */
export async function acceptSummonedCounter(effect, changes, options, userId, removed = false) {
  const actor = effect.parent, token = actor?.isToken ? actor.token : null;
  const user = [...game.users].find(user => user.id === userId);
  if (activeSummonGM()?.id !== game.user.id || !user?.isGM || syncing.has(actor)
    || !effect.statuses?.has("summoned") || !token?.flags?.incarnos?.summon || expiring.has(token)
    || (!removed && !foundry.utils.hasProperty(changes, "flags.statuscounter.value"))) return;
  const turnsLeft = removed ? 0 : Math.max(0, Math.floor(Number(foundry.utils.getProperty(changes, "flags.statuscounter.value")) || 0));
  if (summonTurns(token) !== turnsLeft) {
    await token.update({ "flags.incarnos.summon": { ...token.flags.incarnos.summon, turnsLeft } });
  }
  await syncSummoned(token);
  if (!turnsLeft) await expireSummon(token);
}

export function registerSummonedCounterHooks() {
  const report = error => console.error("Incarnos | summoned counter", error);
  Hooks.on("updateActiveEffect", (effect, changes, options, userId) => {
    void acceptSummonedCounter(effect, changes, options, userId).catch(report);
  });
  Hooks.on("deleteActiveEffect", (effect, options, userId) => {
    void acceptSummonedCounter(effect, {}, options, userId, true).catch(report);
  });
  Hooks.on("updateToken", token => {
    if (activeSummonGM()?.id === game.user.id) void syncSummoned(token).catch(report);
  });
  Hooks.once("ready", async () => {
    if (activeSummonGM()?.id !== game.user.id) return;
    for (const scene of game.scenes ?? []) for (const token of scene.tokens) await syncSummoned(token).catch(report);
  });
}

async function expireSummon(token) {
  if (expiring.has(token)) return;
  expiring.add(token);
  try {
    for (const encounter of game.combats ?? []) {
      const ids = [...encounter.combatants].filter(c => c.tokenId === token.id && c.sceneId === token.parent?.id).map(c => c.id);
      if (ids.length) await removeSummonCombatants(encounter, ids);
    }
    await token.delete();
    await ChatMessage.create({ content: `<p>${escape(game.i18n.format("INCARNOS.Summon.fades", { name: token.name }))}</p>` });
  } finally { expiring.delete(token); }
}

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
          await syncSummoned(token);
          continue;
        }
        await expireSummon(token);
      }
    }
  });
  ticking.set(combat, next);
  return next;
}
