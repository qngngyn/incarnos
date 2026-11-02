import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupName, backupTime, createBackup, keepBackups, pruneBackups } from "../tools/backup.mjs";
import { buildXlsx } from "../tools/xlsx.mjs";

const DAY = 24 * 60 * 60 * 1000;
const start = new Date(2026, 0, 1, 20, 0, 0).getTime();

/** Run the keep rule after every simulated update and return the ages (days) kept after each one. */
function simulate(times) {
  let backups = [];
  const history = [];
  for (const time of times) {
    backups.push({ name: backupName(new Date(time)), time });
    const keep = keepBackups(backups, time);
    backups = backups.filter(backup => keep.has(backup.name));
    history.push({ time, ages: backups.map(backup => (time - backup.time) / DAY).sort((a, b) => a - b) });
  }
  return history;
}

test("backup names round-trip to their time; other folder names are ignored", () => {
  const date = new Date(2026, 10, 1, 9, 5, 3);
  assert.equal(backupName(date), "2026-11-01_09-05-03");
  assert.equal(backupTime("2026-11-01_09-05-03"), date.getTime());
  assert.equal(backupTime("my files"), null);
  assert.equal(backupTime("2026-11-01_09-05-03.partial"), null);
});

test("daily updates keep 3–4 backups: the 2 newest, one at least a week old and one 30–60 days old", () => {
  const history = simulate(Array.from({ length: 150 }, (_, day) => start + day * DAY));
  for (const { ages } of history) assert.ok(ages.length <= 4, `kept ${ages.length}`);
  for (const { ages } of history.slice(40)) {
    assert.ok(ages.length >= 3, `kept ${ages}`);
    assert.ok(ages.some(age => age >= 7), `no week-old backup in ${ages}`);
    assert.ok(ages.some(age => age >= 30 && age <= 60), `no month-old backup in ${ages}`);
    assert.deepEqual(ages.slice(0, 2), [0, 1]);
  }
});

test("bursts and long gaps never keep more than 4 and always keep the newest", () => {
  const times = [];
  for (let day = 0; day < 120; day += day % 10 === 0 ? 9 : 1) for (let run = 0; run < (day % 3) + 1; run++) times.push(start + day * DAY + run * 60000);
  for (const { ages } of simulate(times)) {
    assert.ok(ages.length <= 4);
    assert.equal(ages[0], 0);
  }
});

test("pruning deletes only backup folders that are not kept, plus unfinished ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "incarnos-backups-"));
  try {
    const now = start + 100 * DAY;
    for (const days of [0, 1, 2, 3, 10, 20, 35, 70]) mkdirSync(join(dir, backupName(new Date(now - days * DAY))));
    mkdirSync(join(dir, `${backupName(new Date(now - 5 * DAY))}.partial`));
    mkdirSync(join(dir, "keep me"));
    const { kept, deleted } = pruneBackups(dir, now);
    // 0 and 1 (newest), 20 (oldest < 30 days, growing into the month slot; also the week backup), 35 (newest >= 30 days).
    assert.deepEqual(kept.map(name => Math.round((now - backupTime(name)) / DAY)).sort((a, b) => a - b), [0, 1, 20, 35]);
    assert.equal(deleted.length, 5);
    assert.ok(existsSync(join(dir, "keep me")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("xlsx export is a valid zip with one worksheet per list", () => {
  const xlsx = buildXlsx([{ name: "Spells", rows: [["Name", "Effect"], ["Luck of the Draw", "1 - Ace & <more>"]] }, { name: "Weird/Name?", rows: [["A"]] }]);
  const entries = new Map();
  for (let offset = 0; xlsx.readUInt32LE(offset) === 0x04034b50;) {
    const size = xlsx.readUInt32LE(offset + 18);
    const nameLength = xlsx.readUInt16LE(offset + 26);
    const name = xlsx.toString("utf8", offset + 30, offset + 30 + nameLength);
    const start = offset + 30 + nameLength;
    entries.set(name, xlsx.toString("utf8", start, start + size));
    offset = start + size;
  }
  assert.ok(entries.has("[Content_Types].xml"));
  assert.match(entries.get("xl/workbook.xml"), /name="Spells".*name="Weird Name"/);
  assert.match(entries.get("xl/worksheets/sheet1.xml"), /1 - Ace &amp; &lt;more&gt;/);
});

test("a backup copies the vault without .git/.obsidian and writes the Excel lists and a README", () => {
  const dir = mkdtempSync(join(tmpdir(), "incarnos-backup-"));
  try {
    const vault = join(dir, "vault");
    mkdirSync(join(vault, ".git"), { recursive: true });
    mkdirSync(join(vault, ".obsidian"), { recursive: true });
    mkdirSync(join(vault, "System Files", "Listen", "Weapon Traits"), { recursive: true });
    writeFileSync(join(vault, ".git", "HEAD"), "x");
    writeFileSync(join(vault, ".obsidian", "app.json"), "{}");
    writeFileSync(join(vault, "System Files", "Listen", "Weapon Traits", "Parry.md"), "Parry: +1 Parry");
    const backups = join(dir, "backups");
    const result = createBackup({ vault, backupDir: backups, now: new Date(start) });
    assert.equal(result.files, 1);
    assert.deepEqual(readdirSync(join(result.path, "vault")), ["System Files"]);
    assert.ok(existsSync(join(result.path, "Incarnos Lists.xlsx")));
    assert.ok(existsSync(join(result.path, "foundry", "packs-source")));
    assert.match(readFileSync(join(result.path, "README.txt"), "utf8"), /Weapon Traits 1/);
    const second = createBackup({ vault, backupDir: backups, now: new Date(start) });
    assert.notEqual(second.name, result.name, "two backups in the same second both survive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
