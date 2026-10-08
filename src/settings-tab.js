"use strict";

const { PluginSettingTab, Setting } = require("obsidian");

class OpenTerminalSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();

    new Setting(containerEl)
      .setName("Shell")
      .setDesc("Shell launched inside the embedded terminal.")
      .addDropdown((dd) => {
        dd.addOption("auto", "Automatic (recommended)");
        if (process.platform === "win32") {
          dd.addOption("powershell", "Windows PowerShell");
          dd.addOption("pwsh", "PowerShell 7 (pwsh)");
          dd.addOption("cmd", "Command Prompt (cmd)");
        } else {
          dd.addOption("zsh", "Zsh");
          dd.addOption("bash", "Bash");
        }
        dd.addOption("custom", "Custom");
        dd.setValue(s.shell).onChange(async (v) => {
          s.shell = v;
          await save();
          this.display();
        });
      });

    if (s.shell === "custom") {
      new Setting(containerEl)
        .setName("Custom shell")
        .setDesc('Executable and arguments. E.g.: "C:\\Program Files\\Git\\bin\\bash.exe" --login')
        .addText((t) =>
          t.setValue(s.customShell).onChange(async (v) => {
            s.customShell = v;
            await save();
          })
        );
    }

    new Setting(containerEl)
      .setName("Where to open")
      .addDropdown((dd) =>
        dd
          .addOption("bottom", "Split panel below")
          .addOption("tab", "New tab")
          .addOption("right", "Right sidebar")
          .setValue(s.location)
          .onChange(async (v) => {
            s.location = v;
            await save();
          })
      );

    new Setting(containerEl)
      .setName("Pi executable")
      .setDesc('Pi executable for managed Canvas harnesses. Leave empty to use "pi" from PATH.')
      .addText((t) =>
        t
          .setPlaceholder("pi")
          .setValue(s.harnessProviders.pi.executable)
          .onChange(async (v) => {
            s.harnessProviders.pi.executable = v;
            await save();
          })
      );

    new Setting(containerEl)
      .setName("Font size")
      .setDesc("Applies to terminals opened after the change.")
      .addSlider((sl) =>
        sl
          .setLimits(9, 24, 1)
          .setValue(s.fontSize)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.fontSize = v;
            await save();
          })
      );

    new Setting(containerEl)
      .setName("Node.js path")
      .setDesc(`Leave empty to auto-detect. Detected: ${this.plugin.resolveNodePath() || "none"}`)
      .addText((t) =>
        t
          .setPlaceholder("C:\\Program Files\\nodejs\\node.exe")
          .setValue(s.nodePath)
          .onChange(async (v) => {
            s.nodePath = v;
            await save();
          })
      );
  }
}

module.exports = { OpenTerminalSettingTab };
