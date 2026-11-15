import { stableId } from "./spell-sheet.mjs";

export function deathSaveMacroDocuments() {
  const id = stableId("macro:Death Save");
  return [{ _id: id, _key: `!macros!${id}`, name: "Death Save", type: "script", img: "tokens/items/death-save.webp",
    scope: "global", command: "await game.incarnos.deathSave();", folder: null, sort: 10,
    ownership: { default: 0 }, flags: {} }];
}
