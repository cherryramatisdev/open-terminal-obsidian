"use strict";

// Plugin entry point. Bundled into ../main.js by esbuild (npm run build).

const { Plugin, Notice, FileSystemAdapter, TFile, TFolder } = require("obsidian");
const path = require("path");
const { VIEW_TYPE, BLOCK_LANG, DEFAULT_SETTINGS } = require("./constants");
const shell = require("./shell");
const { TerminalView } = require("./terminal-view");
const { BlockSessions, blockKey, newBlockMarkdown } = require("./block-sessions");
const { getActiveCanvas, addPiHarnessToCanvas, addTerminalToCanvas } = require("./canvas");
const { OpenTerminalSettingTab } = require("./settings-tab");
const { HarnessManager } = require("./harness-manager");
const { HarnessProviderRegistry, PiHarnessProvider } = require("./harness-provider");
const { GENERIC_HARNESS_LANGUAGE, HARNESS_LANGUAGE } = require("./pi-harness");

class OpenTerminalPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.harnessLanguage = HARNESS_LANGUAGE;
    this.harnesses = new HarnessManager(this, new HarnessProviderRegistry([
      new PiHarnessProvider(this),
    ]));
    this.registerEvent(this.app.vault.on("modify", (file) => this.harnesses.scheduleDelivery(file)));

    this.registerView(VIEW_TYPE, (leaf) => new TerminalView(leaf, this));
    this.addRibbonIcon("terminal-square", "Open terminal", () => this.openTerminal(this.getVaultPath()));

    this.addCommand({
      id: "open-terminal-vault",
      name: "Open terminal at vault root",
      callback: () => this.openTerminal(this.getVaultPath()),
    });

    this.addCommand({
      id: "open-terminal-current-folder",
      name: "Open terminal at current note's folder",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) this.openTerminal(this.getAbsolutePath(file.parent));
        return true;
      },
    });

    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      const folder = file instanceof TFolder ? file : file instanceof TFile ? file.parent : null;
      if (!folder) return;
      menu.addItem((item) => item.setTitle("Open in terminal").setIcon("terminal-square").onClick(() => this.openTerminal(this.getAbsolutePath(folder))));
      if (!(file instanceof TFile) || file.extension !== "canvas") return;
      menu.addItem((item) => item.setTitle("Add harness").setIcon("bot").onClick(async () => {
        await this.app.workspace.getLeaf(false).openFile(file);
        const canvas = getActiveCanvas(this.app);
        if (canvas) addPiHarnessToCanvas(canvas);
      }));
    }));

    this.registerEvent(this.app.workspace.on("canvas-menu", (menu, canvas) => {
      const targetCanvas = canvas || getActiveCanvas(this.app);
      if (!targetCanvas) return;
      menu.addItem((item) => item.setTitle("Add harness").setIcon("bot").onClick(() => addPiHarnessToCanvas(targetCanvas)));
    }));

    this.blocks = new BlockSessions(this);
    this.registerMarkdownCodeBlockProcessor(BLOCK_LANG, (source, el, ctx) => this.blocks.process(source, el, ctx));

    this.piHarnessBlocks = new BlockSessions(this, {
      language: [HARNESS_LANGUAGE, GENERIC_HARNESS_LANGUAGE],
      keyFor: (source, sourcePath) => `${sourcePath}::${blockKey(source, sourcePath)}`,
      createSession: (_opts, ctx, source) => this.harnesses.create(source, ctx.sourcePath),
    });
    this.registerMarkdownCodeBlockProcessor(HARNESS_LANGUAGE, (source, el, ctx) => this.piHarnessBlocks.process(source, el, ctx));
    this.registerMarkdownCodeBlockProcessor(GENERIC_HARNESS_LANGUAGE, (source, el, ctx) => this.piHarnessBlocks.process(source, el, ctx));

    this.addCommand({
      id: "insert-terminal-block",
      name: "Insert terminal into note",
      editorCallback: (editor) => editor.replaceSelection(newBlockMarkdown() + "\n"),
    });
    this.addCommand({
      id: "add-terminal-to-canvas",
      name: "Add terminal to canvas",
      checkCallback: (checking) => {
        const canvas = getActiveCanvas(this.app);
        if (!canvas) return false;
        if (!checking) addTerminalToCanvas(canvas);
        return true;
      },
    });
    this.addCommand({
      id: "create-pi-harness-on-canvas",
      name: "Create Pi harness on Canvas",
      checkCallback: (checking) => {
        const canvas = getActiveCanvas(this.app);
        if (!canvas) return false;
        if (!checking) addPiHarnessToCanvas(canvas);
        return true;
      },
    });

    this.addSettingTab(new OpenTerminalSettingTab(this.app, this));
  }

  onunload() {
    this.blocks.disposeAll();
    this.piHarnessBlocks.disposeAll();
    this.harnesses.dispose();
  }

  notify(message) {
    new Notice(message);
  }

  async runInTerminal(command, { cwd, reuse = false } = {}) {
    cwd = cwd || this.getVaultPath();
    if (reuse) {
      const view = this.getTerminals().find((candidate) => candidate.isAtPrompt());
      if (view) {
        view.reveal();
        view.sendText(`${this.cdCommand(cwd)} ${this.shellSeparator()} ${command}`);
        return view;
      }
    }
    return this.openTerminal(cwd, command);
  }

  getTerminals() {
    const views = this.app.workspace.getLeavesOfType(VIEW_TYPE)
      .map((leaf) => leaf.view)
      .filter((view) => view instanceof TerminalView)
      .reverse();
    return [...views, ...this.blocks.visible()];
  }

  async openTerminal(cwd, command, env) {
    if (!cwd) {
      this.notify("Could not determine the folder path.");
      return;
    }
    const { workspace } = this;
    let leaf;
    switch (this.settings.location) {
      case "tab": leaf = workspace.getLeaf("tab"); break;
      case "right": leaf = workspace.getRightLeaf(false); break;
      default: leaf = workspace.getLeaf("split", "horizontal");
    }
    await leaf.setViewState({ type: VIEW_TYPE, active: true, state: { cwd, command, env } });
    workspace.revealLeaf(leaf);
    return leaf.view;
  }

  loadXterm() {
    if (!this.xterm) {
      const base = path.join(this.pluginDir(), "node_modules", "@xterm");
      const { Terminal } = window.require(path.join(base, "xterm", "lib", "xterm.js"));
      const { FitAddon } = window.require(path.join(base, "addon-fit", "lib", "addon-fit.js"));
      this.xterm = { Terminal, FitAddon };
    }
    return this.xterm;
  }

  getShell() { return shell.getShell(this.settings); }
  resolveNodePath() { return shell.resolveNodePath(this.settings); }
  cdCommand(dir) { return shell.cdCommand(this.getShell().cmd, dir); }
  shellSeparator() { return shell.shellSeparator(this.getShell().cmd); }
  quoteArg(arg) { return shell.quoteArg(this.getShell().cmd, arg); }
  pluginDir() { return path.join(this.getVaultPath(), this.manifest.dir); }
  hostPath() { return path.join(this.pluginDir(), "pty-host.js"); }

  getVaultPath() {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
  }

  getAbsolutePath(folder) {
    const base = this.getVaultPath();
    if (!base) return null;
    if (!folder || folder.isRoot()) return base;
    return path.join(base, folder.path);
  }

  async loadSettings() {
    const stored = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
    this.settings.harnessProviders = Object.assign({}, DEFAULT_SETTINGS.harnessProviders, stored?.harnessProviders);
    this.settings.harnessProviders.pi = Object.assign(
      {},
      DEFAULT_SETTINGS.harnessProviders.pi,
      this.settings.harnessProviders.pi,
      stored?.piPath ? { executable: stored.piPath } : {}
    );
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

module.exports = OpenTerminalPlugin;
