"use strict";

// Plugin entry point. Bundled into ../main.js by esbuild (npm run build).

const { Plugin, Notice, FileSystemAdapter, ItemView, TFile, TFolder } = require("obsidian");
const crypto = require("crypto");
const fsp = require("fs/promises");
const path = require("path");
const { VIEW_TYPE, BLOCK_LANG, DEFAULT_SETTINGS } = require("./constants");
const shell = require("./shell");
const { TerminalView } = require("./terminal-view");
const { TerminalSession } = require("./terminal-session");
const { BlockSessions, newBlockMarkdown } = require("./block-sessions");
const { getActiveCanvas, addPiHarnessToCanvas, addTerminalToCanvas } = require("./canvas");
const { OpenTerminalSettingTab } = require("./settings-tab");
const { createBridgeMessage, createBridgeSession, waitForAcknowledgement, writeBridgeMessage, validateCanvasWriteOperation, writeCanvasWriteAcknowledgement } = require("./pi-bridge-transport");
const { buildCanvasMessageContent, getOutgoingTargets, messageFingerprint, parseCanvasGraph, resolveIncomingSourceNodes } = require("./canvas-graph");
const { writeCanvasOrVaultTarget } = require("./canvas-writer");
const { findDuplicateHarnessIds, HARNESS_LANGUAGE, parsePiHarnessNode } = require("./pi-harness");

class OpenTerminalPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.piHarnessSessions = new Map();
    this.autoDeliveryFingerprints = new Map();
    this.autoDeliveryTimers = new Map();
    this.canvasWriteWatchers = new Map();
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

    this.addSettingTab(new OpenTerminalSettingTab(this.app, this));
  }

  onunload() {
    this.blocks.disposeAll();
    this.piHarnessBlocks.disposeAll();
    for (const timer of this.autoDeliveryTimers.values()) clearTimeout(timer);
    this.autoDeliveryTimers.clear();
    for (const watcher of this.canvasWriteWatchers.values()) clearInterval(watcher);
    this.canvasWriteWatchers.clear();
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
    sourcePath = sourcePath || this.getActiveCanvasPath();
    if (!sourcePath) {
      new Notice("Could not determine the Canvas file for this Pi harness.");
      return null;
    }
    const declaration = parsePiHarnessNode(`\`\`\`${HARNESS_LANGUAGE}\n${source}\n\`\`\``);
    if (!declaration.valid) {
      new Notice(`Invalid Pi harness: ${declaration.errors.join(" ")}`);
      return null;
    }
    const harnessId = declaration.harness.id;
    const existing = this.piHarnessSessions.get(harnessId);
    if (existing && existing.terminal && !existing.terminal.disposed) return existing.terminal;
    const bridge = await createBridgeSession();
    bridge.harnessId = harnessId;
    bridge.canvasPath = sourcePath;
    bridge.harnessNodeId = await this.findHarnessNodeId(sourcePath, harnessId);
    const targets = await this.getCanvasWriteTargets(bridge);
    const vaultPath = this.getVaultPath();
    const env = {
      OPEN_TERMINAL_VAULT_ID: crypto.createHash("sha256").update(vaultPath).digest("hex"),
      OPEN_TERMINAL_HARNESS_ID: harnessId,
      OPEN_TERMINAL_BRIDGE_DIR: bridge.directory,
      OPEN_TERMINAL_BRIDGE_TOKEN: bridge.bridgeToken,
      OPEN_TERMINAL_PROTOCOL_VERSION: String(bridge.protocolVersion),
      OPEN_TERMINAL_CANVAS_PATH: bridge.canvasPath || "",
      OPEN_TERMINAL_HARNESS_NODE_ID: bridge.harnessNodeId || "",
      OPEN_TERMINAL_CANVAS_TARGETS: JSON.stringify(targets),
    };
    const executable = this.settings.piPath.trim() || "pi";
    const bridgeExtensionPath = path.join(this.pluginDir(), "bridge", "open-terminal-canvas.js");
    const piCommand = `${this.quoteArg(executable)} --extension ${this.quoteArg(bridgeExtensionPath)} --exclude-tools edit,write`;
    const terminal = new TerminalSession(this, { cwd: vaultPath, command: piCommand, env });
    bridge.terminal = terminal;
    this.piHarnessSessions.set(harnessId, bridge);
    this.startCanvasWriteWatcher(bridge);
    if (sourcePath) void this.baselineAutoDelivery(sourcePath, harnessId);
    return terminal;
  }

  getActiveCanvasPath() {
    const view = this.app.workspace.getActiveViewOfType(ItemView);
    if (!view || view.getViewType() !== "canvas") return null;
    return view.file?.path || view.getState?.().file || null;
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

  async findHarnessNodeId(sourcePath, harnessId) {
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile) || file.extension !== "canvas") return null;
    const graph = parseCanvasGraph(await this.app.vault.cachedRead(file));
    const matches = graph.nodes.filter((node) => node.type === "text" && parsePiHarnessNode(node.text).harness?.id === harnessId);
    return matches.length === 1 ? matches[0].id : null;
  }

  async getCanvasWriteTargets(bridge) {
    if (!bridge.canvasPath || !bridge.harnessNodeId) return [];
    const file = this.app.vault.getAbstractFileByPath(bridge.canvasPath);
    if (!(file instanceof TFile)) return [];
    try {
      const graph = parseCanvasGraph(await this.app.vault.cachedRead(file));
      return getOutgoingTargets(graph, bridge.harnessNodeId);
    } catch {
      return [];
    }
  }

  startCanvasWriteWatcher(bridge) {
    bridge.writeProcessing = Promise.resolve();
    const process = () => {
      bridge.writeProcessing = bridge.writeProcessing.then(() => this.processCanvasWriteOperations(bridge)).catch(() => {});
    };
    const timer = setInterval(process, 100);
    this.canvasWriteWatchers.set(bridge.harnessId, timer);
    process();
  }

  async processCanvasWriteOperations(bridge) {
    if (!bridge || !bridge.canvasPath) return;
    let names;
    try { names = (await fsp.readdir(bridge.outboxDirectory)).filter((name) => name.endsWith(".json")).sort(); } catch { return; }
    for (const name of names) {
      const operationPath = path.join(bridge.outboxDirectory, name);
      let operation;
      try {
        operation = JSON.parse(await fsp.readFile(operationPath, "utf8"));
        validateCanvasWriteOperation(operation, { harnessId: bridge.harnessId, bridgeToken: bridge.bridgeToken });
        if (operation.canvasPath !== bridge.canvasPath) throw new Error("Canvas operation does not match the active harness session.");
        if (bridge.harnessNodeId && operation.harnessNodeId !== bridge.harnessNodeId) throw new Error("Canvas operation targets a different harness node.");
        const harnessNodeId = bridge.harnessNodeId || operation.harnessNodeId;
        bridge.harnessNodeId = harnessNodeId;
        const canvasFile = this.app.vault.getAbstractFileByPath(bridge.canvasPath);
        if (!(canvasFile instanceof TFile)) throw new Error(`Canvas file "${bridge.canvasPath}" was not found.`);
        const result = await writeCanvasOrVaultTarget({ vault: this.app.vault, canvasFile, harnessNodeId, targetNodeId: operation.targetNodeId, content: operation.content, mode: operation.mode });
        await this.writeCanvasOperationAck(bridge, operation, { status: "accepted", ...result });
        await this.moveCanvasOperation(operationPath, path.join(bridge.writeProcessedDirectory, name));
      } catch (error) {
        const operationId = operation && operation.operationId ? operation.operationId : path.basename(name, ".json");
        if (typeof operationId === "string" && operationId.startsWith("write-")) {
          await this.writeCanvasOperationAck(bridge, { operationId, harnessId: bridge.harnessId }, { status: "rejected", error: error.message });
          await this.moveCanvasOperation(operationPath, path.join(bridge.writeErrorsDirectory, name));
        }
      }
    }
  }

  async writeCanvasOperationAck(bridge, operation, result) {
    await writeCanvasWriteAcknowledgement(bridge, {
      version: bridge.protocolVersion,
      operationId: operation.operationId,
      harnessId: bridge.harnessId,
      receivedAt: new Date().toISOString(),
      ...result,
    });
  }

  async moveCanvasOperation(from, to) {
    try { await fsp.rename(from, to); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }

  async isPiHarnessRegistered(harnessId) {
    const session = this.piHarnessSessions.get(harnessId);
    if (!session) return false;
    try {
      const registration = JSON.parse(await fsp.readFile(session.sessionPath, "utf8"));
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
