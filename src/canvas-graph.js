"use strict";

const crypto = require("crypto");
const path = require("path");
const { parsePiHarnessNode } = require("./pi-harness");

class CanvasGraphError extends Error {
  constructor(message) {
    super(message);
    this.name = "CanvasGraphError";
  }
}

function parseCanvasGraph(content) {
  let graph;
  try {
    graph = JSON.parse(content);
  } catch {
    throw new CanvasGraphError("The Canvas document is not valid JSON.");
  }
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new CanvasGraphError("The Canvas document must contain nodes and edges arrays.");
  }
  return graph;
}

/** Returns text source nodes in the same order as incoming Canvas edges. */
function getIncomingSourceNodes(graph, harnessNodeId, { allowFiles = false } = {}) {
  const nodesById = new Map();
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== "string" || !node.id) throw new CanvasGraphError("Canvas nodes must have IDs.");
    if (nodesById.has(node.id)) throw new CanvasGraphError(`Duplicate Canvas node ID "${node.id}".`);
    nodesById.set(node.id, node);
  }
  if (!nodesById.has(harnessNodeId)) throw new CanvasGraphError(`Harness node "${harnessNodeId}" was not found.`);

  const sources = [];
  const includedNodeIds = new Set();
  for (const edge of graph.edges) {
    if (!edge || typeof edge.fromNode !== "string" || typeof edge.toNode !== "string") {
      throw new CanvasGraphError("Canvas edges must include fromNode and toNode IDs.");
    }
    if (!nodesById.has(edge.fromNode) || !nodesById.has(edge.toNode)) {
      throw new CanvasGraphError(`Canvas edge "${edge.id || "unknown"}" references a missing node.`);
    }
    if (edge.toNode !== harnessNodeId || includedNodeIds.has(edge.fromNode)) continue;

    const source = nodesById.get(edge.fromNode);
    if (source.type === "text") {
      if (typeof source.text !== "string") throw new CanvasGraphError(`Text source node "${source.id}" has no text content.`);
      includedNodeIds.add(source.id);
      sources.push({ id: source.id, type: source.type, title: sourceTitle(source), content: source.text });
      continue;
    }
    if (source.type === "file" && allowFiles) {
      includedNodeIds.add(source.id);
      sources.push({ id: source.id, type: source.type, file: source.file, title: source.file || source.id, content: "" });
      continue;
    }
    throw new CanvasGraphError(`Unsupported source node type "${source.type}" for node "${source.id}".`);
  }
  return sources;
}

function getOutgoingTargets(graph, harnessNodeId) {
  const nodesById = indexNodes(graph);
  if (!nodesById.has(harnessNodeId)) throw new CanvasGraphError(`Harness node "${harnessNodeId}" was not found.`);

  const targets = [];
  for (const edge of graph.edges) {
    if (edge.fromNode !== harnessNodeId) continue;
    const node = nodesById.get(edge.toNode);
    if (!node) throw new CanvasGraphError(`Canvas edge "${edge.id || "unknown"}" references a missing node.`);
    if (node.type === "text") {
      if (typeof node.text !== "string") throw new CanvasGraphError(`Text target node "${node.id}" has no text content.`);
      if (parsePiHarnessNode(node.text).valid) throw new CanvasGraphError(`Pi harness node "${node.id}" cannot be a write target.`);
      targets.push({ id: node.id, type: "text", label: sourceTitle(node), file: null });
    } else if (node.type === "file") {
      if (typeof node.file !== "string" || !node.file) throw new CanvasGraphError(`File target node "${node.id}" has no file path.`);
      targets.push({ id: node.id, type: "file", label: node.file, file: node.file });
    } else {
      throw new CanvasGraphError(`Unsupported target node type "${node.type}" for node "${node.id}".`);
    }
  }
  return targets;
}

function resolveOutgoingTarget(graph, harnessNodeId, targetNodeId) {
  const target = getOutgoingTargets(graph, harnessNodeId).find((candidate) => candidate.id === targetNodeId);
  if (!target) throw new CanvasGraphError(`Canvas node "${targetNodeId}" is not a direct outgoing target of harness "${harnessNodeId}".`);
  return target;
}

function indexNodes(graph) {
  const nodesById = new Map();
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== "string" || !node.id) throw new CanvasGraphError("Canvas nodes must have IDs.");
    if (nodesById.has(node.id)) throw new CanvasGraphError(`Duplicate Canvas node ID "${node.id}".`);
    nodesById.set(node.id, node);
  }
  for (const edge of graph.edges) {
    if (!edge || typeof edge.fromNode !== "string" || typeof edge.toNode !== "string") throw new CanvasGraphError("Canvas edges must include fromNode and toNode IDs.");
    if (!nodesById.has(edge.fromNode) || !nodesById.has(edge.toNode)) throw new CanvasGraphError(`Canvas edge "${edge.id || "unknown"}" references a missing node.`);
  }
  return nodesById;
}

async function resolveIncomingSourceNodes(graph, harnessNodeId, readFile) {
  if (typeof readFile !== "function") throw new CanvasGraphError("A vault file resolver is required for file Canvas nodes.");
  const sources = getIncomingSourceNodes(graph, harnessNodeId, { allowFiles: true });
  for (const source of sources) {
    if (source.type !== "file") continue;
    if (typeof source.file !== "string" || !source.file) throw new CanvasGraphError(`File source node "${source.id}" has no file path.`);
    const content = await readFile(source.file);
    if (typeof content !== "string") throw new CanvasGraphError(`File source node "${source.id}" could not be read.`);
    source.content = content;
    source.title = sourceTitle({ id: source.file, text: content }) || path.basename(source.file);
  }
  return sources;
}

function buildCanvasMessageContent(sources) {
  if (!Array.isArray(sources) || sources.length === 0) throw new CanvasGraphError("No incoming Canvas nodes are connected to this Pi harness.");

  const sections = ["The following content was sent from an Obsidian canvas, USE IT AS CONTEXT ONLY, DO NOT PERFORM ANY ACTIONS YET"];
  const sourceNodes = sources.map((source) => ({
    id: source.id,
    type: source.type,
    title: source.title,
    contentHash: sha256(source.content),
  }));
  for (const source of sources) {
    sections.push(`## Source: ${source.title}\n\nCanvas node: \`${source.id}\`\n\n${source.content}`);
  }
  sections.push("## Instructions\n\nTreat the sections above as context supplied by the user.");

  return { content: sections.join("\n\n"), sourceNodes };
}

function messageFingerprint(message) {
  return sha256(JSON.stringify({ sourceNodes: message.sourceNodes, content: message.content }));
}

function sourceTitle(source) {
  const firstLine = source.text.split(/\r?\n/).find((line) => line.trim());
  if (!firstLine) return source.id;
  const title = firstLine.replace(/^\s*#{1,6}\s+/, "").trim();
  return title || source.id;
}

function sha256(content) {
  return `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
}

module.exports = { CanvasGraphError, buildCanvasMessageContent, getIncomingSourceNodes, getOutgoingTargets, messageFingerprint, parseCanvasGraph, resolveIncomingSourceNodes, resolveOutgoingTarget };
