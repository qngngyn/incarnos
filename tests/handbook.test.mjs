import assert from "node:assert/strict";
import { test } from "node:test";
import { HANDBOOK_PAGES } from "../tools/handbook-pages.mjs";
import { HANDBOOK_ID, handbookPageId, handbookTitle, prepareHandbookNote, resolveHandbookNote, convertHandbookNote, handbookToDocuments } from "../tools/handbook-notes.mjs";
import { unpackCompendiumSource } from "../module/helpers/compendium-sync.mjs";

const note = (path, markdown = "# Title\n\nBody") => ({ path, markdown });
const item = (name, id) => ({ _id: id, _key: `!items!${id}`, name });
const convert = (markdown, options = {}) => convertHandbookNote(markdown, { path: "Incarnos Handbook.md", ...options });
const pageUuid = path => `Compendium.incarnos.handbook.JournalEntry.${HANDBOOK_ID}.JournalEntryPage.${handbookPageId(path)}`;

test("own title and leading breadcrumb disappear; a later H1 and non-Discord hr remain", () => {
  const markdown = "# My Title (new)\r\n\r\n↑ [[Home]]\r\n\r\nText **bold**, *italic*, `code`.\r\n\r\n---\r\n\r\n# Later\n";
  const { html } = convert(markdown);
  assert.equal(handbookTitle(markdown, "Fallback.md"), "My Title");
  assert.equal(handbookTitle("Body", "Folder/Fallback.md"), "Fallback");
  assert.doesNotMatch(html, /My Title|↑|Home/);
  assert.match(html, /<h1>Later<\/h1>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<strong>bold<\/strong>, <em>italic<\/em>, <code>code<\/code>/);
});

test("Discord chrome and separators disappear; post headings are H2 and channels link to pages", () => {
  const paths = HANDBOOK_PAGES.slice(2, 9).map(page => page.path);
  const channels = ["how-to-play", "character-creation", "attributes-and-stats", "list-of-actions", "magic", "level-table", "list-of-links"];
  const markdown = `# How To Play (new)\n\nChannel: **#how-to-play**\nEach block between two lines is a message.\n\n---\n\n# 🎲 Welcome\n\n${channels.map(channel => `#${channel}`).join(", ")}\n\n---\n\n@everyone Hidden post\n\n---\n\n# Next\n\nKeep me`;
  const result = convert(markdown, { path: paths[0], notes: paths.map(path => note(path)) });
  assert.doesNotMatch(result.html, /Channel:|Each block|<hr|@everyone|Hidden post|<h1>/);
  assert.match(result.html, /<h2>🎲 Welcome<\/h2>/);
  assert.match(result.html, /<h2>Next<\/h2>/);
  // Channel mentions read as the page name.
  for (const path of paths) assert.ok(result.html.includes(`@UUID[${pageUuid(path)}]{${path.split("/").pop().replace(/\.md$/, "")}}`));
  assert.equal(result.links, 7);
  assert.deepEqual(result.warnings, []);
  assert.equal(prepareHandbookNote("# Title\n\n---\nText", { discord: true }), "Text");
});

test("all admonition kinds render markdown, default/explicit titles, and deterministic GM secrets", () => {
  const markdown = "# Page\n\n" + ["note", "check", "example", "quote", "success", "warning"]
    .map(kind => `\`\`\`ad-${kind}\n${kind === "warning" ? "title: GM only — secrets\n" : ""}**Body**\n\n- One\n- Two\n\`\`\``).join("\n\n");
  const { html } = convert(markdown);
  for (const kind of ["note", "check", "example", "quote", "success", "warning"]) assert.match(html, new RegExp(`<aside class="isc-callout isc-callout-${kind}">`));
  assert.match(html, /<p class="isc-callout-title">Note<\/p><p><strong>Body<\/strong>/);
  assert.match(html, /<section class="secret" id="secret-[A-Za-z0-9]{16}"><aside class="isc-callout isc-callout-warning">/);
  assert.doesNotMatch(html, /<p><(?:section|aside)/);
  assert.match(html, /<ul>\n<li>One<\/li>/);
  assert.equal(convert(markdown).html, html);
});

test("page, heading, full path and bare-name links use stable page UUIDs, even in tables", () => {
  const path = "Rules/Incarnos Rules.md";
  const markdown = "# Title\n\n[[Incarnos Rules]] [[System Files/Rules/Incarnos Rules#Checks|A label]]\n\n| Rule | Info |\n| --- | --- |\n| [[Incarnos Rules|Rules]] | first<br>second |";
  const result = convert(markdown, { notes: [note(path)] });
  assert.equal(result.links, 3);
  assert.ok(result.html.includes(`@UUID[${pageUuid(path)}]{A label}`));
  assert.match(result.html, /<div class="isc-table-scroll"><table>/);
  assert.match(result.html, /<td>@UUID\[[^\]]+\]\{Rules\}<\/td>/);
  assert.match(result.html, /first<br>second/);
});

test("weapon, talent, race and nested spell links find item source IDs by name, preserving trailing dots", () => {
  const notes = [note("Listen/Weapons/Sword.md"), note("Listen/Talents/Talent.md"), note("Listen/Races/Race.md"), note("Listen/Spells/Dream/Go to Sleep...md")];
  const items = { weapons: [item("Sword", "w")], talents: [item("Talent", "t")], races: [item("Race", "r")], spells: [item("Go to Sleep..", "s")] };
  const result = convert("[[Sword]] [[Talent]] [[Race]] [[Go to Sleep..]] [[System Files/Listen/Spells/Dream/Go to Sleep..|Sleep]]", { notes, items });
  for (const [pack, id] of [["weapons", "w"], ["talents", "t"], ["races", "r"], ["spells", "s"]]) assert.ok(result.html.includes(`Compendium.incarnos.${pack}.Item.${id}`));
  assert.match(result.html, /\{Go to Sleep\.\.\}/);
  assert.equal(result.links, 5);
  assert.deepEqual(result.warnings, []);
});

test("standalone condition and trait list links inline markdown rules without Icon lines; inline mentions remain labels", () => {
  const notes = [note("Listen/Conditions/Asleep.md", "Asleep (tokens): You **cannot act**.\nIcon: icons/svg/sleep.svg"),
    note("Listen/Weapon Traits/Deadly.md", "Deadly (dice, e.g. D4): Extra *damage*.\nIcon: hidden.svg")];
  const result = convert("- [[Asleep]]\n- [[Deadly|A trait]]\n- Keep [[Asleep]] here\n- ![[Asleep]]", { notes });
  assert.match(result.html, /<li><strong>Asleep:<\/strong> You <strong>cannot act<\/strong>\.<\/li>/);
  assert.match(result.html, /<strong>Deadly \(dice, e.g. D4\):<\/strong> Extra <em>damage<\/em>/);
  assert.match(result.html, /Keep Asleep here/);
  assert.doesNotMatch(result.html, /Icon:|hidden.svg|sleep.svg|@UUID/);
  assert.deepEqual(result.warnings, []);
});

test("known non-Foundry notes and embeds are plain text; unresolved, ambiguous and missing items warn", () => {
  const notes = [note("Monster Balancing.md"), note("a/Tie.md"), note("b/Tie.md"), note("Listen/Weapons/Lost.md"), note("Listen/Spells/Air/Air.md", "Typ: Element")];
  const result = convert("[[Monster Balancing|Plain]] [[No note|Missing]] [[Tie|Ambiguous]] [[Lost]] ![[No embed|Picture]] [[Air]]", { notes });
  assert.match(result.html, /Plain Missing Ambiguous Lost Picture Air/);
  assert.equal(result.links, 0);
  assert.equal(result.warnings.length, 3);
  assert.match(result.warnings.join("\n"), /unresolved link "No note"/);
  assert.match(result.warnings.join("\n"), /ambiguous link "Tie"/);
  assert.match(result.warnings.join("\n"), /missing item "Lost" in weapons/);
  assert.equal(resolveHandbookNote("Name", [note("long/path/Name.md"), note("x/Name.md")]).note.path, "x/Name.md");
});

test("code is opaque and raw scripts, event handlers, dangerous HTML and executable markdown URLs are stripped", () => {
  const markdown = '# Page\n\n<script>alert("bad")</script>\n\n<img src=x onerror=alert(1)><br onclick="bad()">\n\n<svg onload=bad()>hidden</svg>\n\n[Bad](javascript:alert%281%29) [Encoded](jav&#x61;script:alert%281%29) [OK](https://example.test)\n\n`[[No note]] #magic`\n\n```text\n[[No note]] #magic\n```';
  const result = convert(markdown);
  assert.doesNotMatch(result.html, /<script|alert\(|onerror|onclick|<svg|onload|href="(?:javascript|jav&#)/);
  assert.match(result.html, /<br>/);
  assert.match(result.html, /href="https:\/\/example.test"/);
  assert.match(result.html, /<code>\[\[No note\]\] #magic<\/code>/);
  assert.match(result.html, /<pre><code class="language-text">\[\[No note\]\] #magic/);
  assert.deepEqual(result.warnings, []);
});

test("page tree order, nesting, explicit action names and stable IDs survive content edits and missing notes", () => {
  assert.deepEqual(HANDBOOK_PAGES.map(page => page.level), [1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 2, 3, 3, 2, 3]);
  assert.deepEqual(HANDBOOK_PAGES.map(page => page.path), [
    "Incarnos Handbook.md", "Rules/Rules Overview.md",
    ...["How To Play", "Character Creation", "Attributes And Stats", "List Of Actions", "Magic", "Level Table", "List Of Links"].map(name => `Rules/Discord Important (new)/${name}.md`),
    "Rules/Incarnos Rules.md", "Listen/Lists Overview.md",
    ...["Weapons", "Weapon Traits", "Talents", "Races", "Spells", "Conditions"].map(name => `Listen/${name}/${name} Overview.md`),
    "Listen/Actionlists/Action Lists Overview.md", "Listen/Actionlists/Incarnos_Actionlist_Recruit_v10.md", "Listen/Actionlists/Incarnos_Actionlist_Veteran_v10.md",
    "Listen/Tables/Tables Overview.md", "Listen/Tables/Critical Failures.md"
  ]);
  const notes = HANDBOOK_PAGES.map(page => note(page.path));
  const original = handbookToDocuments(notes);
  const decoded = unpackCompendiumSource(original.documents, "JournalEntry");
  assert.equal(decoded.documents.length, 1);
  assert.equal(decoded.documents[0].name, "Incarnos Handbook");
  assert.equal(original.pages, 22);
  assert.deepEqual(decoded.documents[0].pages.map(page => page.title), HANDBOOK_PAGES.map(page => ({ show: true, level: page.level })));
  assert.ok(decoded.documents[0].pages.every(page => page.type === "text" && page.text.format === 1));
  assert.equal(decoded.documents[0].pages[18].name, "Recruit Action List");
  assert.equal(decoded.documents[0].pages[19].name, "Veteran Action List");
  assert.ok(decoded.documents[0].pages.every((page, i) => page.sort === (i + 1) * 100000));
  notes[0].markdown = "# Changed title\n\nChanged body";
  const edited = handbookToDocuments(notes.slice(0, -1));
  assert.equal(edited.pages, 21);
  assert.equal(edited.warnings.length, 1);
  assert.deepEqual(edited.documents.map(doc => doc._id), original.documents.slice(0, -1).map(doc => doc._id));
  assert.equal(handbookPageId("System Files/Rules/Incarnos Rules.md"), handbookPageId("Rules/Incarnos Rules"));
  assert.equal(new Set(original.documents.map(doc => doc._id)).size, 23);
  assert.ok(original.documents.every(doc => /^[A-Za-z0-9]{16}$/.test(doc._id)));
});
