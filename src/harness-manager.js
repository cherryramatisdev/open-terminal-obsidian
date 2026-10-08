"use strict";

const { TFile } = require("obsidian");
const { createBridgeSession } = require("./harness-transport");
const { findDuplicateHarnessIds, parseHarnessNode, parseHarnessSource } = require("./pi-harness");
const { createHarnessSession } = require("./harness-session");
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

  async create(source, canvasPath) {
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
    const harnessNodeId = await this.findNode(canvasPath, declaration.harness.id);
    if (!harnessNodeId) {
      this.plugin.notify(`Could not uniquely identify harness "${declaration.harness.id}" in ${canvasPath}.`);
      return null;
    }
    const key = this.key(canvasPath, harnessNodeId);
    const existing = this.sessions.get(key);
    if (existing && !existing.disposed) return existing.terminal;

    const bridge = await createBridgeSession();
    bridge.harnessId = declaration.harness.id;
    bridge.canvasPath = canvasPath;
    bridge.harnessNodeId = harnessNodeId;
    const session = await createHarnessSession({
      plugin: this.plugin,
      provider,
      bridge,
      key,
      harnessId: declaration.harness.id,
      canvasPath,
      harnessNodeId,
    });
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
      graph = parseCanvasGraph(await this.plugin.app.vault.cachedRead(file));
      if (findDuplicateHarnessIds(graph.nodes).length) return;
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

  async findNode(canvasPath, harnessId) {
    const file = this.plugin.app.vault.getAbstractFileByPath(canvasPath);
    if (!(file instanceof TFile)) return null;
    const graph = parseCanvasGraph(await this.plugin.app.vault.cachedRead(file));
    const matches = graph.nodes.filter((node) => node.type === "text" && parseHarnessNode(node.text).harness?.id === harnessId);
    return matches.length === 1 ? matches[0].id : null;
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

module.exports = { HarnessManager };
