import assert from "node:assert/strict";
import { test } from "node:test";
import { planSceneScaleConversion, convertSceneScale, registerSceneScaleHooks } from "../module/helpers/scene-scale.mjs";

function source() {
  return { name: "Imported <Map>", grid: { type: 1, size: 100, distance: 5, units: "ft", alpha: 0.2 },
    flags: { module: { radius: 25 } },
    lights: [{ _id: "light", x: 80, y: 90, elevation: 10, config: { dim: 20, bright: 10, angle: 90, attenuation: 0.5 }, flags: { module: { distance: 50 } } }],
    sounds: [{ _id: "sound", x: 20, y: 40, radius: 30, elevation: 0 }],
    tokens: [{ _id: "token", x: 100, y: 200, width: 1, height: 2, depth: 1, elevation: -5,
      light: { dim: 10, bright: 5 }, sight: { range: 60 }, detectionModes: { basicSight: { enabled: true, range: 60 } },
      delta: { system: { movement: 30 } } }],
    templates: [{ _id: "template", x: 50, y: 60, distance: 15, width: 5, direction: 45, angle: 90 }],
    levels: [{ _id: "level", elevation: { bottom: -10, top: 20 }, background: { src: "map.webp" } }],
    regions: [{ _id: "region", elevation: { bottom: null, top: 10 }, shapes: [{ radius: 100, x: 40, y: 50 }] }],
    tiles: [{ _id: "tile", x: 10, y: 20, width: 500, height: 300, elevation: 10 }],
    walls: [{ _id: "wall", c: [0, 0, 100, 100] }], background: { src: "map.webp" }
  };
}

test("five-foot scenes preserve pixel proportions while core ranges and elevations convert", () => {
  const data = source(); const before = structuredClone(data);
  const { update, factor, counts } = planSceneScaleConversion(data);
  assert.deepEqual(data, before); assert.equal(factor, 0.3);
  assert.deepEqual(update.grid, { ...data.grid, type: 0, distance: 1.5, units: "m" });
  assert.equal(update.lights[0].config.dim, 6); assert.equal(update.lights[0].config.bright, 3);
  assert.equal(update.lights[0].elevation, 3);
  assert.equal(update.sounds[0].radius, 9);
  assert.equal(update.tokens[0].sight.range, 18); assert.equal(update.tokens[0].light.dim, 3);
  assert.equal(update.tokens[0].detectionModes.basicSight.range, 18);
  assert.equal(update.tokens[0].elevation, -1.5);
  assert.equal(update.templates[0].distance, 4.5); assert.equal(update.templates[0].width, 1.5);
  assert.equal(update.levels[0].elevation.bottom, -3); assert.equal(update.levels[0].elevation.top, 6);
  assert.equal(update.regions[0].elevation.bottom, null);
  assert.deepEqual(update.regions[0].shapes, data.regions[0].shapes);
  assert.deepEqual(update.tokens[0].delta, data.tokens[0].delta);
  for (const key of ["x", "y", "width", "height", "depth"]) assert.equal(update.tokens[0][key], data.tokens[0][key]);
  for (const key of ["x", "y", "width", "height"]) assert.equal(update.tiles[0][key], data.tiles[0][key]);
  assert.equal(update.lights[0].config.angle, 90);
  assert.deepEqual(update.lights[0].flags, data.lights[0].flags);
  assert(!("walls" in update)); assert(!("background" in update));
  assert.equal(counts.lights, 1);
  assert.equal(update.lights[0].config.dim / update.grid.distance * update.grid.size,
    data.lights[0].config.dim / data.grid.distance * data.grid.size);
});

test("converted scenes cannot be converted again; unsupported scales are rejected", () => {
  const data = source(); data.flags.incarnos = { sceneScaleConversion: { version: 1 } };
  assert.throws(() => planSceneScaleConversion(data), /already been converted/);
  for (const [units, distance] of [["", 5], ["ft", 10], ["yards", 5], ["m", 5]]) {
    assert.throws(() => planSceneScaleConversion({ ...source(), grid: { units, distance, size: 100 } }), /supports 5-foot/);
  }
});

test("metric scenes only change grid mode; null and zero ranges remain untouched", () => {
  const data = source(); data.grid.units = "m"; data.grid.distance = 1.5;
  const plan = planSceneScaleConversion(data);
  assert.equal(plan.factor, 1); assert.equal(plan.update.grid.type, 0);
  assert(!("tokens" in plan.update)); assert(!("lights" in plan.update));
  data.grid.units = " FEET "; data.grid.distance = 5;
  data.tokens[0].sight.range = null;
  data.tokens[0].detectionModes = [{ id: "basicSight", range: 0 }, { id: "other", range: 30 }];
  const converted = planSceneScaleConversion(data);
  assert.equal(converted.update.tokens[0].sight.range, null);
  assert.equal(converted.update.tokens[0].detectionModes[0].range, 0);
  assert.equal(converted.update.tokens[0].detectionModes[1].range, 9);
});

function environment(confirmed = true) {
  const data = source(); const updates = []; const errors = []; let preview;
  globalThis.game = { user: { isGM: true } };
  globalThis.ui = { notifications: { info() {}, error: message => errors.push(message) } };
  globalThis.foundry = { applications: { api: { DialogV2: { confirm: async options => { preview = options; return confirmed; } } } } };
  const scene = { name: data.name, toObject: () => structuredClone(data), async update(update) { updates.push(update); } };
  return { data, scene, updates, errors, preview: () => preview };
}

test("preview requires confirmation and sends one combined scene update", async () => {
  const env = environment(); assert(await convertSceneScale(env.scene));
  assert.equal(env.updates.length, 1);
  assert(env.updates[0]["flags.incarnos.sceneScaleConversion"]);
  assert(env.preview().content.includes("Imported &lt;Map&gt;"));
  assert(env.preview().content.includes("20-foot light becomes 6 m"));
  const cancelled = environment(false); assert.equal(await convertSceneScale(cancelled.scene), false);
  assert.equal(cancelled.updates.length, 0);
  game.user.isGM = false; assert.equal(await convertSceneScale(cancelled.scene), false);
});

test("scene changes during preview prevent applying a stale conversion", async () => {
  const env = environment();
  foundry.applications.api.DialogV2.confirm = async () => { env.data.lights[0].config.dim = 40; return true; };
  const originalError = console.error; console.error = () => {};
  try { assert.equal(await convertSceneScale(env.scene), false); } finally { console.error = originalError; }
  assert.equal(env.updates.length, 0); assert.match(env.errors[0], /scene changed/i);
});

test("v14 Scene directory context menu is available only to GMs", () => {
  let hook, callback;
  globalThis.Hooks = { on: (name, handler) => { hook = name; callback = handler; } };
  registerSceneScaleHooks(); assert.equal(hook, "getSceneContextOptions");
  const options = []; callback({}, options);
  const env = environment(); game.scenes = new Map([["scene", env.scene]]);
  const element = { dataset: { entryId: "scene" } };
  assert.equal(options[0].label, "Convert to Incarnos scale");
  assert(options[0].visible(element)); game.user.isGM = false;
  assert(!options[0].visible(element));
});
