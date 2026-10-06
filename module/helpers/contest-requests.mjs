/** Private defender requests use chat documents so the GM can authorize responses. */
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

const processing = new Set();
const rolling = new Set();
const submitted = new Set();
const prompted = new Set();
const resolvingTies = new Set();
const requestData = message => message.flags?.incarnos?.contestRequest;
const requestAuthor = message => game.users.get(requestData(message)?.requestAuthorId) ?? message.author;
const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const activeGM = () => [...game.users].filter(user => user.active && user.isGM).sort((a, b) => a.id.localeCompare(b.id))[0];
const owns = (actor, user) => Boolean(user && (user.isGM || actor?.testUserPermission(user, "OWNER")));

/** HTML-safe matchup label shared by the attack and defender cards. */
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
      flavor: `${data.role === "attack" ? "Attack:" : "Save:"} ${stat} Contest: ${value} - ${formatContestMatchup(data.attackerName, data.defenderName)}`,
      // Dice So Nice uses the author for appearance and "show only my dice".
      author: userId,
      content: await roll.render(), rolls: [roll.toJSON()],
      whisper: [], blind: false,
      "flags.incarnos.contestRequest.status": "complete",
      "flags.incarnos.contestRequest.requestAuthorId": data.requestAuthorId ?? message.author.id,
      "flags.incarnos.contestRequest.responderId": userId,
      "flags.incarnos.contestRequest.responseStat": stat
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

/** Finalize a completed pair on one GM client; lower totals win, ties start a new pair. */
export async function resolveContestTie(message) {
  if (activeGM()?.id !== game.user.id) return;
  const candidates = requestData(message)?.role !== "attack" && requestData(message)
    ? [message]
    : [...game.messages.values()].filter(card => requestData(card)?.role !== "attack" && requestData(card)?.attackMessageId === message.id);
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
      const coloredMatchup = `<span style="color: #c62828">${escape(data.attackerName)}</span> vs. <span style="color: #2e7d32">${escape(data.defenderName)}</span>`;
      const colorFlavor = card => (card.flavor ?? "").replace(`${escape(data.attackerName)} vs. ${escape(data.defenderName)}`, coloredMatchup);
      if (attackTotal !== saveTotal) {
        const attackWon = attackTotal < saveTotal;
        const winnerName = attackWon ? data.attackerName : data.defenderName;
        const outcome = { winner: attackWon ? "attack" : "defender", winnerName, attackTotal, saveTotal };
        const footer = `<p><span style="color: ${attackWon ? "#c62828" : "#2e7d32"}">${escape(winnerName)}</span> wins!</p>`;
        await defenderMessage.update({
          flavor: colorFlavor(defenderMessage),
          "flags.incarnos.contestRequest.outcomeProcessed": true,
          "flags.incarnos.contestOutcome": outcome
        });
        await attackMessage.update({
          flavor: colorFlavor(attackMessage),
          "flags.incarnos.contestOutcome": outcome
        });
        await ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor: attackWon ? attacker : defender }),
          whisper: [], blind: false,
          flavor: "",
          content: footer,
          flags: { incarnos: { contestOutcome: { ...outcome, attackMessageId: attackMessage.id, defenderMessageId: defenderMessage.id } } }
        });
        continue;
      }
      await defenderMessage.update({
        flavor: colorFlavor(defenderMessage),
        "flags.incarnos.contestRequest.tieProcessed": true
      });
      await attackMessage.update({ flavor: colorFlavor(attackMessage) });
      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: attacker }),
        whisper: [], blind: false,
        flavor: `Contest result - ${coloredMatchup}`,
        content: "<p><strong>TIE!</strong> Both contestants roll again.</p>",
        flags: { incarnos: { contestOutcome: { winner: null, tie: true, attackTotal, saveTotal,
          attackMessageId: attackMessage.id, defenderMessageId: defenderMessage.id } } }
      });
      const attackData = requestData(attackMessage);
      const attackOwner = !attackMessage.author.isGM && owns(attacker, attackMessage.author)
        ? attackMessage.author.id : null;
      const attackRecipient = attackData?.recipientUserId ?? attackOwner;
      const base = { attackerUuid: data.attackerUuid, attackerName: data.attackerName, defenderName: data.defenderName,
        requestAuthorId: game.user.id, popup: true, reroll: true, previousMessageIds: [attackMessage.id, defenderMessage.id], status: "pending" };
      const createReroll = (actor, recipientUserId, extra) => ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        whisper: [...new Set([game.user.id, ...[...game.users].filter(user => user.isGM ||
          (!user.isGM && owns(actor, user) && (!recipientUserId || user.id === recipientUserId))).map(user => user.id)])],
        flavor: `Contest reroll - ${formatContestMatchup(data.attackerName, data.defenderName)}`,
        content: "<p>TIE! Roll the contest again.</p>",
        flags: { incarnos: { contestRequest: { ...base, defenderUuid: actor.uuid, recipientUserId, ...extra } } }
      });
      const nextAttack = await createReroll(attacker, attackRecipient, {
        role: "attack", stat: attackData?.responseStat ?? attackData?.stat ?? data.stat
      });
      await createReroll(defender, data.recipientUserId, {
        role: "save", stat: data.responseStat ?? data.stat, attackMessageId: nextAttack.id
      });
    } catch (error) {
      console.error("Incarnos tie reroll failed", error);
      ui.notifications.error("The tied contest could not be restarted.");
    } finally { resolvingTies.delete(defenderMessage.id); }
  }
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

/** Chat documents carry requests; pending popup cards stay out of the chat UI. */
export function registerContestRequestHooks() {
  Hooks.on("renderChatMessageHTML", (message, html) => {
    if (requestData(message)?.popup && requestData(message)?.status === "pending") { html.style.display = "none"; return; }
    if (message.flags?.incarnos?.contestResponse) { html.style.display = "none"; return; }
    const button = html.querySelector('[data-incarnos-contest="roll"]');
    if (!button) return;
    fromUuid(requestData(message)?.defenderUuid).then(actor => {
      const data = requestData(message);
      button.disabled = !owns(actor, game.user) || (data.recipientUserId && data.recipientUserId !== game.user.id && !game.user.isGM) || data.status !== "pending" || submitted.has(message.id);
    }).catch(() => { button.disabled = true; });
    button.disabled = true;
    button.addEventListener("click", async () => {
      button.disabled = true;
      try { await rollDefenderContest(message); }
      catch (error) { console.error(error); ui.notifications.error("The defender contest could not be rolled."); }
      finally { button.disabled = requestData(message)?.status !== "pending" || submitted.has(message.id); }
    });
  });
  Hooks.on("updateChatMessage", message => {
    if (requestData(message)?.status === "complete") submitted.delete(message.id);
    void resolveContestTie(message);
  });
  Hooks.on("createChatMessage", (message, options, userId) => {
    void processContestResponse(message, userId);
    void promptDefenderContest(message);
  });
  // Only live create/update events trigger dialogs and outcomes. Replaying chat
  // history on ready revives abandoned requests and unresolved historical ties.
}
