"use strict";

const crypto = require("crypto");

const HARNESS_LANGUAGE = "pi-harness";
const SUPPORTED_AGENT = "pi";
const SUPPORTED_BRIDGE = "open-terminal";
const HARNESS_FENCE = new RegExp("^\\s*```" + HARNESS_LANGUAGE + "[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n```\\s*$");

function newPiHarnessId() {
  const suffix = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
  return `pi-${suffix}`;
}

function createPiHarnessMarkdown(id = newPiHarnessId()) {
  return `\`\`\`${HARNESS_LANGUAGE}\nid: ${id}\nagent: ${SUPPORTED_AGENT}\nbridge: ${SUPPORTED_BRIDGE}\n\`\`\``;
}

/** Parses only the declarative Pi harness block, never executable content. */
function parsePiHarnessNode(text) {
  const match = typeof text === "string" ? text.match(HARNESS_FENCE) : null;
  if (!match) return invalid("The node must contain a pi-harness code block.");

  const values = {};
  const errors = [];
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const field = line.match(/^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/);
    if (!field) {
      errors.push(`Invalid harness field: ${line}`);
      continue;
    }
    const key = field[1].toLowerCase();
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      errors.push(`Duplicate harness field: ${key}`);
      continue;
    }
    values[key] = field[2];
  }

  if (!values.id) errors.push("Harness ID is required.");
  if (!values.agent) errors.push("Harness agent is required.");
  else if (values.agent !== SUPPORTED_AGENT) errors.push(`Unsupported agent "${values.agent}".`);
  if (values.bridge && values.bridge !== SUPPORTED_BRIDGE) errors.push(`Unsupported bridge "${values.bridge}".`);

  if (errors.length) return { valid: false, harness: null, errors };
  return {
    valid: true,
    harness: { id: values.id, agent: values.agent, bridge: values.bridge || null },
    errors: [],
  };
}

function invalid(error) {
  return { valid: false, harness: null, errors: [error] };
}

function findDuplicateHarnessIds(nodes) {
  const nodeIdsByHarnessId = new Map();
  for (const node of nodes || []) {
    if (!node || node.type !== "text") continue;
    const declaration = parsePiHarnessNode(node.text);
    if (!declaration.valid) continue;
    const nodeIds = nodeIdsByHarnessId.get(declaration.harness.id) || [];
    nodeIds.push(node.id);
    nodeIdsByHarnessId.set(declaration.harness.id, nodeIds);
  }

  return [...nodeIdsByHarnessId]
    .filter(([, nodeIds]) => nodeIds.length > 1)
    .map(([harnessId, nodeIds]) => ({ harnessId, nodeIds }));
}

module.exports = {
  HARNESS_LANGUAGE,
  SUPPORTED_AGENT,
  SUPPORTED_BRIDGE,
  createPiHarnessMarkdown,
  findDuplicateHarnessIds,
  newPiHarnessId,
  parsePiHarnessNode,
};
