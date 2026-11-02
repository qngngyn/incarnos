/**
 * Contests. Each round has one visible contest board (a chat card showing both sides); defender requests
 * and their responses are hidden chat documents so the GM can authorize player responses.
 *
 * Board content is written by one client only (the active GM, or the board's author when no GM is online),
 * queued per board and always rendered from the current data, so concurrent updates cannot overwrite each other.
 * Anyone whose side is still open gets a Roll button on the board (resume after a disconnect); the GM can cancel.
 */
import { renderContestBoard } from "./roll-card.mjs";
export const CONTEST_STATS = { Strength: "str", Dexterity: "dex", Constitution: "con", Willpower: "wis", Perception: "prc", Speed: "spd", Intelligence: "int", Charisma: "cha" };
/** Contest improvements stop at d2; invalid stat values cannot produce a roll. */
export function getContestDie(value) {
  const stat = Number(value);
  return Number.isInteger(stat) ? Math.max(2, 20 - stat) : NaN;
}
let dialogQueue = Promise.resolve();
let dialogSequence = 0;

/** Keep contest modals separate and open just one at a time on each client. */
export function showContestDialog(method, options, beforeOpen = () => true) {
  const result = dialogQueue.then(async () => {
    if (!await beforeOpen()) return null;
    return foundry.applications.api.DialogV2[method]({
      ...options, id: `incarnos-contest-dialog-${++dialogSequence}`
    });
  });
  // A closed or failed dialog must never prevent later requests from opening.
  dialogQueue = result.catch(() => {});
  return result;
}

/** Unresolved contests younger than this are picked up again after a reload or reconnect. */
const RESUME_WINDOW = 12 * 60 * 60 * 1000;
const processing = new Set();
const rolling = new Set();
const submitted = new Set();
const prompted = new Set();
const resolvingTies = new Set();
const revealed = new Set();
const boardQueues = new Map();
const requestData = message => message?.flags?.incarnos?.contestRequest;
const boardData = message => message?.flags?.incarnos?.contestBoard;
const requestAuthor = message => game.users.get(requestData(message)?.requestAuthorId) ?? message.author;
const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const activeGM = () => [...game.users].filter(user => user.active && user.isGM).sort((a, b) => a.id.localeCompare(b.id))[0];
const owns = (actor, user) => Boolean(user && (user.isGM || actor?.testUserPermission(user, "OWNER")));
const allMessages = () => [...(game.messages?.values?.() ?? [])];
const isRecent = message => Date.now() - Number(message?.timestamp ?? 0) < RESUME_WINDOW;

/** HTML-safe matchup label used in request popups. */
export function formatContestMatchup(attacker, defender) {
  const attackName = `<span style="color: #c62828">${escape(attacker)}</span>`;
  return defender ? `${attackName} vs. <span style="color: #2e7d32">${escape(defender)}</span>` : attackName;
}

/** Resolve the targeted player's assigned character before the attack dialog opens. */
export function getContestDefender(attacker) {
  const targets = [...(game.user?.targets ?? [])];
  if (targets.length > 1) return { error: "Target only one defender for a contest." };
  const token = targets[0];
  if (!token?.actor) return { error: "Target a defender token before rolling an attack contest." };
  if (token.actor.uuid === attacker.uuid) return { error: "The attacker cannot also be the defender." };
  const players = [...game.users].filter(user => !user.isGM && owns(token.actor, user));
  if (!players.length) return { actor: token.actor, token: token.document }; // GM-controlled NPC.
  const assigned = players.filter(user => user.character && owns(user.character, user));
  const matching = assigned.filter(user => user.character.id === token.actor.id);
  const candidates = matching.length ? matching : assigned;
  if (candidates.length !== 1) return { error: "The target needs one defending player with an assigned character in User Configuration." };
  const player = candidates[0];
  const actor = player.character.id === token.actor.id ? token.actor : player.character;
  if (actor.uuid === attacker.uuid) return { error: "The assigned defender cannot also be the attacker." };
  return { actor, token: player.character.id === token.actor.id ? token.document : null, playerId: player.id };
}

/** The visible board a contest message belongs to (the board itself, or the board named by a request). */
export function findBoard(message) {
  if (boardData(message)) return message;
  const id = requestData(message)?.boardId;
  return id ? game.messages.get(id) ?? null : null;
}

/** Initial board for the sheet's contest roll, before any request exists. */
export function renderNewContestBoard({ stat, attacker, defender = null, note = "" }) {
  const sides = [{ key: attacker.role === "save" ? "save" : "attack", name: attacker.name, img: attacker.img, stat: attacker.stat, value: attacker.value, die: attacker.die, state: "waiting" }];
  if (defender) sides.push({ key: "save", name: defender.name, img: defender.img, stat: "", state: "waiting" });
  return renderContestBoard({ stat, sides, cancelled: Boolean(note), note });
}

/** Send a pending saving contest to the defender's owners, attacker and GMs. */
export async function requestDefenderContest({ attacker, defender, attackMessage, stat }) {
  if (!defender?.actor) {
    globalThis.ui?.notifications?.warn(defender?.error ?? "No defender selected.");
    return null;
  }
  if (!CONTEST_STATS[stat]) return null;
  if (!owns(attacker, game.user)) { ui.notifications.warn("You do not own the attacking character."); return null; }
  const actor = defender.actor;
  const owners = [...game.users].filter(user => !user.isGM && owns(actor, user) && (!defender.playerId || user.id === defender.playerId));
  const gms = [...game.users].filter(user => user.isGM);
  if (!owners.length && !gms.length) {
    ui.notifications.warn("The defender has no player owner or GM to answer the contest.");
    return null;
  }
  if (owners.some(user => user.id !== game.user.id) && !activeGM()) {
    ui.notifications.warn("A GM must be online to process the defender's contest response.");
    return null;
  }
  const whisper = [...new Set([game.user.id, ...owners.map(user => user.id), ...gms.map(user => user.id)])];
  const data = {
    defenderUuid: actor.uuid, attackerUuid: attacker.uuid, attackMessageId: attackMessage.id,
    boardId: boardData(attackMessage) ? attackMessage.id : requestData(attackMessage)?.boardId ?? null, rollerImg: actor.img ?? null,
    stat, requestAuthorId: game.user.id, popup: true, recipientUserId: defender.playerId ?? null, status: "pending", defenderName: actor.name, attackerName: attacker.name
  };
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }), whisper,
    flavor: `Save Contest - ${formatContestMatchup(attacker.name, actor.name)}`,
    content: `<p><strong>${escape(attacker.name)}</strong> requests a <strong>save contest</strong> from ${escape(actor.name)}.</p><button type="button" data-incarnos-contest="roll">Roll Contest</button>`,
    flags: { incarnos: { contestRequest: data } }
  });
}

/** Roll locally as an owner. A GM handles updates to another user's request card. */
export async function rollDefenderContest(message) {
  const data = requestData(message);
  if (!data || data.status !== "pending" || rolling.has(message.id) || submitted.has(message.id)) return;
  rolling.add(message.id);
  try {
    const actor = await fromUuid(data.defenderUuid);
    if (!owns(actor, game.user) || (!game.user.isGM && data.recipientUserId && data.recipientUserId !== game.user.id)) return ui.notifications.warn("You do not own this defender.");
    if (!game.user.isGM && message.author?.id !== game.user.id && !activeGM()) {
      return ui.notifications.warn("A GM must be online to process this contest response.");
    }
    const isAttack = data.role === "attack";
    const options = Object.keys(CONTEST_STATS)
      .map(stat => `<option value="${stat}"${stat === data.stat ? " selected" : ""}>${stat}</option>`)
      .join("");
    const stat = await showContestDialog("prompt", {
      window: { title: data.reroll ? "TIE! Roll contest again" : "Choose your save contest stat" },
      content: data.reroll
        ? `<p><strong>TIE!</strong> ${formatContestMatchup(data.attackerName, data.defenderName)}</p><p>Roll again using ${escape(data.stat)} (${isAttack ? "attack" : "save"}).</p>`
        : `<p><span style="color: #c62828">${escape(data.attackerName)}</span> challenges you!</p><fieldset><legend>Saving throw</legend><div class="form-group"><label>Stat</label><select name="stat">${options}</select></div></fieldset>`,
      ok: { label: "Roll!", callback: (event, button) => data.reroll ? data.stat : button.form.elements.stat.value },
      rejectClose: false,
      modal: true
    }, async () => {
      if (data.reroll) await waitForContestAnimations(data.previousMessageIds ?? []);
      return requestData(message)?.status === "pending" && !submitted.has(message.id)
        && owns(actor, game.user);
    });
    if (!stat || requestData(message)?.status !== "pending") return;
    if (!Object.hasOwn(CONTEST_STATS, stat)) return ui.notifications.warn("Choose a valid saving throw.");
    const value = Number(actor.system.abilities?.[CONTEST_STATS[stat]]?.[data.role === "attack" ? "value" : "save"]);
    const die = getContestDie(value);
    if (!Number.isInteger(die) || die < 1) return ui.notifications.warn("This defender's saving throw does not produce a valid contest die.");
    const roll = await new Roll(`d${die}`).evaluate({ async: true });
    const response = { requestId: message.id, stat, value, roll: roll.toJSON() };
    if (game.user.isGM || message.author?.id === game.user.id) {
      await completeDefenderContest(message, actor, response, game.user.id);
    } else {
      // The server identifies the response author; do not trust socket user IDs.
      submitted.add(message.id);
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }), whisper: [activeGM().id, game.user.id],
        content: "<p>Submitting contest response.</p>",
        flags: { incarnos: { contestResponse: response } }
      });
    }
  } catch (error) { submitted.delete(message.id); throw error; }
  finally { rolling.delete(message.id); }
}

/** Validate the authenticated responder and close each pending request only once. */
export async function completeDefenderContest(message, actor, response, userId) {
  const data = requestData(message);
  const user = game.users.get(userId);
  // A cancelled contest is no longer pending, so late responses are rejected here.
  if (!data || data.status !== "pending" || processing.has(message.id) || !owns(actor, user)) return false;
  if (actor.uuid !== data.defenderUuid || !CONTEST_STATS[data.stat]) return false;
  if (!user.isGM && data.recipientUserId && data.recipientUserId !== userId) return false;
  const stat = response.stat ?? data.stat; // Pending responses from older clients use the requested stat.
  if (!Object.hasOwn(CONTEST_STATS, stat) || (data.reroll && stat !== data.stat)) return false;
  const value = Number(actor.system.abilities?.[CONTEST_STATS[stat]]?.[data.role === "attack" ? "value" : "save"]);
  const die = getContestDie(value);
  if (response.value !== value || !Number.isInteger(die) || die < 1) return false;
  const roll = Roll.fromData(response.roll);
  if (!roll._evaluated || !new RegExp(`^1?d${die}$`).test(roll.formula) || !Number.isInteger(roll.total) || roll.total < 1 || roll.total > die) return false;
  processing.add(message.id);
  try {
    await message.update({
      flavor: "",
      // Dice So Nice uses the author for appearance and "show only my dice".
      author: userId,
      // The request stays hidden; its result appears on the contest board.
      content: `<p>${escape(actor.name)}: ${escape(stat)} ${value}, d${die} → ${roll.total}</p>`,
      rolls: [roll.toJSON()],
      whisper: [], blind: false,
      "flags.incarnos.contestRequest.status": "complete",
      "flags.incarnos.contestRequest.requestAuthorId": data.requestAuthorId ?? message.author.id,
      "flags.incarnos.contestRequest.responderId": userId,
      "flags.incarnos.contestRequest.responseStat": stat,
      "flags.incarnos.contestRequest.responseValue": value,
      "flags.incarnos.contestRequest.responseDie": die
    });
    submitted.delete(message.id);
    return true;
  } finally { processing.delete(message.id); }
}

/** Called only by the elected active GM; author identity comes from the creation hook. */
export async function processContestResponse(message, userId) {
  const response = message.flags?.incarnos?.contestResponse;
  if (!response || activeGM()?.id !== game.user.id) return;
  try {
    const request = game.messages.get(response.requestId);
    if (!request || message.author?.id !== userId) return;
    const data = requestData(request);
    if (!data) return;
    const actor = await fromUuid(data.defenderUuid);
    const attacker = await fromUuid(data.attackerUuid);
    if (!owns(attacker, requestAuthor(request))) return;
    await completeDefenderContest(request, actor, response, userId);
  } catch (error) {
    console.error("Incarnos contest response failed", error);
  } finally {
    await message.delete();
  }
}

/** Wait for local Dice So Nice animations when available; no artificial delay. */
export async function waitForContestAnimations(messageIds) {
  // Allow every synchronous chat-update hook to start its animation first.
  await Promise.resolve();
  if (typeof game.dice3d?.waitFor3DAnimationByMessageID !== "function") return;
  await Promise.all([...new Set(messageIds)].map(id => game.dice3d.waitFor3DAnimationByMessageID(id)));
}

/** Roll the board's own side (the sheet roller of round 1): its author or a GM, owning the actor. */
export async function rollBoardSide(board, side = boardData(board)?.attacker) {
  if (!board || !side || rolling.has(board.id)) return false;
  const actor = await fromUuid(side.uuid);
  if (!owns(actor, game.user) || (!game.user.isGM && board.author && board.author.id !== game.user.id)) {
    ui.notifications.warn("Only the contest's roller or a GM can roll this side.");
    return false;
  }
  if (boardData(board)?.cancelled || board.rolls?.length) return false;
  if (!Number.isInteger(side.die) || side.die < 1) {
    ui.notifications.warn("Cannot roll this contest: the selected stat must be a finite integer.");
    return false;
  }
  rolling.add(board.id);
  try {
    const roll = await new Roll(`d${side.die}`).evaluate({ async: true });
    await board.update({ rolls: [roll.toJSON()] });
    return true;
  } finally { rolling.delete(board.id); }
}

/** GM: end a contest without a result; pending requests close and late responses are rejected. */
export async function cancelContest(board) {
  if (!game.user.isGM || !boardData(board)) return;
  await board.update({ "flags.incarnos.contestBoard.cancelled": true });
  for (const request of boardRequests(board)) {
    if (requestData(request).status === "pending") await request.update({ "flags.incarnos.contestRequest.status": "cancelled" });
  }
  await refreshBoard(board);
}

const boardRequests = board => allMessages().filter(message => requestData(message)?.boardId === board.id);

/** Current state of each side on a board, read from the board and its requests. */
async function boardSides(board) {
  const data = boardData(board);
  const requests = boardRequests(board);
  const attackRequest = requests.filter(message => requestData(message).role === "attack").at(-1);
  const saveRequest = requests.filter(message => requestData(message).role !== "attack").at(-1);
  const side = (key, source, { name, img, stat, value, die, total }) => {
    const revealKey = Number.isFinite(total) ? `${source}:${total}` : null;
    return { key, source, name, img, stat, value, die, total, revealKey, state: !revealKey ? "waiting" : revealed.has(revealKey) ? "done" : "rolling" };
  };
  const fromRequest = (message, key) => {
    const request = requestData(message);
    const complete = request.status === "complete";
    return side(key, message.id, {
      name: key === "attack" ? request.attackerName : request.defenderName, img: request.rollerImg,
      stat: request.responseStat ?? request.stat, value: request.responseValue, die: request.responseDie,
      total: complete ? message.rolls?.[0]?.total : null
    });
  };
  const sides = [];
  if (attackRequest) sides.push(fromRequest(attackRequest, "attack"));
  else if (data.attacker) {
    sides.push(side(data.attacker.role === "save" ? "save" : "attack", board.id, { ...data.attacker, total: board.rolls?.[0]?.total }));
  }
  if (saveRequest) sides.push(fromRequest(saveRequest, "save"));
  else if (data.defender) sides.push(side("save", null, { name: data.defender.name, img: data.defender.img, stat: "", total: null }));
  return sides;
}

const boardWriter = board => activeGM() ?? board.author;

/** Re-render a board from current data. Only one client writes; renders queue per board. */
export function refreshBoard(board) {
  if (!board || !boardData(board) || boardWriter(board)?.id !== game.user.id) return Promise.resolve();
  const next = (boardQueues.get(board.id) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const current = game.messages.get(board.id) ?? board;
    if (!boardData(current)) return;
    const write = async sides => {
      const data = boardData(current);
      const content = renderContestBoard({
        stat: data.stat ?? data.attacker?.stat ?? sides[0]?.stat, round: data.round ?? 1, sides,
        outcome: current.flags?.incarnos?.contestOutcome ?? null, cancelled: Boolean(data.cancelled)
      });
      if (content !== current.content) await current.update({ content });
    };
    const sides = await boardSides(current);
    await write(sides);
    // New totals show "Rolling…" until the dice animation has finished on this client.
    const rollingSides = sides.filter(side => side.state === "rolling");
    if (rollingSides.length) {
      await waitForContestAnimations(rollingSides.map(side => side.source));
      rollingSides.forEach(side => revealed.add(side.revealKey));
      await write(await boardSides(current));
    }
  }).catch(error => console.error("Incarnos contest board could not be updated", error));
  boardQueues.set(board.id, next);
  return next;
}

/** Finalize a completed pair on one GM client; lower totals win, ties start a new round on a new board. */
export async function resolveContestTie(message) {
  if (activeGM()?.id !== game.user.id) return;
  const candidates = requestData(message)?.role !== "attack" && requestData(message)
    ? [message]
    : allMessages().filter(card => requestData(card)?.role !== "attack" && requestData(card)?.attackMessageId === message.id);
  for (const defenderMessage of candidates) {
    const data = requestData(defenderMessage);
    if (data.status !== "complete" || data.tieProcessed || data.outcomeProcessed || resolvingTies.has(defenderMessage.id)) continue;
    const attackMessage = game.messages.get(data.attackMessageId);
    const attackTotal = attackMessage?.rolls?.[0]?.total;
    const saveTotal = defenderMessage.rolls?.[0]?.total;
    if (!Number.isFinite(attackTotal) || !Number.isFinite(saveTotal)) continue;
    resolvingTies.add(defenderMessage.id);
    try {
      const attacker = await fromUuid(data.attackerUuid);
      const defender = await fromUuid(data.defenderUuid);
      if (!attacker || !defender || !owns(attacker, requestAuthor(defenderMessage)) || !owns(attacker, attackMessage.author)) continue;
      await waitForContestAnimations([attackMessage.id, defenderMessage.id]);
      if (activeGM()?.id !== game.user.id || requestData(defenderMessage)?.tieProcessed || requestData(defenderMessage)?.outcomeProcessed
        || requestData(defenderMessage)?.status !== "complete"
        || attackMessage.rolls?.[0]?.total !== attackTotal || defenderMessage.rolls?.[0]?.total !== saveTotal) continue;
      revealed.add(`${attackMessage.id}:${attackTotal}`).add(`${defenderMessage.id}:${saveTotal}`);
      const board = findBoard(defenderMessage);
      if (board && boardData(board)?.cancelled) continue;
      if (attackTotal !== saveTotal) {
        const attackWon = attackTotal < saveTotal;
        const winnerName = attackWon ? data.attackerName : data.defenderName;
        const outcome = { winner: attackWon ? "attack" : "defender", winnerName, attackTotal, saveTotal };
        await defenderMessage.update({
          "flags.incarnos.contestRequest.outcomeProcessed": true,
          "flags.incarnos.contestOutcome": outcome
        });
        await attackMessage.update({ "flags.incarnos.contestOutcome": outcome });
        if (board && board !== attackMessage) await board.update({ "flags.incarnos.contestOutcome": outcome });
        if (board) await refreshBoard(board);
        else await postResultCard({ attacker, defender, data, attackTotal, saveTotal, outcome, attackMessage, defenderMessage });
        continue;
      }
      const tie = { winner: null, tie: true, attackTotal, saveTotal };
      await defenderMessage.update({ "flags.incarnos.contestRequest.tieProcessed": true });
      if (board) {
        await board.update({ "flags.incarnos.contestOutcome": tie });
        await refreshBoard(board);
      } else await postResultCard({ attacker, defender, data, attackTotal, saveTotal, outcome: tie, attackMessage, defenderMessage });

      // The reroll gets its own board; its two requests point at it.
      const nextBoard = await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: attacker }),
        whisper: [], blind: false, flavor: "",
        content: renderContestBoard({ stat: data.responseStat ?? data.stat, round: (boardData(board)?.round ?? 1) + 1, sides: [] }),
        flags: { incarnos: { contestBoard: { round: (boardData(board)?.round ?? 1) + 1, stat: requestData(attackMessage)?.responseStat ?? boardData(board)?.attacker?.stat ?? data.stat } } }
      });
      const attackData = requestData(attackMessage);
      const attackOwner = !attackMessage.author.isGM && owns(attacker, attackMessage.author)
        ? attackMessage.author.id : null;
      const attackRecipient = attackData?.recipientUserId ?? attackOwner;
      const base = { attackerUuid: data.attackerUuid, attackerName: data.attackerName, defenderName: data.defenderName, boardId: nextBoard.id,
        requestAuthorId: game.user.id, popup: true, reroll: true, previousMessageIds: [attackMessage.id, defenderMessage.id], status: "pending" };
      const createReroll = (actor, recipientUserId, extra) => ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        whisper: [...new Set([game.user.id, ...[...game.users].filter(user => user.isGM ||
          (!user.isGM && owns(actor, user) && (!recipientUserId || user.id === recipientUserId))).map(user => user.id)])],
        flavor: `Contest reroll - ${formatContestMatchup(data.attackerName, data.defenderName)}`,
        content: "<p>TIE! Roll the contest again.</p>",
        flags: { incarnos: { contestRequest: { ...base, defenderUuid: actor.uuid, rollerImg: actor.img ?? null, recipientUserId, ...extra } } }
      });
      const nextAttack = await createReroll(attacker, attackRecipient, {
        role: "attack", stat: attackData?.responseStat ?? attackData?.stat ?? boardData(attackMessage)?.attacker?.stat ?? data.stat
      });
      await createReroll(defender, data.recipientUserId, {
        role: "save", stat: data.responseStat ?? data.stat, attackMessageId: nextAttack.id
      });
      await refreshBoard(nextBoard);
    } catch (error) {
      console.error("Incarnos contest resolution failed", error);
      ui.notifications.error("The contest result could not be recorded.");
    } finally { resolvingTies.delete(defenderMessage.id); }
  }
}

/** Contests started without a board (older chat) still get a visible result. */
function postResultCard({ attacker, defender, data, attackTotal, saveTotal, outcome, attackMessage, defenderMessage }) {
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor: outcome.winner === "defender" ? defender : attacker }),
    whisper: [], blind: false, flavor: "",
    content: renderContestBoard({
      stat: data.responseStat ?? data.stat, outcome, canCancel: false,
      sides: [
        { key: "attack", name: data.attackerName, img: attacker.img, stat: "", total: attackTotal, state: "done" },
        { key: "save", name: data.defenderName, img: defender.img, stat: data.responseStat ?? data.stat, total: saveTotal, state: "done" }
      ]
    }),
    flags: { incarnos: { contestOutcome: { ...outcome, attackMessageId: attackMessage.id, defenderMessageId: defenderMessage.id } } }
  });
}

/** Show each new request on its assigned player's client, or one GM for NPCs. */
export async function promptDefenderContest(message) {
  const data = requestData(message);
  if (!data?.popup || data.status !== "pending" || prompted.has(message.id)) return;
  const recipientId = data.recipientUserId ?? activeGM()?.id;
  if (recipientId !== game.user.id) return;
  prompted.add(message.id);
  try {
    const attacker = await fromUuid(data.attackerUuid);
    if (!owns(attacker, requestAuthor(message))) return;
    await rollDefenderContest(message);
  } catch (error) {
    prompted.delete(message.id);
    console.error("Incarnos defender popup failed", error);
    ui.notifications.error("The defender contest could not be opened.");
  }
}

/**
 * After a reload or reconnect: the active GM finishes recent responses and results that were left open;
 * every writer re-renders recent boards. Rolls made before the reload show at once (no animation).
 * Popups are not reopened — waiting sides use the Roll button on their board instead.
 */
export async function resumeContests() {
  const recent = allMessages().filter(isRecent);
  if (activeGM()?.id === game.user.id) {
    for (const message of recent.filter(message => message.flags?.incarnos?.contestResponse)) {
      await processContestResponse(message, message.author?.id);
    }
    for (const message of recent.filter(message => requestData(message)?.boardId && requestData(message).role !== "attack")) {
      await resolveContestTie(message);
    }
  }
  for (const board of recent.filter(message => boardData(message))) {
    for (const side of await boardSides(board)) if (side.revealKey) revealed.add(side.revealKey);
    await refreshBoard(board);
  }
}

/** Who may press a side's Roll button on a board. */
async function rollButtonFor(board, key) {
  const request = boardRequests(board).filter(message => (requestData(message).role === "attack") === (key === "attack")).at(-1);
  if (request) {
    const data = requestData(request);
    const actor = await fromUuid(data.defenderUuid);
    const allowed = data.status === "pending" && owns(actor, game.user) && (game.user.isGM || !data.recipientUserId || data.recipientUserId === game.user.id);
    return allowed ? () => rollDefenderContest(request) : null;
  }
  const side = boardData(board)?.attacker;
  if (!side || (side.role === "save" ? "save" : "attack") !== key || board.rolls?.length) return null;
  const actor = await fromUuid(side.uuid);
  const allowed = owns(actor, game.user) && (game.user.isGM || board.author?.id === game.user.id);
  return allowed ? () => rollBoardSide(board) : null;
}

/** Requests and responses stay out of the chat log; boards get their Roll and Cancel buttons wired per user. */
export function registerContestRequestHooks() {
  Hooks.on("renderChatMessageHTML", (message, html) => {
    if (requestData(message) || message.flags?.incarnos?.contestResponse) { html.style.display = "none"; return; }
    if (!boardData(message)) return;
    for (const button of html.querySelectorAll?.("[data-incarnos-contest-roll]") ?? []) {
      button.style.display = "none";
      rollButtonFor(message, button.dataset.incarnosContestRoll).then(roll => {
        if (!roll) return button.remove();
        button.style.display = "";
        button.addEventListener("click", async () => {
          button.disabled = true;
          try { await roll(); }
          catch (error) { console.error(error); ui.notifications.error("The contest roll failed. Try again from this card."); }
          finally { button.disabled = false; }
        });
      }).catch(() => button.remove());
    }
    for (const button of html.querySelectorAll?.("[data-incarnos-contest-cancel]") ?? []) {
      if (!game.user.isGM) { button.remove(); continue; }
      button.addEventListener("click", async () => {
        button.disabled = true;
        try { await cancelContest(message); }
        catch (error) { console.error(error); ui.notifications.error("The contest could not be cancelled."); button.disabled = false; }
      });
    }
  });
  Hooks.on("updateChatMessage", message => {
    if (requestData(message)?.status === "complete") submitted.delete(message.id);
    void resolveContestTie(message);
    void refreshBoard(findBoard(message));
  });
  Hooks.on("createChatMessage", (message, options, userId) => {
    void processContestResponse(message, userId);
    void promptDefenderContest(message);
    void refreshBoard(findBoard(message));
  });
  // Popups only open from live events; on ready, open contests are resumed from their boards.
  Hooks.once("ready", () => { void resumeContests(); });
}
