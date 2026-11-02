/**
 * The vault's CLAUDE.md names key notes by full-path wikilinks ([[System Files/Monster Balancing]]),
 * so Claude finds them even after a move (Obsidian rewrites such links). sync-vault uses this to warn about links
 * that no longer resolve.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Full-path wikilinks (containing "/") in a markdown text, without alias or heading, de-duplicated. */
export function pathLinks(markdown) {
  const links = [...String(markdown ?? "").matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map(match => match[1].trim()).filter(link => link.includes("/"));
  return [...new Set(links)];
}

/** Links in <vault>/CLAUDE.md whose note (or file, if the link has an extension) does not exist. */
export function missingKeyFiles(vault) {
  const file = join(vault, "CLAUDE.md");
  if (!existsSync(file)) return [];
  return pathLinks(readFileSync(file, "utf8"))
    .filter(link => !existsSync(join(vault, /\.\w+$/.test(link) ? link : `${link}.md`)));
}
