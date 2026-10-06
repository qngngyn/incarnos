/** Private defender requests use chat documents so the GM can authorize responses. */
export const CONTEST_STATS = { Strength: "str", Dexterity: "dex", Constitution: "con", Willpower: "wis", Perception: "prc", Speed: "spd", Intelligence: "int", Charisma: "cha" };
/** Contest improvements stop at d2; invalid stat values cannot produce a roll. */
export function getContestDie(value) {
  const stat = Number(value);
  return Number.isInteger(stat) ? Math.max(2, 20 - stat) : NaN;
}
const processing = new Set();
const rolling = new Set();
const submitted = new Set();
const requestData = message => message.flags?.incarnos?.contestRequest;
const escape = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const activeGM = () => [...game.users].filter(user => user.active && user.isGM).sort((a, b) => a.id.localeCompare(b.id))[0];
const owns = (actor, user) => Boolean(user && (user.isGM || actor?.testUserPermission(user, "OWNER")));

/** HTML-safe matchup label shared by the attack and defender cards. */
export function formatContestMatchup(attacker, defender) {
  return defender ? `${escape(attacker)} vs. ${escape(defender)}` : escape(attacker);
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
    stat, recipientUserId: defender.playerId ?? null, status: "pending", defenderName: actor.name, attackerName: attacker.name
  };
  return ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }), whisper,
    flavor: `Save: ${stat} Contest - ${formatContestMatchup(attacker.name, actor.name)}`,
    content: `<p><strong>${escape(attacker.name)}</strong> requests a <strong>${escape(stat)} save contest</strong> from ${escape(actor.name)}.</p><button type="button" data-incarnos-contest="roll">Roll Contest</button>`,
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
    const options = Object.keys(CONTEST_STATS)
      .map(stat => `<option value="${stat}"${stat === data.stat ? " selected" : ""}>${stat}</option>`)
      .join("");
    const stat = await foundry.applications.api.DialogV2.prompt({
      window: { title: "Choose your save contest stat" },
      content: `<fieldset><legend>Saving throw</legend><div class="form-group"><label>Stat</label><select name="stat">${options}</select></div></fieldset>`,
      ok: { label: "Roll Contest", callback: (event, button) => button.form.elements.stat.value },
      rejectClose: false,
      modal: true
    });
    if (!stat || requestData(message)?.status !== "pending") return;
    if (!Object.hasOwn(CONTEST_STATS, stat)) return ui.notifications.warn("Choose a valid saving throw.");
    const value = Number(actor.system.abilities?.[CONTEST_STATS[stat]]?.save);
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
  if (!Object.hasOwn(CONTEST_STATS, stat)) return false;
  const value = Number(actor.system.abilities?.[CONTEST_STATS[stat]]?.save);
  const die = getContestDie(value);
  if (response.value !== value || !Number.isInteger(die) || die < 1) return false;
  const roll = Roll.fromData(response.roll);
  if (!roll._evaluated || !new RegExp(`^1?d${die}$`).test(roll.formula) || !Number.isInteger(roll.total) || roll.total < 1 || roll.total > die) return false;
  processing.add(message.id);
  try {
    await message.update({
      flavor: `Save: ${stat} Contest: ${value} - ${formatContestMatchup(data.attackerName, data.defenderName)}`,
      content: await roll.render(), rolls: [roll.toJSON()],
      whisper: [], blind: false,
      "flags.incarnos.contestRequest.status": "complete",
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
    if (!owns(attacker, request.author)) return;
    await completeDefenderContest(request, actor, response, userId);
  } catch (error) {
    console.error("Incarnos contest response failed", error);
  } finally {
    await message.delete();
  }
}

/** Bind chat controls separately on each client; no remote popup is forced. */
export function registerContestRequestHooks() {
  Hooks.on("renderChatMessageHTML", (message, html) => {
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
  Hooks.on("updateChatMessage", message => { if (requestData(message)?.status === "complete") submitted.delete(message.id); });
  Hooks.on("createChatMessage", (message, options, userId) => { void processContestResponse(message, userId); });
  Hooks.once("ready", () => {
    // Resume legitimate responses if a client reconnects before the GM processed them.
    if (activeGM()?.id === game.user.id) for (const message of game.messages) {
      if (message.flags?.incarnos?.contestResponse) void processContestResponse(message, message.author?.id);
    }
  });
}
