"use strict";

const fsp = require("fs/promises");
const { TFile } = require("obsidian");
const { createBridgeSession } = require("./harness-transport");
const { findDuplicateHarnessIds, parseHarnessNode, parseHarnessSource } = require("./pi-harness");
const { createHarnessSession } = require("./harness-session");
const { liveCanvasContent, openCanvasPaths } = require("./canvas");
const { parseCanvasGraph } = require("./canvas-graph");

const DELIVERY_DEBOUNCE_MS = 750;

class HarnessManager {
  constructor(plugin, providers) {
    this.plugin = plugin;
    this.providers = providers;
    this.sessions = new Map();
    this.deliveryTimers = new Map();
  }

  key(canvasPath, nodeId) {
    return `${canvasPath}:${nodeId}`;
  }

  async create(source, sourcePath) {
    const declaration = parseHarnessSource(source);
    if (!declaration.valid) {
      this.plugin.notify(`Invalid harness: ${declaration.errors.join(" ")}`);
      return null;
    }
    const provider = this.providers.get(declaration.harness.agent);
    if (!provider) {
      this.plugin.notify(`Unsupported harness provider "${declaration.harness.agent}".`);
      return null;
    }
    const candidates = canvasCandidates(sourcePath, openCanvasPaths(this.plugin.app));
    const located = await this.locate(candidates, declaration.harness.id);
    if (!located) {
      this.plugin.notify(`Could not uniquely identify harness "${declaration.harness.id}" in ${candidates[0] || "an open Canvas"}.`);
      return null;
    }
    const { canvasPath, harnessNodeId, graph } = located;
    const key = this.key(canvasPath, harnessNodeId);
    const existing = this.sessions.get(key);
    if (existing && !existing.disposed) return existing.terminal;

    const bridge = await createBridgeSession();
    bridge.harnessId = declaration.harness.id;
    bridge.canvasPath = canvasPath;
    bridge.harnessNodeId = harnessNodeId;
    let session;
    try {
      session = await createHarnessSession({
        plugin: this.plugin,
        provider,
        bridge,
        graph,
        key,
        harnessId: declaration.harness.id,
        canvasPath,
        harnessNodeId,
      });
    } catch (error) {
      await fsp.rm(bridge.directory, { recursive: true, force: true }).catch(() => {});
      this.plugin.notify(`Could not start harness "${declaration.harness.id}": ${error.message}`);
      return null;
    }
    session.onDispose = () => this.remove(session);
    this.sessions.set(key, session);
    session.start();
    return session.terminal;
  }

  scheduleDelivery(file) {
    if (!(file instanceof TFile) || file.extension !== "canvas") return;
    clearTimeout(this.deliveryTimers.get(file.path));
    this.deliveryTimers.set(file.path, setTimeout(() => {
      this.deliveryTimers.delete(file.path);
      void this.deliver(file);
    }, DELIVERY_DEBOUNCE_MS));
  }

  async deliver(file) {
    let graph;
    try {
      graph = (await this.canvasGraphs(file.path))[0];
      if (!graph || findDuplicateHarnessIds(graph.nodes).length) return;
    } catch {
      return;
    }
    for (const node of graph.nodes.filter((candidate) => candidate.type === "text")) {
      const declaration = parseHarnessNode(node.text);
      if (!declaration.valid) continue;
      const session = this.sessions.get(this.key(file.path, node.id));
      if (!session) continue;
      try {
        await session.deliver(graph);
      } catch (error) {
        session.fingerprint = null;
        this.plugin.notify(`Could not auto-send data to ${declaration.harness.id}: ${error.message}`);
      }
    }
  }

  /** First candidate Canvas that holds exactly one node declaring the harness. */
  async locate(canvasPaths, harnessId) {
    for (const canvasPath of canvasPaths) {
      for (const graph of await this.canvasGraphs(canvasPath)) {
        const matches = graph.nodes.filter((node) => node.type === "text" && parseHarnessNode(node.text).harness?.id === harnessId);
        if (matches.length === 1) return { canvasPath, harnessNodeId: matches[0].id, graph };
        if (matches.length > 1) return null;
      }
    }
    return null;
  }

  /**
   * A Canvas code block has no source path and a card Obsidian created moments ago may not be
   * in the saved file yet, so the live Canvas document is searched before the file on disk.
   */
  async canvasGraphs(canvasPath) {
    const contents = [liveCanvasContent(this.plugin.app, canvasPath)];
    const file = this.plugin.app.vault.getAbstractFileByPath(canvasPath);
    if (file instanceof TFile) contents.push(await this.plugin.app.vault.cachedRead(file));
    return contents.filter(Boolean).map((content) => parseCanvasGraph(content));
  }

  remove(session) {
    if (this.sessions.get(session.key) === session) this.sessions.delete(session.key);
  }

  dispose() {
    for (const timer of this.deliveryTimers.values()) clearTimeout(timer);
    this.deliveryTimers.clear();
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
  }
}

/** Canvas files that may own a block: its own file first, then the open Canvas views. */
function canvasCandidates(sourcePath, openPaths) {
  const paths = [];
  for (const candidate of [sourcePath, ...openPaths]) {
    if (typeof candidate === "string" && candidate.endsWith(".canvas") && !paths.includes(candidate)) paths.push(candidate);
  }
  return paths;
}

module.exports = { HarnessManager };
