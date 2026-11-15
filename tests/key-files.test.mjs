import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { missingKeyFiles, pathLinks } from "../tools/key-files.mjs";

test("only full-path wikilinks count, without alias or heading", () => {
  assert.deepEqual(pathLinks("[[A/B|alias]] [[C]] [[A/B#Heading]] [[D/E.png]]"), ["A/B", "D/E.png"]);
});

test("a key file that was moved away is reported, existing ones are not", () => {
  const vault = mkdtempSync(join(tmpdir(), "incarnos-vault-"));
  try {
    mkdirSync(join(vault, "Welten", "Monsters"), { recursive: true });
    writeFileSync(join(vault, "Welten", "Monsters", "Monster Balancing.md"), "x");
    writeFileSync(join(vault, "CLAUDE.md"), "| [[Welten/Monsters/Monster Balancing]] | [[Welten/Old/Stats]] |");
    assert.deepEqual(missingKeyFiles(vault), ["Welten/Old/Stats"]);
    assert.deepEqual(missingKeyFiles(join(vault, "nowhere")), []);
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});
