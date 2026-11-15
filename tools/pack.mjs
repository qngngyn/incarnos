/**
 * Compile compendium source files into a Foundry LevelDB pack.
 *
 *   node tools/pack.mjs spells
 *
 * Reads every packs/_source/<name>/*.json (arrays of documents with `_key`) and rebuilds packs/<name>.
 * Keys support Items, Actors (!actors.items!), RollTables (!tables.results!), Journals (!journal.pages!) and Macros unchanged.
 * Uses the LevelDB module bundled with Foundry; set FOUNDRY_APP if Foundry is installed elsewhere.
 * The pack is built next to the old one and only swapped in when the old one is not open in Foundry,
 * so a running world never ends up with a half-deleted pack.
 */
import { existsSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const foundryApp = process.env.FOUNDRY_APP ?? "D:/Programme/Foundry Virtual Tabletop/resources/app";

/** Thrown when Foundry has the pack open (a world using it is running). */
export class PackLockedError extends Error {
  constructor(name) {
    super(`The ${name} pack is open in Foundry. Return to Setup (or close the world) and try again.`);
    this.name = "PackLockedError";
  }
}

/** The pack's source documents, read from packs/_source/<name>/*.json. */
export function readPackSource(name) {
  const sourceDir = join(root, "packs", "_source", name);
  if (!existsSync(sourceDir)) throw new Error(`No source folder ${sourceDir}`);
  return readdirSync(sourceDir).filter(file => file.endsWith(".json")).sort()
    .flatMap(file => JSON.parse(readFileSync(join(sourceDir, file), "utf8")));
}

/** Rebuilds packs/<name>; returns the document count. */
export async function buildPack(name) {
  const { ClassicLevel } = createRequire(join(foundryApp, "package.json"))("classic-level");
  const docs = readPackSource(name);
  const packDir = join(root, "packs", name);
  const nextDir = `${packDir}.next`;

  rmSync(nextDir, { recursive: true, force: true });
  const next = new ClassicLevel(nextDir, { valueEncoding: "json" });
  await next.open();
  await next.batch(docs.map(({ _key, ...doc }) => ({ type: "put", key: _key, value: doc })));
  await next.close();

  if (existsSync(packDir)) {
    // Opening the old pack fails while Foundry holds its lock; only then is it safe to replace.
    const old = new ClassicLevel(packDir, { valueEncoding: "json" });
    try { await old.open(); } catch {
      rmSync(nextDir, { recursive: true, force: true });
      throw new PackLockedError(name);
    }
    await old.close();
    rmSync(packDir, { recursive: true, force: true });
  }
  renameSync(nextDir, packDir);
  return docs.length;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const name = process.argv[2];
  if (!name) throw new Error("Usage: node tools/pack.mjs <pack name>");
  try {
    console.log(`${await buildPack(name)} documents -> packs/${name}`);
  } catch (error) {
    console.error(error.message);
    process.exit(error instanceof PackLockedError ? 2 : 1);
  }
}
