"use strict";

const fsp = require("fs/promises");
const path = require("path");
const { TFile } = require("obsidian");
const { createBridgeMessage, waitForAcknowledgement, writeBridgeMessage, validateCanvasWriteOperation, writeCanvasWriteAcknowledgement } = require("./harness-transport");
const { getIncomingSourceNodes, getOutgoingTargets, messageFingerprint, buildCanvasMessageContent, parseCanvasGraph, resolveIncomingSourceNodes } = require("./canvas-graph");
const { TerminalSession } = require("./terminal-session");
const { writeCanvasOrVaultTarget } = require("./canvas-writer");

class HarnessSession {
  constructor({ plugin, provider, bridge, terminal, key, harnessId, canvasPath, harnessNodeId }) {
    this.plugin = plugin;
    this.provider = provider;
    this.bridge = bridge;
    this.terminal = terminal;
    this.key = key;
    this.harnessId = harnessId;
    this.canvasPath = canvasPath;
    this.harnessNodeId = harnessNodeId;
    this.fingerprint = null;
    this.writeProcessing = Promise.resolve();
    this.writeTimer = null;
    this.onDispose = null;
    this.disposed = false;
  }

  start() {
    this.writeTimer = setInterval(() => {
      this.writeProcessing = this.writeProcessing.then(() => this.processWrites()).catch(() => {});
    }, 100);
    this.writeProcessing = this.writeProcessing.then(() => this.processWrites()).catch(() => {});
    return this.terminal;
  }

  async deliver(graph) {
    if (this.disposed || !(await this.isRegistered())) return;
    await this.syncConnections(graph);
    const sources = await resolveIncomingSourceNodes(graph, this.harnessNodeId, async (sourcePath) => {
      const file = this.plugin.app.vault.getAbstractFileByPath(sourcePath);
      if (!(file instanceof TFile)) throw new Error(`Referenced Canvas file "${sourcePath}" was not found in the vault.`);
      return this.plugin.app.vault.cachedRead(file);
    });
    if (sources.length === 0) {
      this.fingerprint = null;
      return;
    }
    const assembled = buildCanvasMessageContent(sources);
    const fingerprint = messageFingerprint(assembled);
    if (this.fingerprint === fingerprint) return;
    this.fingerprint = fingerprint;
    const message = createBridgeMessage({
      harnessId: this.harnessId,
      bridgeToken: this.bridge.bridgeToken,
      canvasPath: this.canvasPath,
      workingDirectory: this.plugin.getVaultPath(),
      sourceNodes: assembled.sourceNodes,
      content: assembled.content,
    });
    const acknowledgement = await writeBridgeMessage(this.bridge, message).then(() => waitForAcknowledgement(this.bridge, message.id));
    this.plugin.notify(`Harness ${this.harnessId}: ${acknowledgement.status}.`);
  }

  async syncConnections(graph) {
    const { connections } = resolveConnectionState(graph, this.harnessNodeId);
    await writeJsonAtomically(path.join(this.bridge.directory, "connections.json"), connections);
  }

  async isRegistered() {
    try {
      const registration = JSON.parse(await fsp.readFile(this.bridge.sessionPath, "utf8"));
      return registration.protocolVersion === this.bridge.protocolVersion &&
        registration.harnessId === this.harnessId &&
        registration.canvasPath === this.canvasPath &&
        registration.harnessNodeId === this.harnessNodeId;
    } catch {
      return false;
    }
  }

  async processWrites() {
    if (this.disposed) return;
    let names;
    try {
      names = (await fsp.readdir(this.bridge.outboxDirectory)).filter((name) => name.endsWith(".json")).sort();
    } catch {
      return;
    }
    for (const name of names) await this.processWrite(path.join(this.bridge.outboxDirectory, name), name);
  }

  async processWrite(operationPath, name) {
    let operation;
    try {
      operation = JSON.parse(await fsp.readFile(operationPath, "utf8"));
      validateCanvasWriteOperation(operation, { harnessId: this.harnessId, bridgeToken: this.bridge.bridgeToken });
      if (operation.canvasPath !== this.canvasPath) throw new Error("Canvas operation does not match the active harness session.");
      if (operation.harnessNodeId !== this.harnessNodeId) throw new Error("Canvas operation targets a different harness node.");
      const canvasFile = this.plugin.app.vault.getAbstractFileByPath(this.canvasPath);
      if (!(canvasFile instanceof TFile)) throw new Error(`Canvas file "${this.canvasPath}" was not found.`);
      const result = await writeCanvasOrVaultTarget({
        vault: this.plugin.app.vault,
        canvasFile,
        harnessNodeId: this.harnessNodeId,
        targetNodeId: operation.targetNodeId,
        content: operation.content,
        mode: operation.mode,
      });
      await this.writeAcknowledgement(operation, { status: "accepted", ...result });
      await this.move(operationPath, path.join(this.bridge.writeProcessedDirectory, name));
    } catch (error) {
      const operationId = operation?.operationId || path.basename(name, ".json");
      if (!operationId.startsWith("write-")) return;
      await this.writeAcknowledgement({ operationId }, { status: "rejected", error: error.message });
      await this.move(operationPath, path.join(this.bridge.writeErrorsDirectory, name));
    }
  }

  async writeAcknowledgement(operation, result) {
    await writeCanvasWriteAcknowledgement(this.bridge, {
      version: this.bridge.protocolVersion,
      operationId: operation.operationId,
      harnessId: this.harnessId,
      receivedAt: new Date().toISOString(),
      ...result,
    });
  }

  async move(from, to) {
    try { await fsp.rename(from, to); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.writeTimer) clearInterval(this.writeTimer);
    if (this.onDispose) this.onDispose(this);
    this.terminal.dispose();
    void fsp.rm(this.bridge.directory, { recursive: true, force: true });
  }
}

async function createHarnessSession({ plugin, provider, bridge, graph, key, harnessId, canvasPath, harnessNodeId }) {
  const file = plugin.app.vault.getAbstractFileByPath(canvasPath);
  if (!(file instanceof TFile)) throw new Error(`Canvas file "${canvasPath}" was not found in the vault.`);
  // The caller resolves the node from the live Canvas document, which runs ahead of the saved file.
  const canvasGraph = graph || parseCanvasGraph(await plugin.app.vault.cachedRead(file));
  const { targets, connections } = resolveConnectionState(canvasGraph, harnessNodeId);
  bridge.targets = targets;
  bridge.connections = connections;
  await writeJsonAtomically(path.join(bridge.directory, "connections.json"), connections);
  const launch = provider.createLaunchSpec({ bridge, vaultPath: plugin.getVaultPath() });
  const terminal = new TerminalSession(plugin, launch);
  const session = new HarnessSession({ plugin, provider, bridge, terminal, key, harnessId, canvasPath, harnessNodeId });
  terminal.onDispose = () => session.dispose();
  bridge.session = session;
  return session;
}

async function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await fsp.rename(temporaryPath, filePath);
}

function resolveConnectionState(graph, harnessNodeId) {
  const targets = getOutgoingTargets(graph, harnessNodeId);
  return { targets, connections: buildConnections(graph, harnessNodeId, targets) };
}

function buildConnections(graph, harnessNodeId, targets) {
  const incoming = getIncomingSourceNodes(graph, harnessNodeId, { allowFiles: true });
  const connections = incoming.map((node) => ({
    id: node.id,
    type: node.type,
    label: node.title,
    file: node.file || null,
    directions: ["incoming"],
  }));
  for (const target of targets) {
    const existing = connections.find((node) => node.id === target.id);
    if (existing) existing.directions.push("outgoing");
    else connections.push({ id: target.id, type: target.type, label: target.label, file: target.file, directions: ["outgoing"] });
  }
  return connections;
}

module.exports = { HarnessSession, createHarnessSession };
