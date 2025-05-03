/**
 * Extend the basic Item with some very simple modifications.
 * @extends {Item}
 */
export class IncarnosItem extends Item {
  /**
   * Augment the basic Item data model with additional dynamic data.
   */
  prepareData() {
    // As with the actor class, items are documents that can have their data
    // preparation methods overridden (such as prepareBaseData()).
    super.prepareData();
  }

  /**
   * Prepare a data object which is passed to any Roll formulas which are created related to this Item
   * @private
   */
  getRollData() {
    // If present, return the actor's roll data.
    if (!this.actor) return null;
    const rollData = this.actor.getRollData();
    // Grab the item's system data as well.
    rollData.item = foundry.utils.deepClone(this.system);

    return rollData;
  }

  /**
   * Handle clickable rolls.
   * @param {Event} event   The originating click event
   * @private
   */
  async roll() {
    const item = this;

    // Initialize chat data.
    const speaker = ChatMessage.getSpeaker({ actor: this.actor });
    const rollMode = game.settings.get('core', 'rollMode');
    const label = `<b>${item.name}</b>
    <i>${item.system.description}</i>`;

    // If there's no roll data, send a chat message.
    if (!this.system.formula) {
      ChatMessage.create({
        speaker: speaker,
        rollMode: rollMode,
        flavor: label,
        content: item.system.description ?? ''
      });
    }
    // Otherwise, create a roll and send a chat message from it.
    else {
      if (this.type !== "weapon") {
        // Retrieve roll data.
        const rollData = this.getRollData();
        new Roll('1d20').toMessage({
          speaker: speaker,
          rollMode: rollMode,
          flavor: label,
        });
        // Invoke the roll and submit it to chat.
        const roll = new Roll(rollData.item.formula, rollData);
        // If you need to store the value first, uncomment the next line.
        // let result = await roll.roll({async: true});
        roll.toMessage({
          speaker: speaker,
          rollMode: rollMode,
          flavor: "Damage",
        });
        return roll;
      }
      const flavor = label
      const rollData = this.getRollData();
      const dmg = rollData.item.formula

      const attacktype = ["Attack", "Attack (Quick)", "Attack (Precision)", "Attack (Fury)", "Attack (Relentless)", "Attack (Crazed)", "Attack (Power - Melee)", "Attack (Power - Ranged)", "Attack (Feint)"];
      const attacktypeSelected = "Attack";
      const atktypeoptions = attacktype.reduce((acc, e) => acc + `<option value="${e}" ${e === attacktypeSelected ? "attacktypeSelected" : ""}>${e}</option>`, "");

      const advantage = ["Normal", "Advantage", "Disadvantage"];
      const advSelected = "Normal";
      const advoptions = advantage.reduce((acc, e) => acc + `<option value="${e}" ${e === advSelected ? "advSelected" : ""}>${e}</option>`, "");

      new Dialog({
        title: "Choose your attack",
        content: `
            <form>
              <fieldset><legend>Attack action</legend>
                <div class="form-group">
                  <label>Type of attack</label>
                  <select name="atk">
                    ${atktypeoptions}
                  </select>
                </div>
                <div class="form-group">
                  <label>Advantage</label>
                  <select name="advtype">
                    ${advoptions}
                  </select>
                  <input name="advnum" type="number" class="auto-select" value=0 min=0 step=1 />
                </div>
              </fieldset>
              <script>
                (function() {
                  // Auto-select number inputs on focus
                  document.querySelectorAll('.auto-select').forEach(input => {
                    input.addEventListener('focus', function () {
                      this.select();
                    });
                  });

                  const advSelect = document.querySelector('select[name="advtype"]');
                  const advInput = document.querySelector('input[name="advnum"]');

                  if (advSelect && advInput) {
                    advSelect.addEventListener('change', () => {
                      const selected = advSelect.value;
                      if (selected !== 'Normal') {
                        advInput.value = 1;
                      } else {
                        advInput.value = 0;
                      }
                    });
                  }
                })();
              </script>
            </form>`,
        buttons: {
          ok: {
            label: "Roll",
            callback: html => {
              const form = new FormDataExtended(html[0].querySelector("form")).object;
              switch (form.atk) {
                case "Attack": {
                  rollAttack(form.advtype, form.advnum, rollData.item.hands)
                  break
                }
                case "Attack (Quick)": {
                  rollAttackQuick(form.advtype, form.advnum, rollData.item.hands)
                  break
                }
                case "Attack (Precision)": {
                  rollAttackPrecision(form.advtype, form.advnum, rollData.item.hands)
                  break
                }
                case "Attack (Fury)": {
                  rollAttackFury(form.advtype, form.advnum, rollData.item.hands)
                  break
                }
                case "Attack (Relentless)": {
                  rollAttackRelentless(form.advtype, form.advnum, rollData.item.hands)
                  break
                }
                case "Attack (Relentless)": {
                  rollAttackCrazed(form.advtype, form.advnum, rollData.item.hands)
                  break
                }
                case "Attack (Power - Melee)": {
                  rollAttackPowerMelee(form.advtype, form.advnum, rollData.item.hands);
                  break;
                }
                case "Attack (Power - Ranged)": {
                  rollAttackPowerRanged(form.advtype, form.advnum, rollData.item.hands);
                  break;
                }
                case "Attack (Feint)": {
                  rollAttackFeint(form.advtype, form.advnum, rollData.item.hands);
                  break;
                }
              }
            }
          },
          cancel: {
            label: "Cancel"
          }
        }
      }).render(true);

      function calculateAdvantageDice(advtype, advnum, difference) {
        let adv = ''
        if (advtype == "Disadvantage") {
          advnum *= -1;
        }
        let calc;
        if (advtype != "Normal") {
          calc = advnum + difference
        } else {
          calc = difference
        }
        if (calc < 0) {
          adv = 'kh';
          calc *= -1;
        } else if (calc > 0) {
          adv = 'kl';
        }
        calc += 1;
        return `${calc}d20${adv}`
      }

      async function rollAttack(advtype, advnum, numHands) {
        const ap = 1*numHands
        const rollHit = await new Roll(calculateAdvantageDice(advtype, advnum, 0), rollData).evaluate();
        const rollDmg = await new Roll(dmg, rollData).evaluate();
        const text = `<br>Attack:
        <br>Spends ${ap} AP with ${advnum}x ${advtype}
        <br>This is a normal Strength (melee) or Dexterity (ranged) attack`
        await ChatMessage.create({ speaker: speaker, flavor: flavor + text, rolls: [rollHit, rollDmg], type: CONST.CHAT_MESSAGE_TYPES.ROLL });
      }

      async function rollAttackQuick(advtype, advnum, numHands) {
        const ap = 1*numHands
        const rollHit = await new Roll(calculateAdvantageDice(advtype, advnum, 0), rollData).evaluate();
        const rollDmg = await new Roll(dmg, rollData).evaluate();
        const text = `<br>Attack (Quick):
        <br>Spends ${ap} AP with ${advnum}x ${advtype}
        <br>This is a special Speed (melee or ranged) attack`
        await ChatMessage.create({ speaker: speaker, flavor: flavor + text, rolls: [rollHit, rollDmg], type: CONST.CHAT_MESSAGE_TYPES.ROLL });
      }

      async function rollAttackPrecision(advtype, advnum, numHands) {
        const ap = 2*numHands
        const rollHit = await new Roll(calculateAdvantageDice(advtype, advnum, 1), rollData).evaluate();
        const rollDmg = await new Roll(dmg, rollData).evaluate();
        const text = `<br>Attack (Precision):
        <br>Spends ${ap} AP with ${advnum}x ${advtype}
        <br>This attack is advantaged`
        await ChatMessage.create({ speaker: speaker, flavor: flavor + text, rolls: [rollHit, rollDmg], type: CONST.CHAT_MESSAGE_TYPES.ROLL });
      }

      async function rollAttackFury(advtype, advnum, numHands) {
        const ap = 2*numHands
        const rollHit = await new Roll(calculateAdvantageDice(advtype, advnum, -1), rollData).evaluate();
        function replaceNumberInString(str, newNumber) {
          return str.replace(/^\d+/, newNumber);
        }
        const furydmg = replaceNumberInString(dmg, 2);
        const rollDmg = await new Roll(furydmg, rollData).evaluate();
        const text = `<br>Attack (Fury):
        <br>Spends ${ap} AP with ${advnum}x ${advtype}
        <br>This attack is disadvantaged but deals double damage`
        await ChatMessage.create({ speaker: speaker, flavor: flavor + text, rolls: [rollHit, rollDmg], type: CONST.CHAT_MESSAGE_TYPES.ROLL });
      }

      async function rollAttackRelentless(advtype, advnum, numHands) {
        const ap = 2*numHands
        const rollHit = await new Roll(calculateAdvantageDice(advtype, advnum, -1), rollData).evaluate();
        function replaceNumberInString(str, newNumber) {
          return str.replace(/^\d+/, newNumber);
        }
        const relentlessdmg = replaceNumberInString(dmg, 2);
        const rollDmg = await new Roll(relentlessdmg, rollData).evaluate();
        const text = `<br>Attack (Relentless):
        <br>Spends ${ap} AP with ${advnum}x ${advtype}
        <br>This attack is advantaged at the cost of disadvantaged parries until the next turn`
        await ChatMessage.create({ speaker: speaker, flavor: flavor + text, rolls: [rollHit, rollDmg], type: CONST.CHAT_MESSAGE_TYPES.ROLL });
      }

      async function rollAttackCrazed(advtype, advnum, numHands) {
        const ap = 2*numHands
        const rollHit = await new Roll(calculateAdvantageDice(advtype, advnum, 0), rollData).evaluate();
        function replaceNumberInString(str, newNumber) {
          return str.replace(/^\d+/, newNumber);
        }
        const crazeddmg = replaceNumberInString(dmg, 4);
        const rollDmg = await new Roll(crazeddmg, rollData).evaluate();
        const text = `<br>Attack (Crazed):
        <br>Spends ${ap} AP with ${advnum}x ${advtype}
        <br>This attack deals massive damage at the cost of inflicting the same amount to yourself`
        await ChatMessage.create({ speaker: speaker, flavor: flavor + text, rolls: [rollHit, rollDmg], type: CONST.CHAT_MESSAGE_TYPES.ROLL });
      }

      async function rollAttackPowerMelee(advtype, advnum, numHands) {
        const ap = 3*numHands
        if (ap>4) {
          await foundry.applications.api.DialogV2.prompt({
            window: { title: "You exceed the AP cost" },
            content: `Only 1 handed weapons can use this attack.
            <br>Please choose other weapons or attacks.`,
            ok: {
              label: "Ok"
            }
          });
          return
        }
        const rollHit = await new Roll(calculateAdvantageDice(advtype, advnum, 0), rollData).evaluate();
        const powerdmg = rollData.abilities.dex.value/2;;
        const rollDmg = await new Roll(`${dmg}+${powerdmg}`, rollData).evaluate();
        const text = `<br>Attack (Power - Melee):
        <br>Spends ${ap} AP with ${advnum}x ${advtype}
        <br>This attack deals additional damage depending on your Dexterity`
        await ChatMessage.create({ speaker: speaker, flavor: flavor + text, rolls: [rollHit, rollDmg], type: CONST.CHAT_MESSAGE_TYPES.ROLL });
      }

      async function rollAttackPowerRanged(advtype, advnum, numHands) {
        const ap = 3*numHands
        if (ap>4) {
          await foundry.applications.api.DialogV2.prompt({
            window: { title: "You exceed the AP cost" },
            content: `Only 1 handed weapons can use this attack.
            <br>Please choose other weapons or attacks.`,
            ok: {
              label: "Ok"
            }
          });
          return
        }
        const rollHit = await new Roll(calculateAdvantageDice(advtype, advnum, 0), rollData).evaluate();
        const powerdmg = rollData.abilities.str.value/2;
        const rollDmg = await new Roll(`${dmg}+${powerdmg}`, rollData).evaluate();
        const text = `<br>Attack (Power - Ranged):
        <br>Spends ${ap} AP with ${advnum}x ${advtype}
        <br>This attack deals additional damage depending on your Strength`
        await ChatMessage.create({ speaker: speaker, flavor: flavor + text, rolls: [rollHit, rollDmg], type: CONST.CHAT_MESSAGE_TYPES.ROLL });
      }

      async function rollAttackFeint(advtype, advnum, numHands) {
        const ap = 3*numHands
        if (ap>4) {
          await foundry.applications.api.DialogV2.prompt({
            window: { title: "You exceed the AP cost" },
            content: `Only 1 handed weapons can use this attack.
            <br>Please choose other weapons or attacks.`,
            ok: {
              label: "Ok"
            }
          });
          return
        }
        const feintbonus = rollData.abilities.int.value/2;
        const hit = calculateAdvantageDice(advtype, advnum, 0)
        const rollHit = await new Roll(`${hit}-${feintbonus}`, rollData).evaluate();
        const rollDmg = await new Roll(dmg, rollData).evaluate();
        const text = `<br>Attack (Feint):
        <br>Spends ${ap} AP with ${advnum}x ${advtype}
        <br>This attack gains on accuracy`
        await ChatMessage.create({ speaker: speaker, flavor: flavor + text, rolls: [rollHit, rollDmg], type: CONST.CHAT_MESSAGE_TYPES.ROLL });
      }
    }
  }
}