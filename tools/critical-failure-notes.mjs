/** Pure parser and compendium sources for the vault's Critical Failures.md. */
import { stableId } from "./spell-sheet.mjs";
import { CRITICAL_FAILURE_SEVERITIES, criticalFailureTableName } from "../module/helpers/critical-failure-rules.mjs";

/** Read three tables of Name | Weapon attack | Spell attack; row counts never affect severity. */
export function parseCriticalFailureNote(markdown) {
  const tables = [];
  let table = null;
  for (const line of String(markdown ?? "").replace(/\r/g, "").split("\n")) {
    const heading = /^##\s+(.+?)\s*\((\d+)\s*%\)\s*$/.exec(line.trim());
    if (/^##\s/.test(line)) table = null;
    if (heading) {
      const severity = CRITICAL_FAILURE_SEVERITIES.find(entry => entry.name.toLowerCase() === heading[1].toLowerCase());
      if (!severity) continue;
      if (Number(heading[2]) !== severity.chance) throw new Error(`${severity.name}: expected ${severity.chance} %`);
      if (tables.some(entry => entry.id === severity.id)) throw new Error(`Duplicate severity ${severity.name}`);
      table = { ...severity, rows: [] };
      tables.push(table);
      continue;
    }
    if (!table || !line.trim().startsWith("|")) continue;
    const cells = line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, "|"));
    if (cells[0] === "Name" || cells.every(cell => /^:?-+:?$/.test(cell))) continue;
    if (cells.length !== 3 || cells.some(cell => !cell)) throw new Error(`${table.name}: invalid table row`);
    const [name, weapon, spell] = cells;
    if (table.rows.some(row => row.name === name)) throw new Error(`${table.name}: duplicate row ${name}`);
    table.rows.push({ name, weapon, spell: /^Same\.$/i.test(spell) ? weapon : spell });
  }
  for (const severity of CRITICAL_FAILURE_SEVERITIES) {
    if (!tables.find(table => table.id === severity.id)?.rows.length) throw new Error(`Missing or empty table: ${severity.name}`);
  }
  return tables;
}

/** LevelDB records: RollTables plus their embedded TableResults (Foundry v14 description field). */
export function criticalFailuresToDocuments(tables) {
  return tables.flatMap(table => ["weapon", "spell"].flatMap(kind => {
    const name = criticalFailureTableName(table.id, kind);
    const id = stableId(`critical-failure:${name}`);
    const results = table.rows.map((row, index) => {
      const resultId = stableId(`critical-failure:${name}:${row.name}`);
      return {
        _id: resultId, _key: `!tables.results!${id}.${resultId}`, type: "text", name: row.name,
        description: `**${row.name}:** ${row[kind]}`, img: "icons/svg/d20-black.svg",
        weight: 1, range: [index + 1, index + 1], drawn: false, flags: {}
      };
    });
    return [{
      _id: id, _key: `!tables!${id}`, name, img: "icons/svg/d20-black.svg", description: "",
      formula: `1d${results.length}`, replacement: true, displayRoll: true, results: results.map(result => result._id),
      folder: null, sort: 0, ownership: { default: 2 },
      flags: { incarnos: { criticalFailureTable: { severity: table.id, kind, chance: table.chance } } }
    }, ...results];
  }));
}

/** Small system macro pack, regenerated alongside the tables. */
export function criticalFailureMacroDocuments() {
  const id = stableId("macro:Critical Failure");
  return [{
    _id: id, _key: `!macros!${id}`, name: "Critical Failure", type: "script", img: "icons/magic/control/silhouette-fall-slip-prone.webp",
    scope: "global", command: "await game.incarnos.criticalFailure();", folder: null, sort: 0,
    ownership: { default: 2 }, flags: {}
  }];
}
