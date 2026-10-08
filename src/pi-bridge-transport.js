"use strict";

const crypto = require("crypto");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const PROTOCOL_VERSION = 1;
const SESSION_DIRECTORY_NAME = "open-terminal-pi";
const MESSAGE_ID = /^(msg|write)-[A-Za-z0-9-]+$/;

class BridgeProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "BridgeProtocolError";
  }
}

function randomId(prefix) {
  const value = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
  return `${prefix}-${value}`;
}

async function createBridgeSession({ temporaryRoot = os.tmpdir() } = {}) {
  const sessionId = randomId("session");
  const directory = path.join(temporaryRoot, SESSION_DIRECTORY_NAME, sessionId);
  const session = {
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    bridgeToken: crypto.randomBytes(32).toString("base64url"),
    directory,
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
  await Promise.all([
    fs.mkdir(session.inboxDirectory, { recursive: true, mode: 0o700 }),
    fs.mkdir(session.processedDirectory, { recursive: true, mode: 0o700 }),
    fs.mkdir(session.acknowledgementsDirectory, { recursive: true, mode: 0o700 }),
    fs.mkdir(session.errorsDirectory, { recursive: true, mode: 0o700 }),
    fs.mkdir(session.outboxDirectory, { recursive: true, mode: 0o700 }),
    fs.mkdir(session.writeProcessedDirectory, { recursive: true, mode: 0o700 }),
    fs.mkdir(session.writeAcknowledgementsDirectory, { recursive: true, mode: 0o700 }),
    fs.mkdir(session.writeErrorsDirectory, { recursive: true, mode: 0o700 }),
  ]);
  return session;
}

function createBridgeMessage({ harnessId, bridgeToken, canvasPath, workingDirectory, sourceNodes, content, replyMode, metadata }) {
  const message = {
    version: PROTOCOL_VERSION,
    id: randomId("msg"),
    harnessId,
    bridgeToken,
    sourceNodes,
    content,
    createdAt: new Date().toISOString(),
  };
  if (canvasPath) message.canvasPath = canvasPath;
  if (workingDirectory) message.workingDirectory = workingDirectory;
  if (replyMode) message.replyMode = replyMode;
  if (metadata) message.metadata = metadata;
  validateBridgeMessage(message);
  return message;
}

function validateBridgeMessage(message, expected = {}) {
  if (!message || typeof message !== "object") throw new BridgeProtocolError("Bridge message must be an object.");
  if (message.version !== PROTOCOL_VERSION) throw new BridgeProtocolError(`Unsupported bridge protocol version "${message.version}".`);
  for (const field of ["id", "harnessId", "bridgeToken", "content", "createdAt"]) {
    if (typeof message[field] !== "string" || !message[field]) throw new BridgeProtocolError(`Bridge message field "${field}" is required.`);
  }
  if (!MESSAGE_ID.test(message.id)) throw new BridgeProtocolError("Bridge message ID is invalid.");
  if (!Array.isArray(message.sourceNodes)) throw new BridgeProtocolError("Bridge message field " + '"sourceNodes" must be an array.');
  if (expected.harnessId && message.harnessId !== expected.harnessId) throw new BridgeProtocolError("Bridge message targets a different harness.");
  if (expected.bridgeToken && message.bridgeToken !== expected.bridgeToken) throw new BridgeProtocolError("Bridge message token is not authorized for this session.");
  return message;
}

async function writeBridgeMessage(session, message) {
  validateBridgeMessage(message, { bridgeToken: session.bridgeToken, harnessId: session.harnessId });
  const messagePath = path.join(session.inboxDirectory, `${message.id}.json`);
  await writeJsonAtomically(messagePath, message);
  return messagePath;
}

async function writeAcknowledgement(session, acknowledgement) {
  validateAcknowledgement(acknowledgement, { harnessId: session.harnessId });
  const acknowledgementPath = path.join(session.acknowledgementsDirectory, `${acknowledgement.messageId}.json`);
  await writeJsonAtomically(acknowledgementPath, acknowledgement);
  return acknowledgementPath;
}

function createCanvasWriteOperation({ harnessId, bridgeToken, canvasPath, harnessNodeId, targetNodeId, content, mode = "replace" }) {
  const operation = {
    version: PROTOCOL_VERSION,
    operationId: randomId("write"),
    operation: "write_canvas_node",
    harnessId,
    bridgeToken,
    canvasPath,
    harnessNodeId,
    targetNodeId,
    content,
    mode,
    createdAt: new Date().toISOString(),
  };
  validateCanvasWriteOperation(operation);
  return operation;
}

function validateCanvasWriteOperation(operation, expected = {}) {
  if (!operation || typeof operation !== "object" || operation.version !== PROTOCOL_VERSION) throw new BridgeProtocolError("Canvas write operation has an unsupported protocol version.");
  for (const field of ["operationId", "harnessId", "bridgeToken", "canvasPath", "harnessNodeId", "targetNodeId", "content", "createdAt"]) {
    if (typeof operation[field] !== "string" || !operation[field]) throw new BridgeProtocolError(`Canvas write field "${field}" is required.`);
  }
  if (operation.operation !== "write_canvas_node") throw new BridgeProtocolError("Unsupported Canvas operation.");
  if (!MESSAGE_ID.test(operation.operationId) || !operation.operationId.startsWith("write-")) throw new BridgeProtocolError("Canvas operation ID is invalid.");
  if (!["replace", "append"].includes(operation.mode)) throw new BridgeProtocolError("Canvas write mode is invalid.");
  if (expected.harnessId && operation.harnessId !== expected.harnessId) throw new BridgeProtocolError("Canvas operation targets a different harness.");
  if (expected.bridgeToken && operation.bridgeToken !== expected.bridgeToken) throw new BridgeProtocolError("Canvas operation token is not authorized for this session.");
  return operation;
}

async function writeCanvasWriteOperation(session, operation) {
  validateCanvasWriteOperation(operation, { bridgeToken: session.bridgeToken, harnessId: session.harnessId });
  const operationPath = path.join(session.outboxDirectory, `${operation.operationId}.json`);
  await writeJsonAtomically(operationPath, operation);
  return operationPath;
}

async function waitForWriteAcknowledgement(session, operationId, { timeoutMs = 10_000, pollIntervalMs = 100 } = {}) {
  const acknowledgementPath = path.join(session.writeAcknowledgementsDirectory, `${operationId}.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const content = await readFileOrNull(acknowledgementPath);
    if (content !== null) {
      let acknowledgement;
      try { acknowledgement = JSON.parse(content); } catch { throw new BridgeProtocolError(`Canvas acknowledgement for "${operationId}" is not valid JSON.`); }
      return validateCanvasWriteAcknowledgement(acknowledgement, { operationId, harnessId: session.harnessId });
    }
    await sleep(pollIntervalMs);
  }
  throw new BridgeProtocolError(`Timed out waiting for Canvas acknowledgement of "${operationId}".`);
}

function validateCanvasWriteAcknowledgement(acknowledgement, expected = {}) {
  if (!acknowledgement || acknowledgement.version !== PROTOCOL_VERSION) throw new BridgeProtocolError("Canvas acknowledgement has an unsupported protocol version.");
  for (const field of ["operationId", "harnessId", "status", "receivedAt"]) {
    if (typeof acknowledgement[field] !== "string" || !acknowledgement[field]) throw new BridgeProtocolError(`Canvas acknowledgement field "${field}" is required.`);
  }
  if (!acknowledgement.operationId.startsWith("write-") || !MESSAGE_ID.test(acknowledgement.operationId)) throw new BridgeProtocolError("Canvas acknowledgement operation ID is invalid.");
  if (!["accepted", "rejected", "failed"].includes(acknowledgement.status)) throw new BridgeProtocolError(`Unsupported Canvas acknowledgement status "${acknowledgement.status}".`);
  if (expected.operationId && acknowledgement.operationId !== expected.operationId) throw new BridgeProtocolError("Canvas acknowledgement belongs to a different operation.");
  if (expected.harnessId && acknowledgement.harnessId !== expected.harnessId) throw new BridgeProtocolError("Canvas acknowledgement belongs to a different harness.");
  return acknowledgement;
}

async function writeCanvasWriteAcknowledgement(session, acknowledgement) {
  validateCanvasWriteAcknowledgement(acknowledgement, { harnessId: session.harnessId });
  const acknowledgementPath = path.join(session.writeAcknowledgementsDirectory, `${acknowledgement.operationId}.json`);
  await writeJsonAtomically(acknowledgementPath, acknowledgement);
  return acknowledgementPath;
}

async function waitForAcknowledgement(session, messageId, { timeoutMs = 10_000, pollIntervalMs = 100 } = {}) {
  const acknowledgementPath = path.join(session.acknowledgementsDirectory, `${messageId}.json`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const content = await readFileOrNull(acknowledgementPath);
    if (content !== null) {
      let acknowledgement;
      try {
        acknowledgement = JSON.parse(content);
      } catch {
        throw new BridgeProtocolError(`Acknowledgement for "${messageId}" is not valid JSON.`);
      }
      return validateAcknowledgement(acknowledgement, { messageId, harnessId: session.harnessId });
    }
    await sleep(pollIntervalMs);
  }
  throw new BridgeProtocolError(`Timed out waiting for acknowledgement of "${messageId}".`);
}

function validateAcknowledgement(acknowledgement, expected = {}) {
  if (!acknowledgement || acknowledgement.version !== PROTOCOL_VERSION) throw new BridgeProtocolError("Acknowledgement has an unsupported protocol version.");
  for (const field of ["messageId", "harnessId", "status", "receivedAt"]) {
    if (typeof acknowledgement[field] !== "string" || !acknowledgement[field]) throw new BridgeProtocolError(`Acknowledgement field "${field}" is required.`);
  }
  if (!MESSAGE_ID.test(acknowledgement.messageId)) throw new BridgeProtocolError("Acknowledgement message ID is invalid.");
  if (!new Set(["accepted", "queued", "rejected", "failed"]).has(acknowledgement.status)) {
    throw new BridgeProtocolError(`Unsupported acknowledgement status "${acknowledgement.status}".`);
  }
  if (expected.messageId && acknowledgement.messageId !== expected.messageId) throw new BridgeProtocolError("Acknowledgement belongs to a different message.");
  if (expected.harnessId && acknowledgement.harnessId !== expected.harnessId) throw new BridgeProtocolError("Acknowledgement belongs to a different harness.");
  return acknowledgement;
}

async function writeJsonAtomically(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

async function readFileOrNull(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

module.exports = {
  BridgeProtocolError,
  PROTOCOL_VERSION,
  createBridgeMessage,
  createBridgeSession,
  validateAcknowledgement,
  validateBridgeMessage,
  waitForAcknowledgement,
  writeAcknowledgement,
  writeBridgeMessage,
  createCanvasWriteOperation,
  validateCanvasWriteOperation,
  validateCanvasWriteAcknowledgement,
  waitForWriteAcknowledgement,
  writeCanvasWriteAcknowledgement,
  writeCanvasWriteOperation,
};
