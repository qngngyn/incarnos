/** Pure vault-note conversion and JournalEntry source generation; no vault writes or Foundry globals. */
import { Marked } from "marked";
import { stableId } from "./spell-sheet.mjs";
import { parseConditionNote } from "./condition-notes.mjs";
import { parseTraitNote } from "./weapon-notes.mjs";
import { HANDBOOK_PAGES } from "./handbook-pages.mjs";

export const HANDBOOK_ID = stableId("handbook:Incarnos Handbook");
export const handbookPageId = path => stableId(`handbook:page:${notePath(path)}`);
const notePath = path => String(path).replace(/\\/g, "/").replace(/^System Files\//i, "").replace(/\.md$/i, "");
const noteName = path => notePath(path).split("/").at(-1);
const escapeHtml = text => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const itemPacks = { Weapons: "weapons", Talents: "talents", Races: "races", Spells: "spells" };
const channels = Object.fromEntries(HANDBOOK_PAGES.filter(page => page.path.startsWith("Rules/Discord Important (new)/"))
  .map(page => [noteName(page.path).toLowerCase().replace(/ /g, "-"), page.path]));

export function handbookTitle(markdown, path) {
  return (String(markdown).match(/^#\s+(.+)$/m)?.[1]?.trim() || noteName(path)).replace(/ \(new\)$/, "");
}

/** Resolve exact/full paths first, otherwise the shortest suffix under System Files. Equal best matches are ambiguous. */
export function resolveHandbookNote(target, notes) {
  const path = notePath(target.split("#")[0].trim());
  const exact = notes.find(note => notePath(note.path).toLowerCase() === path.toLowerCase());
  if (exact) return { note: exact };
  if (/^System Files\//i.test(target)) return { warning: `unresolved link "${target}"` };
  const matches = notes.filter(note => notePath(note.path).toLowerCase().endsWith(`/${path.toLowerCase()}`))
    .sort((a, b) => notePath(a.path).length - notePath(b.path).length);
  if (!matches.length) return { warning: `unresolved link "${target}"` };
  if (matches[1] && notePath(matches[0].path).length === notePath(matches[1].path).length) return { warning: `ambiguous link "${target}"` };
  return { note: matches[0] };
}

/** Remove only the note chrome; Discord's subsequent H1s are message headings. */
export function prepareHandbookNote(markdown, { discord = false } = {}) {
  let text = String(markdown).replace(/\r/g, "").replace(/^\uFEFF/, "").trimStart()
    .replace(/^# [^\n]*(?:\n|$)/, "").trimStart().replace(/^↑[^\n]*(?:\n|$)/, "");
  if (discord) {
    text = text.split(/^[ \t]*---[ \t]*$/m).filter(block => !block.includes("@everyone")).join("\n\n")
      .replace(/^Channel:.*\n?/gm, "").replace(/^Each block between two lines.*\n?/gm, "")
      .replace(/^# /gm, "## ");
  }
  return text.trim();
}

// Raw HTML has no attributes and no executable elements. Markdown's own escaping stays with marked.
// Keeping a deliberately small raw-tag vocabulary also rules out SVG, event handlers, CSS and iframe tricks.
function safeRawHtml(text) {
  return text.replace(/<(script|style|iframe|object|svg|math)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, "")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<[^>]*(?:>|$)/g, tag => {
      const match = tag.match(/^<(\/?)(br|sub|sup|u|s|del|kbd)\b[^>]*>$/i);
      return match ? `<${match[1]}${match[2].toLowerCase()}>` : "";
    });
}

/** Convert one page. Notes and item sources are supplied by the caller, making conversion deterministic and testable. */
export function convertHandbookNote(markdown, { path, notes = [], pages = HANDBOOK_PAGES, items = {}, journalId = HANDBOOK_ID } = {}) {
  const warnings = [];
  let links = 0, secret = 0;
  const pagePaths = new Set(pages.map(page => notePath(page.path)));
  const warn = message => warnings.push(`${path}: ${message}`);
  const uuid = (id, label) => { links++; return `@UUID[${id}]{${escapeHtml(label).replace(/}/g, "&#125;")}}`; };
  const resolve = target => {
    const result = resolveHandbookNote(target, notes);
    if (result.warning) warn(result.warning);
    return result.note;
  };
  const rule = note => {
    if (!/^Listen\/(Conditions|Weapon Traits)\//.test(notePath(note.path))) return null;
    const clean = note.markdown.split(/\r?\n/).filter(line => !/^\s*Icon:/i.test(line)).join("\n").trim();
    if (!/^[^:\n]+:/.test(clean)) return null;
    if (note.path.includes("/Conditions/")) {
      const { condition } = parseConditionNote(clean, noteName(note.path));
      return condition && { name: condition.name, text: condition.description };
    }
    return { name: clean.slice(0, clean.indexOf(":")).trim(), text: parseTraitNote(clean) };
  };
  const wiki = (target, label, embed = false, resolved) => {
    if (embed) return escapeHtml(label);
    const note = resolved === undefined ? resolve(target) : resolved;
    if (!note) return escapeHtml(label);
    const key = notePath(note.path);
    if (pagePaths.has(key)) return uuid(`Compendium.incarnos.handbook.JournalEntry.${journalId}.JournalEntryPage.${handbookPageId(key)}`, label);
    const pack = itemPacks[key.match(/^Listen\/([^/]+)\//)?.[1]];
    // Element notes describe compendium folders, not Item documents.
    if (pack && !/^Typ:\s*Element\s*$/m.test(note.markdown)) {
      const name = note.markdown.match(/^title:\s*#*\s*(.+)$/m)?.[1]?.trim() || noteName(key);
      const matches = (items[pack] ?? []).filter(item => item._key?.startsWith("!items!") && item.name === name);
      if (matches.length === 1) return uuid(`Compendium.incarnos.${pack}.Item.${matches[0]._id}`, label);
      warn(`${matches.length ? "ambiguous item" : "missing item"} "${name}" in ${pack}`);
    }
    return escapeHtml(label);
  };
  const parser = new Marked();
  // Reject executable URL schemes even when disguised with HTML entities or whitespace.
  const safeUrl = href => {
    const decoded = href.replace(/&#(x[\da-f]+|\d+);?/gi, (_, code) => {
      const value = code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : +code;
      return value <= 0x10ffff ? String.fromCodePoint(value) : "";
    })
      .replace(/&colon;/gi, ":").replace(/&(Tab|NewLine);/gi, "").replace(/[\s\u0000-\u001f]/g, "");
    return !/^[\w+.-]+:/.test(decoded) || /^(https?|mailto):/i.test(decoded);
  };
  parser.use({ renderer: {
    html: token => safeRawHtml(token.text),
    link(token) {
      const text = this.parser.parseInline(token.tokens);
      return safeUrl(token.href) ? `<a href="${escapeHtml(token.href)}"${token.title ? ` title="${escapeHtml(token.title)}"` : ""}>${text}</a>` : text;
    },
    image: token => escapeHtml(token.text) // Embedded assets are labels, never copied out of the vault.
  } });
  const replacements = [];
  const placeholder = (html, block = false) => {
    const key = `ISCHB${block ? "BLOCK" : "PLACEHOLDER"}${replacements.length}END`;
    replacements.push([key, html]);
    return key;
  };
  parser.use({ extensions: [{ name: "handbookBlock", level: "block",
    start: text => text.indexOf("ISCHBBLOCK"),
    tokenizer(text) {
      const match = text.match(/^ISCHBBLOCK\d+END(?:\n|$)/);
      if (match) return { type: "handbookBlock", raw: match[0], text: match[0].trim() };
    },
    renderer: token => token.text
  }] });
  const render = text => {
    // Fences and inline code are opaque: examples of [[links]] and #channels must remain literal code.
    const prepared = text.replace(/(^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\2[ \t]*$)|(`+)[\s\S]*?\3|^([ \t]*(?:[-+*]|\d+[.)])\s+)!?\[\[([^\]\n]+)\]\][ \t]*$|(!?)\[\[([^\]\n]+)\]\]|(?<![\w/])#(how-to-play|character-creation|attributes-and-stats|list-of-actions|magic|level-table|list-of-links)\b/gm,
      (raw, fence, fenceMark, code, list, listLink, embed, inlineLink, channel) => {
        if (fence || code) {
          const callout = fence?.match(/^[ \t]*(`{3,}|~{3,})ad-(note|check|example|quote|success|warning)[ \t]*\n([\s\S]*?)\n[ \t]*\1[ \t]*$/);
          if (!callout) return raw;
          const [, , kind, body] = callout;
          const titleLine = body.match(/^title:[ \t]*(.*)(?:\n|$)/i);
          const title = titleLine?.[1]?.trim() || kind[0].toUpperCase() + kind.slice(1);
          let html = `<aside class="isc-callout isc-callout-${kind}"><p class="isc-callout-title">${escapeHtml(title)}</p>${render(titleLine ? body.slice(titleLine[0].length) : body)}</aside>`;
          if (/^GM only/i.test(title)) html = `<section class="secret" id="secret-${stableId(`handbook:secret:${path}:${secret++}`)}">${html}</section>`;
          return `\n\n${placeholder(html, true)}\n\n`;
        }
        // The link reads as the page name ("Character Creation"), not the Discord channel.
        if (channel) return placeholder(wiki(channels[channel], noteName(channels[channel])));
        const value = listLink ?? inlineLink;
        const [target, ...alias] = value.split("|");
        const label = alias.length ? alias.join("|") : noteName(target.split("#")[0]);
        const embedded = embed === "!" || (list && raw.trimStart().replace(/^(?:[-+*]|\d+[.)])\s+/, "").startsWith("!"));
        if (list && !embedded) {
          const note = resolve(target);
          const inline = note && rule(note);
          if (inline) return `${list}${placeholder(`<strong>${escapeHtml(inline.name)}:</strong> ${render(inline.text).replace(/^<p>|<\/p>\s*$/g, "")}`)}`;
          return `${list}${placeholder(wiki(target, label, false, note ?? null))}`;
        }
        return `${list ?? ""}${placeholder(wiki(target, label, embedded))}`;
      });
    let html = parser.parse(prepared);
    // Recursive callouts may contain earlier placeholders; reverse order expands each exactly once.
    for (const [key, value] of [...replacements].reverse()) html = html.replaceAll(key, () => value);
    return html;
  };
  const content = render(prepareHandbookNote(markdown, { discord: /^Rules\/Discord Important \(new\)\//.test(path) }))
    .replace(/<table>/g, '<div class="isc-table-scroll"><table>').replace(/<\/table>/g, "</table></div>");
  return { html: `<div class="isc-handbook">${content}</div>`, links, warnings: [...new Set(warnings)] };
}

/** One journal with separate LevelDB page records, just like actors' embedded items. Missing pages are skipped. */
export function handbookToDocuments(notes, items = {}, { pages = HANDBOOK_PAGES } = {}) {
  const warnings = [], pageRecords = [];
  let links = 0;
  const available = pages.filter(page => {
    const exists = notes.some(note => notePath(note.path) === notePath(page.path));
    if (!exists) warnings.push(`Missing handbook note: ${page.path}`);
    return exists;
  });
  for (const [index, page] of available.entries()) {
    const note = notes.find(note => notePath(note.path) === notePath(page.path));
    const result = convertHandbookNote(note.markdown, { path: page.path, notes, items, pages: available });
    links += result.links;
    warnings.push(...result.warnings);
    const id = handbookPageId(page.path);
    pageRecords.push({ _id: id, _key: `!journal.pages!${HANDBOOK_ID}.${id}`,
      name: page.name ?? handbookTitle(note.markdown, page.path), type: "text", title: { show: true, level: page.level },
      text: { format: 1, content: result.html }, sort: (index + 1) * 100000, flags: {} });
  }
  return { documents: [{ _id: HANDBOOK_ID, _key: `!journal!${HANDBOOK_ID}`, name: "Incarnos Handbook",
    pages: pageRecords.map(page => page._id), folder: null, sort: 0, ownership: { default: 2 }, flags: {} }, ...pageRecords],
  pages: pageRecords.length, links, warnings };
}
