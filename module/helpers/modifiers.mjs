/**
 * Incarnos writes every modifier from the players' side: negative is always bad for players, positive always good
 * (a monster's "Melee -2" makes heroes parry at −2; a spell's "Target Save Wil+4" makes the enemy's save 4 harder).
 * A roll-under check adds the modifier to the value rolled under, so the roller's own modifier is the written one
 * for player characters and its negative for monsters and NPCs.
 */

/** Whether an actor is on the players' side: everything but NPCs (monsters are NPCs), including unowned items. */
export const isPlayerSide = actor => actor?.type !== "npc";

/** PvP rules: a player's attack or spell hitting another player character deals half damage. */
export const isPvpHit = (attacker, target) => Boolean(attacker?.hasPlayerOwner && target?.hasPlayerOwner
  && target.type === "character" && target !== attacker);

/**
 * The modifier as it applies to the value this actor rolls under.
 * @param {number} modifier  As written (players' side).
 * @param {Actor|object} roller  The actor making the roll.
 */
export function modifierForRoller(modifier, roller) {
  const value = Number(modifier ?? 0) || 0;
  return isPlayerSide(roller) || !value ? value : -value;
}
