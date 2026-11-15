/** Read-only vault import. Run after item importers so links use their current stable IDs. */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { handbookToDocuments } from "./handbook-notes.mjs";
import { readPackSource } from "./pack.mjs";

const LISTS = process.argv[2] ?? process.env.INCARNOS_VAULT_LISTS ?? "C:/Users/mfgan/IncarnosPnp/System Files/Listen";
const systemFiles = dirname(LISTS);
const notes = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.md$/i.test(entry.name)) notes.push({ path: relative(systemFiles, file).replace(/\\/g, "/"), markdown: readFileSync(file, "utf8") });
  }
}
walk(systemFiles);
const items = Object.fromEntries(["weapons", "talents", "races", "spells"].map(pack => [pack, readPackSource(pack)]));
const result = handbookToDocuments(notes, items);
const out = new URL("../packs/_source/handbook/", import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL("handbook.json", out), JSON.stringify(result.documents, null, 2) + "\n");
console.log(`Handbook: ${result.pages} pages, ${result.links} links, ${result.warnings.length} warnings`);
for (const warning of result.warnings) console.log(`- ${warning}`);
