"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { CanvasGraphError, buildCanvasMessageContent, getIncomingSourceNodes, parseCanvasGraph, resolveIncomingSourceNodes } = require("../src/canvas-graph");

const graph = parseCanvasGraph(JSON.stringify({
  nodes: [
    { id: "requirements", type: "text", text: "# Requirements\n\nBuild a login flow." },
    { id: "architecture", type: "text", text: "The backend uses OAuth." },
    { id: "pi-main", type: "text", text: "```pi-harness\nid: pi-main\nagent: pi\n```" },
  ],
  edges: [
    { id: "second", fromNode: "architecture", toNode: "pi-main" },
    { id: "first", fromNode: "requirements", toNode: "pi-main" },
  ],
}));

test("resolves incoming sources in Canvas edge order and preserves provenance", () => {
  const sources = getIncomingSourceNodes(graph, "pi-main");
  const message = buildCanvasMessageContent(sources);

  assert.deepEqual(sources.map((source) => source.id), ["architecture", "requirements"]);
  assert.deepEqual(sources.map((source) => source.title), ["The backend uses OAuth.", "Requirements"]);
  assert.match(message.content, /^The following content was sent from an Obsidian canvas, USE IT AS CONTEXT ONLY, DO NOT PERFORM ANY ACTIONS YET/);
  assert.ok(message.content.indexOf("## Source: The backend uses OAuth.") < message.content.indexOf("## Source: Requirements"));
  assert.match(message.content, /Canvas node: `requirements`/);
  assert.match(message.content, /## Instructions\n\nTreat the sections above as context supplied by the user\.$/);
  assert.match(message.sourceNodes[0].contentHash, /^sha256:/);
});

test("reads incoming file nodes through the vault resolver", async () => {
  const fileGraph = parseCanvasGraph(JSON.stringify({
    nodes: [
      { id: "spec", type: "file", file: "docs/spec.md" },
      { id: "pi-main", type: "text", text: "```pi-harness\nid: pi-main\nagent: pi\n```" },
    ],
    edges: [{ id: "file-edge", fromNode: "spec", toNode: "pi-main" }],
  }));
  const sources = await resolveIncomingSourceNodes(fileGraph, "pi-main", async (file) => {
    assert.equal(file, "docs/spec.md");
    return "# Specification\n\nUse the vault file.";
  });

  assert.deepEqual(sources, [{
    id: "spec",
    type: "file",
    file: "docs/spec.md",
    title: "Specification",
    content: "# Specification\n\nUse the vault file.",
  }]);
});

test("rejects invalid edge references and unsupported source nodes", () => {
  assert.throws(() => getIncomingSourceNodes(parseCanvasGraph(JSON.stringify({
    nodes: [{ id: "pi-main", type: "text", text: "" }],
    edges: [{ id: "missing", fromNode: "gone", toNode: "pi-main" }],
  })), "pi-main"), CanvasGraphError);

  assert.throws(() => getIncomingSourceNodes(parseCanvasGraph(JSON.stringify({
    nodes: [{ id: "group", type: "group" }, { id: "pi-main", type: "text", text: "" }],
    edges: [{ id: "group-edge", fromNode: "group", toNode: "pi-main" }],
  })), "pi-main"), /Unsupported source node type "group"/);
});

test("rejects malformed Canvas JSON", () => {
  assert.throws(() => parseCanvasGraph("not json"), CanvasGraphError);
});
