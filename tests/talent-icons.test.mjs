import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { parseTalentNote, talentsToDocuments } from "../tools/talent-notes.mjs";

const lists = process.env.INCARNOS_VAULT_LISTS
  ?? join(process.env.INCARNOS_VAULT ?? "C:/Users/mfgan/IncarnosPnp", "System Files", "Listen");
const catalogue = new URL("../.foundry-icons.txt", import.meta.url);

for (const [kind, folder, type] of [["Talent", "Talents", "feature"], ["Race", "Races", "race"]]) {
  const dir = join(lists, folder);
  const vaultMissing = !existsSync(dir) && `local ${folder.toLowerCase()} vault is not available`;
  const notes = [];
  if (!vaultMissing) {
    for (const file of readdirSync(dir).filter(file => file.endsWith(".md") && !file.startsWith("_Index_"))) {
      const markdown = readFileSync(join(dir, file), "utf8").replace(/\r/g, "");
      const { talent } = parseTalentNote(markdown, basename(file, ".md"), { kind });
      if (talent) notes.push({ talent, markdown, label: file });
    }
  }

  test(`every vault ${kind.toLowerCase()} has exactly one nonempty Icon immediately after Typ`, { skip: vaultMissing }, () => {
    assert.ok(notes.length, `the ${folder} vault must contain notes`);
    for (const { talent, markdown, label } of notes) {
      const card = markdown.match(/```ad-check\s*\n([\s\S]*?)\n```/)?.[1] ?? "";
      assert.equal(card.match(/^Icon:/gm)?.length, 1, label);
      assert.match(card, new RegExp(`^Typ: ${kind}\\nIcon: \\S+[^\\n]*$`, "m"), label);
      assert.ok(talent.icon, label);
      const [doc] = talentsToDocuments([talent], { type });
      assert.equal(doc.img, talent.icon, label);
      assert.ok(!JSON.stringify(doc.system).includes(talent.icon), label);
      assert.doesNotMatch(talent.bonus, /^Icon:/m, label);
    }
  });

  test(`vault ${folder.toLowerCase()} icons exist in the local Foundry core catalogue`, {
    skip: vaultMissing || (!existsSync(catalogue) && "local .foundry-icons.txt is not available")
  }, () => {
    const icons = new Set(readFileSync(catalogue, "utf8").split(/\r?\n/).map(line => line.trim()).filter(Boolean));
    for (const { talent, label } of notes) assert.ok(icons.has(talent.icon), label + ": " + talent.icon);
  });

  test(`no two vault ${folder.toLowerCase()} share an icon`, { skip: vaultMissing }, () => {
    const seen = new Map();
    for (const { talent, label } of notes) {
      assert.ok(!seen.has(talent.icon), label + " shares an icon with " + seen.get(talent.icon));
      seen.set(talent.icon, label);
    }
  });
}

test("talent and race icons stay metadata before or after multiline Bonus; missing/blank icons keep defaults", () => {
  const icon = "icons/magic/defensive/armor-stone-skin.webp";
  for (const [kind, type, fallback] of [["Talent", "feature", "icons/svg/upgrade.svg"], ["Race", "race", "icons/svg/mystery-man.svg"]]) {
    for (const position of ["before", "middle", "after", "missing", "blank"]) {
      const metadata = `Icon:   ${position === "blank" ? "" : icon}  `;
      const lines = [`Typ: ${kind}`, "Bonus: +1 Parry", "+2 Strength", "Ordinary rules."];
      if (position !== "missing") lines.splice(position === "before" || position === "blank" ? 1 : position === "middle" ? 3 : 4, 0, metadata);
      const note = "```ad-check\n" + lines.join("\n") + "\n```\n```ad-example\nFlavour only.\n```";
      const { talent, warnings } = parseTalentNote(note.replace(/\n/g, "\r\n"), "Example", { kind });
      assert.deepEqual(warnings, []);
      assert.equal(talent.icon, position === "missing" || position === "blank" ? "" : icon);
      assert.equal(talent.bonus, "+1 Parry\n+2 Strength\nOrdinary rules.");
      assert.equal(talent.description, "Flavour only.");
      const [doc] = talentsToDocuments([talent], { type });
      assert.equal(doc.img, talent.icon || fallback);
      assert.equal(doc.system.description, "<p>Flavour only.</p>");
      assert.deepEqual(Object.values(doc.system.passives).map(p => [p.stat, p.value]), [["attributes.parry.value", 1], ["abilities.str.value", 2]]);
      assert.ok(!Object.hasOwn(doc.system, "icon"));
      assert.doesNotMatch(JSON.stringify(doc.system), /Icon:|icons\//);
      const { icon: omitted, ...legacy } = talent;
      assert.equal(talentsToDocuments([legacy], { type })[0].img, fallback);
    }
  }
});
