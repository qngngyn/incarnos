import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { parseSpellNote } from "../tools/spell-notes.mjs";

const lists = process.env.INCARNOS_VAULT_LISTS
  ?? join(process.env.INCARNOS_VAULT ?? "C:/Users/mfgan/IncarnosPnp", "System Files", "Listen");
const dir = join(lists, "Spells");
const catalogue = new URL("../.foundry-icons.txt", import.meta.url);
const vaultMissing = !existsSync(dir) && "local spell vault is not available";

// Match the importer: root notes plus element folders, excluding generated indexes and affinity notes.
const notes = [];
if (!vaultMissing) {
  const folders = ["", ...readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)];
  for (const folder of folders) {
    for (const file of readdirSync(join(dir, folder)).filter(file => file.endsWith(".md") && !file.startsWith("_Index_"))) {
      const markdown = readFileSync(join(dir, folder, file), "utf8").replace(/\r/g, "");
      const { spell } = parseSpellNote(markdown, basename(file, ".md"), folder);
      if (spell) notes.push({ spell, markdown, label: join(folder, file) });
    }
  }
}

test("every vault spell has exactly one nonempty Icon immediately after Element", { skip: vaultMissing }, () => {
  assert.ok(notes.length, "the spell vault must contain spell notes");
  for (const { spell, markdown, label } of notes) {
    const card = markdown.match(/```ad-check\s*\n([\s\S]*?)\n```/)?.[1] ?? "";
    assert.equal(card.match(/^Icon:/gm)?.length, 1, label);
    assert.match(card, /^Element:[^\n]*\nIcon: \S+[^\n]*$/m, label);
    assert.ok(spell.icon, label);
  }
});

test("vault spell icons exist in the local Foundry core catalogue", {
  skip: vaultMissing || (!existsSync(catalogue) && "local .foundry-icons.txt is not available")
}, () => {
  const icons = new Set(readFileSync(catalogue, "utf8").split(/\r?\n/).map(line => line.trim()).filter(Boolean));
  for (const { spell, label } of notes) assert.ok(icons.has(spell.icon), label + ": " + spell.icon);
});

test("no two vault spells in the same element share an icon", { skip: vaultMissing }, () => {
  const elements = new Map();
  for (const { spell, label } of notes) {
    if (!elements.has(spell.element)) elements.set(spell.element, new Map());
    const seen = elements.get(spell.element);
    assert.ok(!seen.has(spell.icon), label + " shares an icon with " + seen.get(spell.icon));
    seen.set(spell.icon, label);
  }
});
