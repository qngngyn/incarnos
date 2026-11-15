import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSpellRange, squaresBetween, targetInRange, tokenDistance } from "../module/helpers/spell-range.mjs";

// Tokens on a 100 px grid of 1.5 m squares; measure = straight squares between centres (enough for these lines).
const token = (col, row, size = 1) => ({ document: { x: col * 100, y: row * 100, width: size, height: size },
  center: { x: col * 100 + size * 50, y: row * 100 + size * 50 } });
const measure = (a, b) => Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) / 100 * 1.5;
const options = { measure, gridDistance: 1.5, gridSize: 100 };

test("Range lines: metres, touch/melee, and lines without a checkable range", () => {
  assert.deepEqual(parseSpellRange("12m"), { meters: 12, touch: false });
  assert.deepEqual(parseSpellRange("4,5m"), { meters: 4.5, touch: false });
  assert.deepEqual(parseSpellRange("12m (2m radius)"), { meters: 12, touch: false });
  assert.deepEqual(parseSpellRange("Touch"), { meters: 1.5, touch: true });
  assert.deepEqual(parseSpellRange("Melee"), { meters: 1.5, touch: true });
  for (const none of ["Self", "Self (6m radius)", "Sight around user", "unlimited", "X * Movementspeed", ""]) assert.equal(parseSpellRange(none), null, none);
});

test("distance runs edge to edge, so big tokens reach further", () => {
  assert.equal(tokenDistance(token(0, 0), token(8, 0), options), 12);
  assert.equal(tokenDistance(token(0, 0, 3), token(10, 0), options), 12, "a 3-square caster measures from its edge");
  assert.equal(targetInRange({ meters: 12 }, token(0, 0), token(8, 0), options), true);
  assert.equal(targetInRange({ meters: 12 }, token(0, 0), token(9, 0), options), false);
});

test("Touch needs an adjacent target, diagonals included", () => {
  const touch = parseSpellRange("Touch");
  assert.equal(squaresBetween(token(0, 0), token(1, 1)), 0);
  assert.equal(targetInRange(touch, token(0, 0), token(1, 1), options), true);
  assert.equal(targetInRange(touch, token(0, 0), token(2, 0), options), false);
  assert.equal(targetInRange(touch, token(0, 0, 2), token(2, 1), options), true, "next to a large token");
});
