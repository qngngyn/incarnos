/**
 * Spell range: read from the Range line, measured on the grid, and shown on the canvas as a ring around the caster
 * (green when everything is in range, red when not) plus a green/red ring around each target.
 */

/**
 * @param {string} range  The spell's Range line.
 * @returns {{meters: number, touch: boolean}|null}  "12m" and "12m (2m radius)" (where a placed area may go) give metres;
 *   "Touch" and "Melee" mean adjacent (1.5 m); Self, Sight, unlimited and formulas have no range to check.
 */
export function parseSpellRange(range = "") {
  const text = String(range ?? "").trim().replace(/(\d),(\d)/g, "$1.$2");
  if (/^(touch|melee)\b/i.test(text)) return { meters: 1.5, touch: true };
  const match = text.match(/^([\d.]+)\s*m\b(?!\s*radius)/i);
  return match && Number(match[1]) > 0 ? { meters: Number(match[1]), touch: false } : null;
}

/** Token bounds in grid squares: {x, y, w, h}. */
const bounds = (token, size) => ({
  x: Number(token.document?.x ?? token.x ?? 0) / size, y: Number(token.document?.y ?? token.y ?? 0) / size,
  w: Number(token.document?.width ?? 1), h: Number(token.document?.height ?? 1)
});

/** Empty squares between two tokens' edges (0 = adjacent or overlapping, diagonals count as adjacent). */
export function squaresBetween(a, b, gridSize = 100) {
  const A = bounds(a, gridSize), B = bounds(b, gridSize);
  const gapX = Math.max(0, B.x - (A.x + A.w), A.x - (B.x + B.w));
  const gapY = Math.max(0, B.y - (A.y + A.h), A.y - (B.y + B.h));
  return Math.round(Math.max(gapX, gapY) * 1000) / 1000;
}

/**
 * Distance in metres from the caster to a target, edge to edge: the grid path between the token centres
 * (Foundry's diagonal rule) minus the extra size of bigger tokens.
 * @param {Function} measure  (from, to) => distance in metres between two points.
 */
export function tokenDistance(caster, target, { measure, gridDistance = 1.5 } = {}) {
  const size = token => Math.max(Number(token.document?.width ?? 1), Number(token.document?.height ?? 1));
  const extra = ((size(caster) - 1) + (size(target) - 1)) / 2 * gridDistance;
  return Math.max(0, measure(caster.center, target.center) - extra);
}

/** Whether a target is within the spell's range of the caster. Touch/Melee: adjacent (diagonals included). */
export function targetInRange(range, caster, target, { measure, gridDistance = 1.5, gridSize = 100 } = {}) {
  if (!range || !caster || !target || caster === target) return true;
  if (range.touch) return squaresBetween(caster, target, gridSize) <= 0;
  return tokenDistance(caster, target, { measure, gridDistance }) <= range.meters + 1e-6;
}

/* -------------------------------------------- */
/*  Canvas                                      */
/* -------------------------------------------- */

const GREEN = 0x43a047, RED = 0xe53935;

/** Distance in metres between two canvas points on the current grid. */
export const measureOnGrid = (from, to) => (canvas.grid?.measurePath
  ? canvas.grid.measurePath([from, to]).distance
  : Math.hypot(to.x - from.x, to.y - from.y) / canvas.dimensions.distancePixels);

/** Measuring options for the current scene. */
export const gridOptions = () => ({ measure: measureOnGrid, gridDistance: canvas.dimensions?.distance ?? 1.5, gridSize: canvas.dimensions?.size ?? 100 });

/**
 * A ring around the caster showing the spell's range. `setOk(bool)` colours it; `destroy()` removes it.
 * @returns {{setOk: Function, destroy: Function}|null}
 */
export function createRangeRing(casterToken, range, { fromCenter = false } = {}) {
  if (!range || !casterToken || !globalThis.PIXI || !canvas?.interface) return null;
  const ring = new PIXI.Graphics();
  // Token ranges count from the caster's edge; a placed area's range counts from the caster's centre.
  const radius = (range.touch ? canvas.dimensions.size : range.meters * canvas.dimensions.distancePixels)
    + (fromCenter ? 0 : Math.max(casterToken.w, casterToken.h) / 2);
  const draw = ok => {
    const color = ok ? GREEN : RED;
    ring.clear().lineStyle(4, color, 0.9).beginFill(color, 0.08).drawCircle(casterToken.center.x, casterToken.center.y, radius).endFill();
  };
  draw(true);
  canvas.interface.addChild(ring);
  return { setOk: draw, destroy: () => { if (!ring.destroyed) ring.destroy(); } };
}

/**
 * Show the range for a cast: the caster's ring and a green/red ring around each target, for a few seconds.
 * @param {{token: Token, ok: boolean}[]} targets
 */
export function showRangeIndicator(casterToken, range, targets = [], { duration = 3500 } = {}) {
  const ring = createRangeRing(casterToken, range);
  if (!ring) return;
  ring.setOk(targets.every(target => target.ok));
  const marks = targets.map(({ token, ok }) => {
    const mark = new PIXI.Graphics();
    mark.lineStyle(4, ok ? GREEN : RED, 1).drawCircle(token.center.x, token.center.y, Math.max(token.w, token.h) / 2 + 6);
    canvas.interface.addChild(mark);
    return mark;
  });
  setTimeout(() => { ring.destroy(); for (const mark of marks) if (!mark.destroyed) mark.destroy(); }, duration);
}
