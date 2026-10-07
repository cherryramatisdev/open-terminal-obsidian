"use strict";

// Plugin entry point. Bundled into ../main.js by esbuild (npm run build).

const { Plugin, Notice, FileSystemAdapter, TFile, TFolder } = require("obsidian");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { VIEW_TYPE, BLOCK_LANG, DEFAULT_SETTINGS } = require("./constants");
const shell = require("./shell");
const { TerminalView } = require("./terminal-view");
const { TerminalSession } = require("./terminal-session");
const { BlockSessions, newBlockMarkdown } = require("./block-sessions");
const { getActiveCanvas, addPiHarnessToCanvas, addTerminalToCanvas } = require("./canvas");
const { OpenTerminalSettingTab } = require("./settings-tab");
const { BridgeModifiedError, ensurePiBridgeInstalled } = require("./pi-bridge-installer");
const { createBridgeMessage, createBridgeSession, waitForAcknowledgement, writeBridgeMessage } = require("./pi-bridge-transport");
const { buildCanvasMessageContent, messageFingerprint, parseCanvasGraph, resolveIncomingSourceNodes } = require("./canvas-graph");
const { findDuplicateHarnessIds, HARNESS_LANGUAGE, parsePiHarnessNode } = require("./pi-harness");

class OpenTerminalPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.piHarnessSessions = new Map();
    this.autoDeliveryFingerprints = new Map();
    this.autoDeliveryTimers = new Map();
    this.registerEvent(this.app.vault.on("modify", (file) => this.scheduleAutoDelivery(file)));

    this.registerView(VIEW_TYPE, (leaf) => new TerminalView(leaf, this));

    this.addRibbonIcon("terminal-square", "Open terminal", () => {
      this.openTerminal(this.getVaultPath());
    });

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

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        const folder = file instanceof TFolder ? file : file instanceof TFile ? file.parent : null;
        if (!folder) return;
        menu.addItem((item) =>
          item
            .setTitle("Open in terminal")
            .setIcon("terminal-square")
            .onClick(() => this.openTerminal(this.getAbsolutePath(folder)))
        );
        if (!(file instanceof TFile) || file.extension !== "canvas") return;
        menu.addItem((item) =>
          item
            .setTitle("Add harness")
            .setIcon("bot")
            .onClick(async () => {
              await this.app.workspace.getLeaf(false).openFile(file);
              const canvas = getActiveCanvas(this.app);
              if (canvas) addPiHarnessToCanvas(canvas);
            })
        );
      })
    );

    this.registerEvent(
      this.app.workspace.on("canvas-menu", (menu, canvas) => {
        const targetCanvas = canvas || getActiveCanvas(this.app);
        if (!targetCanvas) return;
        menu.addItem((item) =>
          item
            .setTitle("Add harness")
            .setIcon("bot")
            .onClick(() => addPiHarnessToCanvas(targetCanvas))
        );
      })
    );

    // Terminals embedded in ```terminal blocks (notes and Canvas)
    this.blocks = new BlockSessions(this);
    this.registerMarkdownCodeBlockProcessor(BLOCK_LANG, (source, el, ctx) => this.blocks.process(source, el, ctx));

    this.piHarnessBlocks = new BlockSessions(this, {
      language: HARNESS_LANGUAGE,
      createSession: (_opts, ctx, source) => this.createEmbeddedPiHarnessSession(source, ctx.sourcePath),
    });
    this.registerMarkdownCodeBlockProcessor(HARNESS_LANGUAGE, (source, el, ctx) => this.piHarnessBlocks.process(source, el, ctx));

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

    this.addCommand({
      id: "install-pi-bridge",
      name: "Install Open Terminal Pi bridge",
      callback: () => this.installPiBridge(),
    });

    this.addCommand({
      id: "reinstall-pi-bridge",
      name: "Reinstall Open Terminal Pi bridge (overwrite local changes)",
      callback: () => this.installPiBridge({ force: true }),
    });

    this.addSettingTab(new OpenTerminalSettingTab(this.app, this));
  }

  onunload() {
    this.blocks.disposeAll();
    this.piHarnessBlocks.disposeAll();
    for (const timer of this.autoDeliveryTimers.values()) clearTimeout(timer);
    this.autoDeliveryTimers.clear();
  }

  /**
   * Public API for other plugins: opens a terminal and runs a command.
   * E.g.: app.plugins.plugins["open-terminal"].runInTerminal("claude", { cwd })
   */
  async runInTerminal(command, { cwd, reuse = false } = {}) {
    cwd = cwd || this.getVaultPath();
    if (reuse) {
      const view = this.getTerminals().find((v) => v.isAtPrompt());
      if (view) {
        view.reveal();
        view.sendText(`${this.cdCommand(cwd)} ${this.shellSeparator()} ${command}`);
        return view;
      }
    }
    return this.openTerminal(cwd, command);
  }

  /**
   * Open terminals: views (newest to oldest), then blocks visible in
   * notes/Canvas (most recently used first).
   */
  getTerminals() {
    const views = this.app.workspace
      .getLeavesOfType(VIEW_TYPE)
      .map((l) => l.view)
      .filter((v) => v instanceof TerminalView)
      .reverse();
    return [...views, ...this.blocks.visible()];
  }

  async openTerminal(cwd, command, env) {
    if (!cwd) {
      new Notice("Could not determine the folder path.");
      return;
    }
    const { workspace } = this.app;
    let leaf;
    switch (this.settings.location) {
      case "tab":
        leaf = workspace.getLeaf("tab");
        break;
      case "right":
        leaf = workspace.getRightLeaf(false);
        break;
      default:
        leaf = workspace.getLeaf("split", "horizontal");
    }
    await leaf.setViewState({ type: VIEW_TYPE, active: true, state: { cwd, command, env } });
    workspace.revealLeaf(leaf);
    return leaf.view;
  }

  async installPiBridge({ force = false } = {}) {
    const vaultPath = this.getVaultPath();
    if (!vaultPath) {
      new Notice("Could not determine the vault path for Pi bridge installation.");
      return null;
    }

    try {
      const result = await ensurePiBridgeInstalled({
        sourcePath: path.join(this.pluginDir(), "bridge", "open-terminal-canvas.js"),
        vaultPath,
        pluginVersion: this.manifest.version,
        force,
      });
      const action = result.status === "current" ? "is already current" : `${result.status} successfully`;
      new Notice(`Open Terminal Pi bridge ${action}.`);
      return result;
    } catch (error) {
      if (error instanceof BridgeModifiedError) {
        new Notice("The Open Terminal Pi bridge has local changes. Use the reinstall command to overwrite it.");
        return null;
      }
      new Notice(`Could not install the Open Terminal Pi bridge: ${error.message}`);
      return null;
    }
  }

  scheduleAutoDelivery(file) {
    if (!(file instanceof TFile) || file.extension !== "canvas") return;
    clearTimeout(this.autoDeliveryTimers.get(file.path));
    this.autoDeliveryTimers.set(file.path, setTimeout(() => {
      this.autoDeliveryTimers.delete(file.path);
      void this.autoDeliverCanvasChanges(file);
    }, 750));
  }

  async resolveCanvasSources(graph, harnessNodeId) {
    return resolveIncomingSourceNodes(graph, harnessNodeId, async (sourcePath) => {
      const file = this.app.vault.getAbstractFileByPath(sourcePath);
      if (!(file instanceof TFile)) throw new Error(`Referenced Canvas file "${sourcePath}" was not found in the vault.`);
      return this.app.vault.cachedRead(file);
    });
  }

  async autoDeliverCanvasChanges(file) {
    let graph;
    try {
      graph = parseCanvasGraph(await this.app.vault.cachedRead(file));
      if (findDuplicateHarnessIds(graph.nodes).length) return;
    } catch {
      return;
    }
    for (const node of graph.nodes.filter((candidate) => candidate.type === "text")) {
      const declaration = parsePiHarnessNode(node.text);
      if (!declaration.valid) continue;
      const harnessId = declaration.harness.id;
      const bridge = this.piHarnessSessions.get(harnessId);
      if (!bridge || !(await this.isPiHarnessRegistered(harnessId))) continue;
      try {
        const sources = await this.resolveCanvasSources(graph, node.id);
        if (sources.length === 0) {
          this.autoDeliveryFingerprints.set(`${file.path}:${harnessId}`, null);
          continue;
        }
        const assembled = buildCanvasMessageContent(sources);
        const key = `${file.path}:${harnessId}`;
        const fingerprint = messageFingerprint(assembled);
        if (this.autoDeliveryFingerprints.get(key) === fingerprint) continue;
        this.autoDeliveryFingerprints.set(key, fingerprint);
        const message = createBridgeMessage({
          harnessId,
          bridgeToken: bridge.bridgeToken,
          canvasPath: file.path,
          workingDirectory: this.getVaultPath(),
          sourceNodes: assembled.sourceNodes,
          content: assembled.content,
        });
        await writeBridgeMessage(bridge, message);
        const acknowledgement = await waitForAcknowledgement(bridge, message.id);
        new Notice(`Pi harness ${harnessId}: ${acknowledgement.status}.`);
      } catch (error) {
        this.autoDeliveryFingerprints.delete(`${file.path}:${harnessId}`);
        new Notice(`Could not auto-send Canvas data to Pi: ${error.message}`);
      }
    }
  }

  /** Creates the live Pi terminal rendered inside a pi-harness Canvas card. */
  async createEmbeddedPiHarnessSession(source, sourcePath) {
    const declaration = parsePiHarnessNode(`\`\`\`${HARNESS_LANGUAGE}\n${source}\n\`\`\``);
    if (!declaration.valid) {
      new Notice(`Invalid Pi harness: ${declaration.errors.join(" ")}`);
      return null;
    }
    const harnessId = declaration.harness.id;
    const existing = this.piHarnessSessions.get(harnessId);
    if (existing && existing.terminal && !existing.terminal.disposed) return existing.terminal;
    if (!(await this.installPiBridge())) return null;

    const bridge = await createBridgeSession();
    bridge.harnessId = harnessId;
    const vaultPath = this.getVaultPath();
    const env = {
      OPEN_TERMINAL_VAULT_ID: crypto.createHash("sha256").update(vaultPath).digest("hex"),
      OPEN_TERMINAL_HARNESS_ID: harnessId,
      OPEN_TERMINAL_BRIDGE_DIR: bridge.directory,
      OPEN_TERMINAL_BRIDGE_TOKEN: bridge.bridgeToken,
      OPEN_TERMINAL_PROTOCOL_VERSION: String(bridge.protocolVersion),
    };
    const executable = this.settings.piPath.trim() || "pi";
    const terminal = new TerminalSession(this, { cwd: vaultPath, command: this.quoteArg(executable), env });
    bridge.terminal = terminal;
    this.piHarnessSessions.set(harnessId, bridge);
    if (sourcePath) void this.baselineAutoDelivery(sourcePath, harnessId);
    return terminal;
  }

  async baselineAutoDelivery(sourcePath, harnessId) {
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile) || file.extension !== "canvas") return;
    try {
      const graph = parseCanvasGraph(await this.app.vault.cachedRead(file));
      const node = graph.nodes.find((candidate) => {
        const declaration = candidate.type === "text" && parsePiHarnessNode(candidate.text);
        return declaration && declaration.valid && declaration.harness.id === harnessId;
      });
      const sources = node ? await this.resolveCanvasSources(graph, node.id) : [];
      this.autoDeliveryFingerprints.set(`${file.path}:${harnessId}`, sources.length ? messageFingerprint(buildCanvasMessageContent(sources)) : null);
    } catch {}
  }

  async isPiHarnessRegistered(harnessId) {
    const session = this.piHarnessSessions.get(harnessId);
    if (!session) return false;
    try {
      const registration = JSON.parse(await fs.readFile(session.sessionPath, "utf8"));
      return registration.protocolVersion === session.protocolVersion && registration.harnessId === harnessId;
    } catch {
      return false;
    }
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

  getShell() {
    return shell.getShell(this.settings);
  }

  resolveNodePath() {
    return shell.resolveNodePath(this.settings);
  }

  cdCommand(dir) {
    return shell.cdCommand(this.getShell().cmd, dir);
  }

  shellSeparator() {
    return shell.shellSeparator(this.getShell().cmd);
  }

  quoteArg(arg) {
    return shell.quoteArg(this.getShell().cmd, arg);
  }

  pluginDir() {
    return path.join(this.getVaultPath(), this.manifest.dir);
  }

  hostPath() {
    return path.join(this.pluginDir(), "pty-host.js");
  }

  getVaultPath() {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
    return null;
  }

  getAbsolutePath(folder) {
    const base = this.getVaultPath();
    if (!base) return null;
    if (!folder || folder.isRoot()) return base;
    return path.join(base, folder.path);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

module.exports = OpenTerminalPlugin;
