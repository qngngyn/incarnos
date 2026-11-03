/**
 * Shared chat card layout for every Incarnos roll (spells, weapon attacks, checks, contests).
 * Pure HTML rendering, no Foundry calls, so all cards look alike and can be tested.
 *
 *   header  — icon (image or Font Awesome), title, small tags, optional chip on the right
 *   facts   — one muted line
 *   effect  — optional, always-visible rules HTML under the facts
 *   rows    — portrait, name, outcome chips, big number(s), optional buttons
 *   footer  — small notes (roll formulas, hints) · optional full-width action
 *   details — folded text ("Flavour", "Weapon text")
 */
import { rollUnderSucceeds } from "./spells.mjs";

export const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

/** Font Awesome icon per damage type; unknown types get a generic burst. */
const DAMAGE_ICONS = {
  fire: "fa-fire", water: "fa-droplet", air: "fa-wind", earth: "fa-mountain", thunder: "fa-bolt", lightning: "fa-bolt",
  blood: "fa-droplet", poison: "fa-skull-crossbones", light: "fa-sun", dark: "fa-moon", darkness: "fa-moon",
  shadow: "fa-moon", necrotic: "fa-skull", psychic: "fa-brain", sleep: "fa-bed", physical: "fa-hand-fist",
  piercing: "fa-crosshairs", slashing: "fa-khanda", blunt: "fa-hammer"
};
export const damageIcon = type => DAMAGE_ICONS[String(type ?? "").toLowerCase()] ?? "fa-burst";

/** A small coloured label. tone: good | bad | crit | note | info. */
export function chip(text, { tone = "note", title = "", small = "" } = {}) {
  return `<span class="isc-chip isc-${tone}"${title ? ` title="${escape(title)}"` : ""}>${escape(text)}${small !== "" ? ` <small>${escape(small)}</small>` : ""}</span>`;
}

/**
 * Chip for a roll-under d20 check: pass/fail, gold on a crit, rolled/needed numbers, explanation on hover.
 * `check.success` / `check.crit` override the plain roll-under result (weapon traits such as Critical Strike, Poor Precision).
 */
export function checkChip(check, { pass, fail, label }) {
  if (!check) return "";
  const success = check.success ?? rollUnderSucceeds(check.d20, check.threshold);
  const crit = check.crit ?? check.d20 === 1;
  let text = success ? pass : fail;
  let tone = success ? "good" : "bad";
  if (crit && success) { text = `${pass} · ${check.d20 === 1 ? "nat 1" : "crit"}`; tone = "crit"; }
  if (check.d20 === 20 && !success) text = `${fail} · nat 20`;
  return chip(text, { tone, small: `${check.d20}/${check.threshold}`, title: `${label}: rolled ${check.d20}, needed ${check.threshold} or less${crit && check.d20 !== 1 ? " (crit range)" : ""}` });
}

/** Placeholder chip while the dice are still rolling. */
export const rollingChip = () => chip("Rolling…", { tone: "note" });

/** Big number. kind: damage | heal | roll. */
export function amount(value, { kind = "roll", type = "", title = "" } = {}) {
  const icon = kind === "heal" ? "fa-heart" : kind === "damage" ? damageIcon(type) : "fa-dice-d20";
  return `<span class="isc-amount isc-${kind}"${title ? ` title="${escape(title)}"` : ""}><i class="fas ${icon}"></i>${escape(value)}</span>`;
}

/** GM Apply button; the chat hook turns it into a check once applied and removes it for players. */
export function applyButton(kind, index, value) {
  const verb = kind === "heal" ? `Heal ${value}` : kind === "conditions" ? `Apply ${value}` : `Apply ${value} damage`;
  const icon = kind === "heal" ? "fa-heart-circle-plus" : kind === "conditions" ? "fa-circle-exclamation" : "fa-heart-crack";
  return `<button type="button" class="isc-apply isc-apply-${kind}" data-incarnos-spell-apply="${kind}" data-index="${index}" title="${escape(verb)}">`
    + `<i class="fas ${icon}"></i></button>`;
}

export const applyAllButton = () => `<button type="button" class="isc-apply-all" data-incarnos-spell-apply="all"><i class="fas fa-check-double"></i> Apply all</button>`;

/** Manual opt-in on natural-20 attack cards; the chat hook checks actor ownership. */
export const criticalFailureButton = (label = "Critical failure") => `<button type="button" class="isc-critical-failure" data-incarnos-critical-start><i class="fas fa-dice-d20"></i> ${escape(label)}</button>`;

/** Each attack of a multi-attack spell, without Apply buttons (the target's total is applied once). */
export function renderAttackDetails(attacks, { attackLabel = "Attack", saveLabel = "Save", damageType = "" } = {}) {
  return `<div class="isc-detail">${attacks.map((hit, index) => {
    const label = `Attack ${index + 1}`;
    const damage = hit.damageRoll;
    const damageTitle = damage ? `${damage.formula}: ${damage.result} = ${damage.total}${hit.crit ? " (dice maxed)" : ""}` : "No damage";
    return `<div>${checkChip(hit.attack, { pass: `${label}: Hit`, fail: `${label}: Miss`, label: `${attackLabel}, ${label}` })}`
      + (hit.save ? ` ${checkChip(hit.save, { pass: "Saved", fail: "Failed save", label: hit.save.advantage ? `${saveLabel} with advantage (${hit.save.advantage})` : saveLabel })}` : "")
      + ` <span title="${escape(damageTitle)}">${escape(hit.damage)}${damageType ? ` ${escape(damageType)}` : ""} damage${hit.crit && damage ? " (dice maxed)" : ""}</span></div>`;
  }).join("")}</div>`;
}

/**
 * @param {object} card
 * @param {string} [card.img]       Header image (item icon).
 * @param {string} [card.icon]      Font Awesome class when there is no image, e.g. "fa-dice-d20".
 * @param {string} card.title
 * @param {string} [card.tags]      Small line under the title.
 * @param {string} [card.chip]      Chip HTML on the right of the header.
 * @param {string} [card.facts]     One muted line under the header.
 * @param {string} [card.effect]    Rules HTML (including its label), visible above the rows.
 * @param {{img?:string, name:string, chips?:string[], values?:string[], dim?:boolean, attacks?:object[]}[]} [card.rows]
 * @param {string} [card.empty]     Text when there are no rows.
 * @param {string[]} [card.notes]   Small footer notes (HTML).
 * @param {string} [card.action]    Full-width button HTML under the notes.
 * @param {{summary:string, html:string, open?:boolean}} [card.details]
 * @param {string} [card.cls]       Extra class on the card.
 */
export function renderRollCard({ img, icon, title, tags = "", chip: headChip = "", facts = "", effect = "", rows = [], empty = "", notes = [], action = "", details = null, cls = "", hint = "" }) {
  const visual = img ? `<img class="isc-icon" src="${escape(img)}" alt="">` : icon ? `<span class="isc-icon isc-glyph"><i class="fas ${icon}"></i></span>` : "";
  const head = `<header class="isc-head"${hint ? ` title="${escape(hint)}"` : ""}>${visual}`
    + `<div class="isc-title"><span class="isc-name">${title}</span>${tags ? `<span class="isc-tags">${tags}</span>` : ""}</div>`
    + `${headChip}</header>`
    + (facts ? `<div class="isc-facts">${facts}</div>` : "");
  const body = rows.length
    ? `<ol class="isc-targets">${rows.map(row => `<li class="isc-target${row.dim ? " isc-missed" : ""}">`
      + (row.img ? `<img class="isc-portrait" src="${escape(row.img)}" alt="">` : "")
      + `<div class="isc-who"><span class="isc-tname">${escape(row.name)}</span>${row.chips?.filter(Boolean).length ? `<span class="isc-chips">${row.chips.filter(Boolean).join("")}</span>` : ""}`
      + (row.attacks?.length ? renderAttackDetails(row.attacks, row) : "")
      + `${row.detail ? `<span class="isc-detail">${escape(row.detail)}</span>` : ""}</div>`
      + `<div class="isc-outcome">${row.values?.length ? row.values.join("") : ""}</div></li>`).join("")}</ol>`
    : empty ? `<p class="isc-empty">${escape(empty)}</p>` : "";
  const footer = (notes.filter(Boolean).length ? `<div class="isc-rolls">${notes.filter(Boolean).join("")}</div>` : "") + action;
  const folded = details?.html ? `<details class="isc-text"${details.open ? " open" : ""}><summary>${escape(details.summary)}</summary>${details.html}</details>` : "";
  return `<div class="incarnos-spell-card${cls ? ` ${cls}` : ""}">${head}${effect ? `<div class="isc-effect-block">${effect}</div>` : ""}${body}${footer}${folded}</div>`;
}

/**
 * Stat check, saving throw or Parry roll: one row with the roller, the outcome chip and the d20.
 * Parry has no fixed target (the GM announces the attack modifier), so it shows the value to compare against.
 * @param {{name:string, img?:string}} roller
 * @param {"ability"|"save"|"parry"} kind
 * @param {string} statLabel   e.g. "Strength"; ignored for Parry.
 * @param {number} value       Stat, save or Parry value to roll under.
 * @param {number} d20
 * @param {boolean} [pending]
 * @param {{source: string, dice: number[], low?: boolean}} [advantage]  Rolled several d20: kept the lower (advantage, e.g. a talent's
 *   save advantage), or the higher when low is false (disadvantage, e.g. Prone against melee).
 * @param {{source: string, value: number}} [bonus]  Already included in value (e.g. a race's save bonus); shown as a tag.
 * @param {{label: string, d20: number}[]} [cases]  Several readings of one roll (e.g. Prone Parry vs melee / vs ranged).
 * @param {string} [casesTag]  What caused the cases, shown as a tag.
 */
export function renderCheckCard({ roller, kind, statLabel = "", value, d20, pending = false, advantage = null, bonus = null, cases = null, casesTag = "", title: actionTitle = "", notes = [] }) {
  const title = actionTitle || (kind === "parry" ? "Parry" : kind === "save" ? `${statLabel} save` : `${statLabel} check`);
  const icon = kind === "parry" ? "fa-shield" : kind === "save" ? "fa-shield-halved" : "fa-dice-d20";
  const parryChip = (roll, label = "Apply GM modifier") => chip(label, { tone: "note", small: `${roll} vs ${value}`, title: `Parry: rolled ${roll}; succeeds if ${roll} ≤ ${value} + the attack modifier the GM announces` });
  const chips = pending ? [rollingChip()] : cases?.length ? cases.map(item => parryChip(item.d20, item.label))
    : kind === "parry" ? [parryChip(d20)]
    : [checkChip({ d20, threshold: value }, { pass: "Success", fail: "Fail", label: title })];
  const diceText = advantage?.dice?.length ? `d20s: ${advantage.dice.join(", ")}, kept ${d20}` : `d20: ${d20}`;
  const values = pending ? [] : cases?.length ? cases.map(item => amount(item.d20, { kind: "roll", title: `${item.label}: ${item.d20}` })) : [amount(d20, { kind: "roll", title: diceText })];
  return renderRollCard({
    icon, title: escape(title),
    tags: escape([advantage ? `${advantage.low === false ? "Disadvantage" : "Advantage"} · ${advantage.source}` : "", casesTag, bonus ? `${bonus.value < 0 ? bonus.value : `+${bonus.value}`} · ${bonus.source}` : ""].filter(Boolean).join(", ")),
    chip: chip(`≤ ${value}`, { tone: "info", title: `Needs ${value} or less` }),
    rows: [{ img: roller.img, name: roller.name, chips, values }],
    notes: notes.map(note => `<span>${escape(note)}</span>`)
  });
}

/**
 * Contest board: both sides of one contest round on one card, updated as each side rolls.
 * Side state: "waiting" (a Roll button for whoever may roll it) · "rolling" · "done" (total shown).
 * @param {object} board
 * @param {string} board.stat        Attacker's stat, for the title.
 * @param {number} [board.round]     1 for the first roll, 2+ for tie rerolls.
 * @param {object[]} board.sides     { key: "attack"|"save", name, img, stat, value, die, state, total }
 * @param {{winner: "attack"|"defender"|null, tie?: boolean}|null} [board.outcome]
 * @param {boolean} [board.cancelled]
 * @param {boolean} [board.canCancel] Show the GM's Cancel button while unresolved.
 */
export function renderContestBoard({ stat = "", round = 1, sides = [], outcome = null, cancelled = false, canCancel = true, note = "", actionTitle = "", applied = "", choices = [] }) {
  const rule = "Each side rolls d(20 − stat), at least d2. Lower total wins; a tie means both roll again.";
  const [first, second] = sides;
  const versus = second ? `${escape(first.name)} vs ${escape(second.name)}` : "";
  const winnerKey = outcome?.winner === "attack" ? "attack" : outcome?.winner === "defender" ? "save" : null;
  const winner = sides.find(side => side.key === winnerKey);
  const resultTitle = cancelled ? "Contest cancelled" : outcome?.tie ? "Tie! Both roll again" : winner ? `${escape(winner.name)} wins!` : `${escape(stat || first?.stat || "")} contest`;
  const title = actionTitle ? `${escape(actionTitle)}${cancelled || outcome ? ` · ${resultTitle}` : ""}` : resultTitle;
  const rows = sides.map(side => {
    const roleText = side.key === "attack" ? "Attack" : "Save";
    const dieText = Number.isInteger(side.die) ? `d${side.die} = d(20 − ${side.value}). Lower total wins.` : "";
    const chips = [];
    if (side.state === "waiting") {
      chips.push(chip(cancelled ? "Not rolled" : "Waiting", { tone: "note", title: dieText }));
    } else if (side.state === "rolling") {
      chips.push(rollingChip());
    } else {
      chips.push(chip(roleText, { tone: "note", small: `${side.stat} ${side.value}`, title: `${roleText}: ${side.stat} ${side.value}, rolled ${dieText}` }));
      if (outcome?.tie) chips.push(chip("Tie", { tone: "note", title: rule }));
      else if (winnerKey) chips.push(winnerKey === side.key ? chip("Winner", { tone: "good", title: "Lower total wins" }) : chip("Lost", { tone: "bad", title: "Lower total wins" }));
    }
    const values = side.state === "done" ? [amount(side.total, { kind: "roll", title: dieText })]
      : side.state === "waiting" && !cancelled ? [`<button type="button" class="isc-contest-roll" data-incarnos-contest-roll="${side.key}" title="Roll ${roleText.toLowerCase()}${side.stat ? ` (${escape(side.stat)})` : ""}"><i class="fas fa-dice-d20"></i> Roll</button>`]
      : [];
    return { img: side.img, name: side.name, chips, values, dim: Boolean(cancelled || (winnerKey && winnerKey !== side.key)) };
  });
  const resolved = cancelled || outcome;
  return renderRollCard({
    icon: cancelled ? "fa-ban" : outcome?.tie ? "fa-equals" : winner ? "fa-trophy" : "fa-scale-balanced",
    title, tags: versus,
    chip: round > 1 ? chip(`Round ${round}`, { tone: "info", title: "Reroll after a tie" }) : "",
    rows,
    action: choices.length ? choices.map(choice => `<button type="button" class="isc-contest-choice" data-incarnos-shove="${escape(choice.id)}">${escape(choice.label)}</button>`).join("") : !resolved && canCancel ? `<button type="button" class="isc-contest-cancel" data-incarnos-contest-cancel title="GM: end this contest without a result"><i class="fas fa-ban"></i> Cancel contest</button>` : "",
    notes: [note, applied].filter(Boolean).map(text => `<span>${escape(text)}</span>`),
    hint: rule,
    cls: "isc-contest"
  });
}
