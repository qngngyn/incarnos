/** Explicit, one-time conversion of imported scenes to the Incarnos scale. */
const FLAG = "sceneScaleConversion";
const converting = new WeakSet();
const TARGET = { type: 0, distance: 1.5, units: "m" };
const FEET = new Set(["ft", "ft.", "feet", "foot", "'", "′"]);
const METRES = new Set(["m", "m.", "meter", "meters", "metre", "metres"]);
const FIELDS = {
  lights: ["config.dim", "config.bright", "elevation"],
  sounds: ["radius", "elevation"],
  tokens: ["light.dim", "light.bright", "sight.range", "elevation"],
  templates: ["distance", "width", "elevation"],
  tiles: ["elevation"], drawings: ["elevation"], notes: ["elevation"],
  regions: ["elevation.bottom", "elevation.top"],
  levels: ["elevation.bottom", "elevation.top"]
};

function scaleField(data, path, factor) {
  const keys = path.split(".");
  const key = keys.pop();
  let parent = data;
  for (const part of keys) parent = parent?.[part];
  const value = parent?.[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value === 0 || factor === 1) return false;
  parent[key] = Number((value * factor).toFixed(8));
  return true;
}

/** Build a pure conversion plan without changing the supplied scene data. */
export function planSceneScaleConversion(source) {
  if (source.flags?.incarnos?.[FLAG]) throw new Error("This scene has already been converted to Incarnos scale.");
  const units = String(source.grid?.units ?? "").trim().toLowerCase();
  const distance = Number(source.grid?.distance);
  const feet = FEET.has(units) && distance === 5;
  const metres = METRES.has(units) && distance === 1.5;
  if (!feet && !metres) {
    throw new Error("This tool supports 5-foot scenes and scenes already using 1.5 m. This scene's scale is different; leave it unchanged and check its import settings first.");
  }
  const factor = feet ? 0.3 : 1;
  const update = { grid: { ...source.grid, ...TARGET } };
  const counts = {};
  for (const [collection, paths] of Object.entries(FIELDS)) {
    if (!Array.isArray(source[collection])) continue;
    const documents = structuredClone(source[collection]);
    let count = 0;
    for (const document of documents) {
      let changed = false;
      for (const path of paths) changed = scaleField(document, path, factor) || changed;
      if (collection === "tokens") {
        const modes = document.detectionModes;
        for (const mode of Array.isArray(modes) ? modes : Object.values(modes ?? {})) {
          changed = scaleField(mode, "range", factor) || changed;
        }
      }
      if (changed) count++;
    }
    counts[collection] = count;
    if (count) update[collection] = documents;
  }
  update["flags.incarnos." + FLAG] = {
    version: 1, factor, originalGrid: structuredClone(source.grid)
  };
  return { update, counts, factor };
}

const escapeHTML = value => String(value).replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[character]);

export async function convertSceneScale(scene) {
  if (!game.user.isGM || !scene || converting.has(scene)) return false;
  converting.add(scene);
  try {
    const source = scene.toObject();
    const plan = planSceneScaleConversion(source);
    const changes = Object.entries(plan.counts).filter(([, count]) => count)
      .map(([name, count]) => "<li>" + count + " " + name + "</li>").join("");
    const content = "<p>Convert <strong>" + escapeHTML(scene.name) + "</strong> to gridless, 1.5 m?</p>"
      + "<p>Keep the grid size at " + escapeHTML(source.grid.size) + " pixels and preserve map positions.</p>"
      + (plan.factor === 0.3 ? "<p>Multiply core distance and elevation values by 0.3: 5 feet becomes 1.5 m; a 20-foot light becomes 6 m.</p>" : "<p>This scene already uses 1.5 m. Distance values will stay the same.</p>")
      + (changes ? "<p>Objects with values to convert:</p><ul>" + changes + "</ul>" : "<p>No object distances need changing.</p>")
      + "<p>Module-specific effects and actor prototype tokens are not converted. This scene will be marked to prevent a second conversion.</p>";
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Convert to Incarnos scale" }, content, modal: true,
      rejectClose: false, yes: { label: "Convert scene" }, no: { label: "Cancel" }
    });
    if (!confirmed) return false;
    if (JSON.stringify(source) !== JSON.stringify(scene.toObject())) {
      throw new Error("The scene changed while the preview was open. Open the conversion again to review the current values.");
    }
    if (!game.user.isGM) return false;
    // Submit the grid, complete affected collections, and marker in one scene update.
    // Unmodified fields, embedded IDs, and pixel geometry are retained.
    await scene.update(plan.update);
    ui.notifications.info("Converted " + scene.name + " to Incarnos scale.");
    return true;
  } catch (error) {
    console.error("Incarnos scene scale conversion", error);
    ui.notifications.error(error.message);
    return false;
  } finally {
    converting.delete(scene);
  }
}

export function registerSceneScaleHooks() {
  Hooks.on("getSceneContextOptions", (directory, options) => {
    options.push({
      label: "Convert to Incarnos scale",
      icon: "fa-solid fa-ruler-combined",
      visible: element => Boolean(game.user.isGM && game.scenes.get(element.dataset.entryId)),
      onClick: (event, element) => convertSceneScale(game.scenes.get(element.dataset.entryId))
    });
  });
}
