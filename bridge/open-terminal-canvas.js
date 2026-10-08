// Bridge loaded directly by Pi from the Open Terminal Obsidian plugin.
"use strict";

import fsp from "node:fs/promises";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { buildCanvasContextContent, buildConnections, getOutgoingTargets, parseCanvasGraph, resolveIncomingSourceNodes } from "../src/canvas-graph.js";
import { createCanvasWriteOperation, waitForWriteAcknowledgement, writeCanvasWriteOperation } from "../src/pi-bridge-transport.js";

const PROTOCOL_VERSION = 1;
const CONTEXT_RULE = "Call `read_context` before you reason about a request in this session. The context the user wants processed lives in the Obsidian Canvas nodes connected to this harness, not in the message itself.";

export default function openTerminalCanvasBridge(pi) {
  let state = null;
  let canvasState = null;
  let contextRead = false;

  pi.registerTool(defineTool({
    name: "read_context",
    label: "Read Canvas context",
    description: "Read the full content of every Canvas node connected TO this harness, following incoming edges only: nodes this harness points at are outputs, not context. Call this before reasoning about any request in this session. File nodes are read from the vault; text nodes come from the live Canvas document.",
    promptGuidelines: [CONTEXT_RULE],
    parameters: Type.Object({
      nodeId: Type.Optional(Type.String({ description: "Read only this incoming Canvas node. Omit to read every connected node." })),
    }),
    async execute(_toolCallId, params) {
      const bridgeState = requireBridgeState();
      const snapshot = await readCanvasState(bridgeState);
      if (!snapshot) {
        return {
          content: [{ type: "text", text: "This harness has no Canvas state yet. Ask the user to reopen the Canvas." }],
          details: { contextVersion: null, capturedAt: null, sources: [] },
        };
      }

      const sources = await resolveIncomingSourceNodes(
        snapshot.graph,
        bridgeState.harnessNodeId,
        readVaultFile,
        params.nodeId ? { nodeId: params.nodeId } : {}
      );
      contextRead = true;

      if (sources.length === 0) {
        const text = params.nodeId
          ? `Canvas node "${params.nodeId}" is not connected to this harness by an incoming edge.`
          : "No Canvas node is connected to this harness yet. Ask the user to connect the nodes that hold the context.";
        return { content: [{ type: "text", text }], details: { contextVersion: snapshot.version, capturedAt: snapshot.capturedAt, sources: [] } };
      }

      const assembled = buildCanvasContextContent(sources);
      return {
        content: [{ type: "text", text: assembled.content }],
        details: { contextVersion: snapshot.version, capturedAt: snapshot.capturedAt, sources: assembled.sourceNodes },
      };
    },
  }));

  pi.registerTool(defineTool({
    name: "find_connected_nodes",
    label: "Find connected Canvas nodes",
    description: "Inspect the current Canvas graph and list every node directly connected to this Pi harness, including whether the connection is incoming or outgoing. Use this before write_canvas_node when the target ID is unknown.",
    parameters: Type.Object({}),
    async execute() {
      const bridgeState = requireBridgeState();
      const snapshot = await readCanvasState(bridgeState);
      const nodes = snapshot ? buildConnections(snapshot.graph, bridgeState.harnessNodeId) : [];
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
      const operation = createCanvasWriteOperation({
        harnessId: bridgeState.harnessId,
        bridgeToken: bridgeState.bridgeToken,
        canvasPath: bridgeState.canvasPath,
        harnessNodeId: bridgeState.harnessNodeId,
        targetNodeId: params.targetNodeId,
        content: params.content,
        mode: params.mode || "replace",
      });
      await writeCanvasWriteOperation(bridgeState, operation);
      const acknowledgement = await waitForWriteAcknowledgement(bridgeState, operation.operationId);
      const target = acknowledgement.targetNodeId || operation.targetNodeId;
      if (acknowledgement.status !== "accepted") {
        return { isError: true, content: [{ type: "text", text: `Canvas target ${target} was rejected: ${acknowledgement.error || "write failed"}` }], details: acknowledgement };
      }
      return { content: [{ type: "text", text: `Canvas target ${target} updated with ${operation.mode}.` }], details: acknowledgement };
    },
  }));

  pi.on("tool_call", async (event) => {
    const attemptedPaths = getToolPaths(event.toolName, event.input);
    if (!state || attemptedPaths.length === 0) return;
    if (event.toolName === "read" && attemptedPaths.some((candidate) => candidate === normalizePath(state.canvasPath))) {
      return { block: true, reason: "This Canvas document is live in Obsidian and reading it from disk can be stale. Use read_context for the content connected to this harness." };
    }
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const protectedPaths = await getProtectedPaths();
    if (attemptedPaths.some((candidate) => protectedPaths.has(candidate))) {
      return { block: true, reason: "This path is a connected Canvas output. Use write_canvas_node with an explicit targetNodeId." };
    }
  });

  pi.on("before_agent_start", (event) => {
    if (state && !contextRead) {
      event.systemPromptOptions.sections.canvas_context = `This session is attached to the Obsidian Canvas \`${state.canvasPath}\`. The material the user wants processed lives in the nodes connected TO this harness, which only \`read_context\` can return.`;
    } else {
      delete event.systemPromptOptions.sections.canvas_context;
    }
  });

  pi.on("session_start", async () => {
    state = readEnvironment();
    if (!state) return;

    const activeTools = pi.getActiveTools().filter((toolName) => toolName !== "edit" && toolName !== "write");
    if (state.canvasPath && state.harnessNodeId) activeTools.push("read_context", "find_connected_nodes", "write_canvas_node");
    pi.setActiveTools([...new Set(activeTools)]);

    await Promise.all([
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
  });

  pi.on("session_shutdown", async () => {
    state = null;
    canvasState = null;
    contextRead = false;
  });

  function requireBridgeState() {
    state = state || readEnvironment();
    if (!state) throw new Error("Canvas bridge state is unavailable. Start this Pi session from a Canvas harness.");
    if (!state.canvasPath) throw new Error("Canvas path is missing from the harness session.");
    if (!state.harnessNodeId) throw new Error("Harness node ID is missing from the harness session.");
    return state;
  }

  /** Reads the plugin's live graph mirror once per Canvas revision. */
  async function readCanvasState(context) {
    let snapshot;
    try {
      snapshot = JSON.parse(await fsp.readFile(context.canvasStatePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    if (canvasState && canvasState.version === snapshot.contextVersion) return canvasState;
    canvasState = {
      version: snapshot.contextVersion,
      capturedAt: snapshot.capturedAt,
      graph: parseCanvasGraph(snapshot.graph),
    };
    return canvasState;
  }

  /** Canvas file nodes hold vault paths, and this process runs with the vault as its cwd. */
  async function readVaultFile(filePath) {
    return fsp.readFile(path.resolve(process.cwd(), filePath), "utf8");
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
      canvasStatePath: process.env.OPEN_TERMINAL_CANVAS_STATE_PATH || path.join(directory, "canvas-state.json"),
      sessionId: path.basename(directory),
      outboxDirectory: path.join(directory, "outbox"),
      writeProcessedDirectory: path.join(directory, "write-processed"),
      writeAcknowledgementsDirectory: path.join(directory, "write-acks"),
      writeErrorsDirectory: path.join(directory, "write-errors"),
      sessionPath: path.join(directory, "session.json"),
    };
  }

  async function getProtectedPaths() {
    const paths = new Set([normalizePath(state.canvasPath)]);
    const snapshot = await readCanvasState(state);
    if (!snapshot) return paths;
    for (const target of getOutgoingTargets(snapshot.graph, state.harnessNodeId)) {
      if (target.type === "file" && target.file) paths.add(normalizePath(target.file));
    }
    return paths;
  }
}

function getToolPaths(toolName, input) {
  if (!input || typeof input !== "object") return [];
  if (toolName === "write" || toolName === "edit" || toolName === "read") {
    return [input.path || input.filePath].filter(Boolean).map(normalizePath);
  }
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
