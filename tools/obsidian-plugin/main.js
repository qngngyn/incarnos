/**
 * Incarnos Foundry Sync — Obsidian plugin (desktop only, no build step).
 * Adds a ribbon button and a command "Update Foundry from vault" that runs tools/sync-vault.mjs of the
 * Foundry system with this vault's path; that also saves a backup in the backup folder. Source lives in the Foundry repo (tools/obsidian-plugin);
 * copy main.js and manifest.json to <vault>/.obsidian/plugins/incarnos-foundry-sync/.
 */
const { FileSystemAdapter, Modal, Notice, Plugin, PluginSettingTab, Setting } = require("obsidian");
const { spawn } = require("child_process");
const { existsSync } = require("fs");
const path = require("path");

const DEFAULTS = {
  systemPath: "C:\\Redo\\Data\\systems\\incarnos",
  backupDir: "C:\\Users\\mfgan\\IncarnosBackups",
  node: existsSync("C:\\Program Files\\nodejs\\node.exe") ? "C:\\Program Files\\nodejs\\node.exe" : "node"
};

class LogModal extends Modal {
  constructor(app, title, text) {
    super(app);
    this.title = title;
    this.text = text;
  }

  onOpen() {
    this.titleEl.setText(this.title);
    const pre = this.contentEl.createEl("pre", { text: this.text });
    pre.style.whiteSpace = "pre-wrap";
    pre.style.userSelect = "text";
  }

  onClose() {
    this.contentEl.empty();
  }
}

class SettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    this.containerEl.empty();
    new Setting(this.containerEl)
      .setName("Foundry system folder")
      .setDesc("The Incarnos system folder that contains tools/sync-vault.mjs.")
      .addText(text => text.setValue(this.plugin.settings.systemPath).onChange(async value => {
        this.plugin.settings.systemPath = value.trim();
        await this.plugin.saveData(this.plugin.settings);
      }));
    new Setting(this.containerEl)
      .setName("Node")
      .setDesc("Path to node.exe (or just \"node\" if it is on the PATH).")
      .addText(text => text.setValue(this.plugin.settings.node).onChange(async value => {
        this.plugin.settings.node = value.trim() || "node";
        await this.plugin.saveData(this.plugin.settings);
      }));
    new Setting(this.containerEl)
      .setName("Backup folder")
      .setDesc("Every update saves a backup here (vault text copy, compendium sources, Excel lists). Keep it outside the vault.")
      .addText(text => text.setValue(this.plugin.settings.backupDir).onChange(async value => {
        this.plugin.settings.backupDir = value.trim() || DEFAULTS.backupDir;
        await this.plugin.saveData(this.plugin.settings);
      }));
  }
}

module.exports = class IncarnosFoundrySync extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.ribbon = this.addRibbonIcon("refresh-cw", "Update Foundry from vault", () => this.sync());
    this.addCommand({ id: "update-foundry", name: "Update Foundry from vault", callback: () => this.sync() });
    this.addSettingTab(new SettingsTab(this.app, this));
  }

  sync() {
    if (this.running) return new Notice("Foundry update is already running…");
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return new Notice("Updating Foundry only works in the desktop app.");
    const { systemPath, node, backupDir } = this.settings;
    const script = path.join(systemPath, "tools", "sync-vault.mjs");
    if (!existsSync(script)) {
      return new LogModal(this.app, "Foundry update", `Sync script not found:\n${script}\n\nCheck the Foundry system folder in the plugin settings.`).open();
    }

    this.running = true;
    this.ribbon.addClass("is-disabled");
    const progress = new Notice("Updating Foundry from the vault…", 0);
    let output = "";
    let done = false;
    const finish = (code, error) => {
      if (done) return;
      done = true;
      this.running = false;
      this.ribbon.removeClass("is-disabled");
      progress.hide();
      const log = output.trim();
      if (error) {
        new LogModal(this.app, "Foundry update failed", `Could not start Node (${node}):\n${error.message}\n\nCheck the Node path in the plugin settings.`).open();
      } else if (code === 0 && !log.includes("  ! ")) {
        new Notice(`Foundry updated\n${log}`, 10000);
      } else if (code === 0) {
        new LogModal(this.app, "Foundry updated, with warnings", log).open();
      } else if (code === 2) {
        new LogModal(this.app, "Foundry: close the world first", log).open();
      } else {
        new LogModal(this.app, "Foundry update failed", log || `Exit code ${code}`).open();
      }
    };

    const child = spawn(node, [script, adapter.getBasePath()], { cwd: systemPath, windowsHide: true, env: { ...process.env, INCARNOS_BACKUP_DIR: backupDir } });
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { output += data; });
    child.on("error", error => finish(null, error));
    child.on("close", code => finish(code));
  }
};
