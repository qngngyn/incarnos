/** Import Critical Failures.md and the manual prompt macro; never writes to the vault. */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { criticalFailureMacroDocuments, criticalFailuresToDocuments, parseCriticalFailureNote } from "./critical-failure-notes.mjs";

const lists = process.argv[2] ?? process.env.INCARNOS_VAULT_LISTS ?? "C:/Users/mfgan/IncarnosPnp/System Files/Listen";
const NOTE = "Critical Failures.md";

/** The note may be moved anywhere inside the system folder (the list folder's parent): find it by name. */
function findNote(root) {
  const found = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name === NOTE)
    .map(entry => join(entry.parentPath ?? entry.path, entry.name));
  if (!found.length) throw new Error(`${NOTE} not found anywhere in ${root}`);
  if (found.length > 1) throw new Error(`${NOTE} exists more than once: ${found.join(", ")}`);
  return found[0];
}

const tables = parseCriticalFailureNote(readFileSync(findNote(dirname(lists)), "utf8"));
for (const [pack, documents] of [["critical-failures", criticalFailuresToDocuments(tables)], ["macros", criticalFailureMacroDocuments()]]) {
  const directory = new URL(`../packs/_source/${pack}/`, import.meta.url);
  mkdirSync(directory, { recursive: true });
  writeFileSync(new URL(`${pack}.json`, directory), JSON.stringify(documents, null, 2) + "\n");
}
console.log(`6 critical failure tables (${tables.map(table => `${table.name}: ${table.rows.length}`).join(", ")}) and 1 macro -> packs/_source`);
