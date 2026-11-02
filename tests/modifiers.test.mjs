import assert from "node:assert/strict";
import { test } from "node:test";
import { isPlayerSide, modifierForRoller } from "../module/helpers/modifiers.mjs";

test("modifiers are written from the players' side: monsters roll with the opposite sign", () => {
  // A monster's "Melee -2" is bad for heroes, so the monster itself rolls at +2.
  assert.equal(modifierForRoller(-2, { type: "npc" }), 2);
  assert.equal(modifierForRoller(-2, { type: "monster" }), 2);
  // A spell's "Target Save Wil+4" helps the players: a monster saves at -4, a player character at +4.
  assert.equal(modifierForRoller(4, { type: "npc" }), -4);
  assert.equal(modifierForRoller(4, { type: "character" }), 4);
  assert.equal(modifierForRoller(undefined, { type: "npc" }), 0);
  assert.equal(isPlayerSide(undefined), true, "items without an actor count as the players' side");
});
