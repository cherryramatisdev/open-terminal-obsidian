// Bridge loaded directly by Pi from the Open Terminal Obsidian plugin.
"use strict";

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

const PROTOCOL_VERSION = 1;
const MESSAGE_ID = /^msg-[A-Za-z0-9-]+$/;
const OPERATION_ID = /^write-[A-Za-z0-9-]+$/;

export default function openTerminalCanvasBridge(pi) {
  let watcher = null;
  let state = null;
  let processing = Promise.resolve();
  const processedIds = new Set();

  pi.registerTool(defineTool({
    name: "find_connected_nodes",
    label: "Find connected Canvas nodes",
    description: "Inspect the current Canvas graph and list every node directly connected to this Pi harness, including whether the connection is incoming or outgoing. Use this before write_canvas_node when the target ID is unknown.",
    parameters: Type.Object({}),
    async execute() {
      const nodes = await findConnectedNodes();
      return {
        content: [{ type: "text", text: JSON.stringify(nodes, null, 2) }],
        details: { nodes },
      };
    },
  }));

  pi.registerTool(defineTool({
    name: "write_canvas_node",
    label: "Write Canvas node",
    description: "Write explicit content to one direct outgoing Canvas text or file target. Call find_connected_nodes first when the target ID is unknown. Never guess, fan out, or use this tool for unrelated files. Replace is the default mode; append adds a newline boundary when needed.",
    parameters: Type.Object({
      targetNodeId: Type.String({ description: "ID of a direct outgoing Canvas target node returned by find_connected_nodes." }),
      content: Type.String({ description: "Complete content to replace or append." }),
      mode: Type.Optional(Type.Union([Type.Literal("replace"), Type.Literal("append")])),
    }),
    async execute(_toolCallId, params) {
      const bridgeState = requireBridgeState();
      const operation = {
        version: PROTOCOL_VERSION,
        operationId: randomId("write"),
        operation: "write_canvas_node",
        harnessId: bridgeState.harnessId,
        bridgeToken: bridgeState.bridgeToken,
        canvasPath: bridgeState.canvasPath,
        harnessNodeId: bridgeState.harnessNodeId,
        targetNodeId: params.targetNodeId,
        content: params.content,
        mode: params.mode || "replace",
        createdAt: new Date().toISOString(),
      };
      validateOperation(operation);
      await writeJsonAtomically(path.join(bridgeState.outboxDirectory, `${operation.operationId}.json`), operation);
      const acknowledgement = await waitForWriteAcknowledgement(operation.operationId);
      const target = acknowledgement.targetNodeId || operation.targetNodeId;
      if (acknowledgement.status !== "accepted") {
        return { isError: true, content: [{ type: "text", text: `Canvas target ${target} was rejected: ${acknowledgement.error || "write failed"}` }], details: acknowledgement };
      }
      return { content: [{ type: "text", text: `Canvas target ${target} updated with ${operation.mode}.` }], details: acknowledgement };
    },
  }));

  pi.on("tool_call", async (event) => {
    if (!state || (event.toolName !== "edit" && event.toolName !== "write")) return;
    const protectedPaths = await getProtectedPaths();
    const attemptedPaths = getToolPaths(event.toolName, event.input);
    if (attemptedPaths.some((candidate) => protectedPaths.has(candidate))) {
      return { block: true, reason: "This path is a connected Canvas output. Use write_canvas_node with an explicit targetNodeId." };
    }
  });

  pi.on("session_start", async (_event, ctx) => {
    state = readEnvironment();
    if (!state) return;

    const activeTools = pi.getActiveTools().filter((toolName) => toolName !== "edit" && toolName !== "write");
    if (state.canvasPath && state.harnessNodeId) activeTools.push("find_connected_nodes", "write_canvas_node");
    pi.setActiveTools([...new Set(activeTools)]);

    await Promise.all([
      fsp.mkdir(state.inboxDirectory, { recursive: true, mode: 0o700 }),
      fsp.mkdir(state.processedDirectory, { recursive: true, mode: 0o700 }),
      fsp.mkdir(state.acknowledgementsDirectory, { recursive: true, mode: 0o700 }),
      fsp.mkdir(state.errorsDirectory, { recursive: true, mode: 0o700 }),
      fsp.mkdir(state.outboxDirectory, { recursive: true, mode: 0o700 }),
      fsp.mkdir(state.writeAcknowledgementsDirectory, { recursive: true, mode: 0o700 }),
      fsp.mkdir(state.writeProcessedDirectory, { recursive: true, mode: 0o700 }),
      fsp.mkdir(state.writeErrorsDirectory, { recursive: true, mode: 0o700 }),
    ]);
    await writeJsonAtomically(state.sessionPath, {
      protocolVersion: PROTOCOL_VERSION,
      harnessId: state.harnessId,
      canvasPath: state.canvasPath,
      harnessNodeId: state.harnessNodeId,
      pid: process.pid,
      sessionId: state.sessionId,
      startedAt: new Date().toISOString(),
    });

    const scheduleScan = () => {
      processing = processing.then(() => scanInbox(pi, ctx)).catch(() => undefined);
    };
    watcher = fs.watch(state.inboxDirectory, scheduleScan);
    scheduleScan();
  });

  pi.on("session_shutdown", async () => {
    if (watcher) watcher.close();
    watcher = null;
    await processing;
    state = null;
  });

  function requireBridgeState() {
    state = state || readEnvironment();
    if (!state) throw new Error("Canvas bridge state is unavailable. Start this Pi session from a Canvas harness.");
    if (!state.canvasPath) throw new Error("Canvas path is missing from the harness session.");
    if (!state.harnessNodeId) throw new Error("Harness node ID is missing from the harness session.");
    return state;
  }

  async function findConnectedNodes() {
    const context = state || readEnvironment();
    if (!context) throw new Error("Canvas bridge state is unavailable.");
    return readConnections(context);
  }

  async function readConnections(context) {
    try {
      const connections = JSON.parse(await fsp.readFile(path.join(context.directory, "connections.json"), "utf8"));
      if (!Array.isArray(connections)) throw new Error("Invalid Canvas connections state.");
      return connections;
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  function readEnvironment() {
    const directory = process.env.OPEN_TERMINAL_BRIDGE_DIR;
    const harnessId = process.env.OPEN_TERMINAL_HARNESS_ID;
    const bridgeToken = process.env.OPEN_TERMINAL_BRIDGE_TOKEN;
    const protocolVersion = Number(process.env.OPEN_TERMINAL_PROTOCOL_VERSION);
    if (!directory || !harnessId || !bridgeToken || protocolVersion !== PROTOCOL_VERSION) return null;
    return {
      directory, harnessId, bridgeToken,
      canvasPath: process.env.OPEN_TERMINAL_CANVAS_PATH || "",
      harnessNodeId: process.env.OPEN_TERMINAL_HARNESS_NODE_ID || "",
      sessionId: path.basename(directory),
      inboxDirectory: path.join(directory, "inbox"),
      processedDirectory: path.join(directory, "processed"),
      acknowledgementsDirectory: path.join(directory, "acks"),
      errorsDirectory: path.join(directory, "errors"),
      outboxDirectory: path.join(directory, "outbox"),
      writeProcessedDirectory: path.join(directory, "write-processed"),
      writeAcknowledgementsDirectory: path.join(directory, "write-acks"),
      writeErrorsDirectory: path.join(directory, "write-errors"),
      sessionPath: path.join(directory, "session.json"),
    };
  }

  async function waitForWriteAcknowledgement(operationId) {
    const acknowledgementPath = path.join(state.writeAcknowledgementsDirectory, `${operationId}.json`);
    const deadline = Date.now() + 10000;
    while (Date.now() <= deadline) {
      try { return JSON.parse(await fsp.readFile(acknowledgementPath, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for Canvas acknowledgement of ${operationId}.`);
  }

  async function getProtectedPaths() {
    const paths = new Set([normalizePath(state.canvasPath)]);
    for (const connection of await readConnections(state)) {
      if (connection.directions?.includes("outgoing") && connection.type === "file" && connection.file) {
        paths.add(normalizePath(connection.file));
      }
    }
    return paths;
  }

  async function scanInbox(api, ctx) {
    if (!state) return;
    const names = (await fsp.readdir(state.inboxDirectory)).filter((name) => name.endsWith(".json")).sort();
    for (const name of names) await processMessage(api, ctx, path.join(state.inboxDirectory, name));
  }

  async function processMessage(api, ctx, messagePath) {
    if (!state) return;
    let message;
    try {
      message = JSON.parse(await fsp.readFile(messagePath, "utf8"));
      validateMessage(message);
      if (processedIds.has(message.id) || await fileExists(path.join(state.processedDirectory, `${message.id}.json`))) {
        await moveIfPresent(messagePath, path.join(state.processedDirectory, `${message.id}.json`));
        return;
      }
      const status = ctx.isIdle() ? "accepted" : "queued";
      api.sendUserMessage(message.content, status === "queued" ? { deliverAs: "followUp" } : undefined);
      processedIds.add(message.id);
      await writeAcknowledgement(message, status);
      await moveIfPresent(messagePath, path.join(state.processedDirectory, `${message.id}.json`));
    } catch (error) {
      const messageId = message && MESSAGE_ID.test(message.id) ? message.id : path.basename(messagePath, ".json");
      await writeAcknowledgement({ id: messageId }, "failed", error.message);
      await moveIfPresent(messagePath, path.join(state.errorsDirectory, `${messageId}.json`));
    }
  }

  function validateMessage(message) {
    if (!message || message.version !== PROTOCOL_VERSION) throw new Error("Unsupported bridge protocol version.");
    if (!MESSAGE_ID.test(message.id) || !message.id.startsWith("msg-")) throw new Error("Invalid bridge message ID.");
    if (message.harnessId !== state.harnessId) throw new Error("Bridge message targets a different harness.");
    if (message.bridgeToken !== state.bridgeToken) throw new Error("Bridge message token is not authorized for this session.");
    if (message.canvasPath !== state.canvasPath) throw new Error("Bridge message targets a different Canvas.");
    if (typeof message.content !== "string" || !Array.isArray(message.sourceNodes)) throw new Error("Invalid bridge message envelope.");
  }

  async function writeAcknowledgement(message, status, error) {
    if (!state || !MESSAGE_ID.test(message.id)) return;
    const acknowledgement = { version: PROTOCOL_VERSION, messageId: message.id, harnessId: state.harnessId, status, receivedAt: new Date().toISOString() };
    if (error) acknowledgement.error = error;
    await writeJsonAtomically(path.join(state.acknowledgementsDirectory, `${message.id}.json`), acknowledgement);
  }
}

function randomId(prefix) {
  return `${prefix}-${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function validateOperation(operation) {
  if (operation.version !== PROTOCOL_VERSION || operation.operation !== "write_canvas_node") throw new Error("Unsupported Canvas operation.");
  if (!OPERATION_ID.test(operation.operationId)) throw new Error("Invalid Canvas operation ID.");
  if (!operation.harnessId || !operation.bridgeToken || !operation.canvasPath || !operation.harnessNodeId || !operation.targetNodeId) throw new Error("Incomplete Canvas operation.");
  if (operation.mode !== "replace" && operation.mode !== "append") throw new Error("Invalid Canvas write mode.");
}

function getToolPaths(toolName, input) {
  if (!input || typeof input !== "object") return [];
  if (toolName === "write") return [input.path || input.filePath].filter(Boolean).map(normalizePath);
  if (toolName === "edit") return [input.path || input.filePath].filter(Boolean).map(normalizePath);
  return [];
}

function normalizePath(value) {
  return path.resolve(process.cwd(), String(value)).replace(/\\/g, "/");
}

async function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await fsp.rename(temporaryPath, filePath);
}

async function moveIfPresent(from, to) {
  try { await fsp.rename(from, to); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

async function fileExists(filePath) {
  try { await fsp.access(filePath); return true; } catch { return false; }
}
