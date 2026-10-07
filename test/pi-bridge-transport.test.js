"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  BridgeProtocolError,
  createBridgeMessage,
  createBridgeSession,
  validateBridgeMessage,
  waitForAcknowledgement,
  writeAcknowledgement,
  writeBridgeMessage,
} = require("../src/pi-bridge-transport");

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "open-terminal-transport-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("creates a private session directory outside the vault and atomically writes a message", async (t) => {
  const session = await createBridgeSession({ temporaryRoot: await temporaryRoot(t) });
  const message = createBridgeMessage({
    harnessId: "pi-main",
    bridgeToken: session.bridgeToken,
    canvasPath: "projects/example.canvas",
    workingDirectory: "/vault/projects/example",
    sourceNodes: [{ id: "requirements", type: "text", title: "Requirements", contentHash: "sha256:abc" }],
    content: "## Source: Requirements\n\nBuild it.",
  });

  const messagePath = await writeBridgeMessage(session, message);
  const stored = JSON.parse(await fs.readFile(messagePath, "utf8"));

  assert.match(session.directory, /open-terminal-pi/);
  assert.deepEqual(stored, message);
  assert.equal(path.extname(messagePath), ".json");
  assert.equal((await fs.readdir(session.inboxDirectory)).some((name) => name.endsWith(".tmp")), false);
});

test("rejects an envelope with a mismatched bridge token", async (t) => {
  const session = await createBridgeSession({ temporaryRoot: await temporaryRoot(t) });
  const message = createBridgeMessage({
    harnessId: "pi-main",
    bridgeToken: "wrong-token",
    sourceNodes: [],
    content: "Context",
  });

  assert.throws(() => validateBridgeMessage(message, { bridgeToken: session.bridgeToken, harnessId: "pi-main" }), BridgeProtocolError);
  await assert.rejects(writeBridgeMessage(session, message), BridgeProtocolError);
});

test("waits for an acknowledgement written by the bridge", async (t) => {
  const session = await createBridgeSession({ temporaryRoot: await temporaryRoot(t) });
  const message = createBridgeMessage({ harnessId: "pi-main", bridgeToken: session.bridgeToken, sourceNodes: [], content: "Context" });

  setTimeout(() => writeAcknowledgement(session, {
    version: 1,
    messageId: message.id,
    harnessId: "pi-main",
    status: "accepted",
    receivedAt: new Date().toISOString(),
  }), 15);

  const acknowledgement = await waitForAcknowledgement(session, message.id, { timeoutMs: 200, pollIntervalMs: 5 });
  assert.equal(acknowledgement.status, "accepted");
  assert.equal(acknowledgement.messageId, message.id);
});

test("times out without creating duplicate messages", async (t) => {
  const session = await createBridgeSession({ temporaryRoot: await temporaryRoot(t) });
  await assert.rejects(waitForAcknowledgement(session, "msg-missing", { timeoutMs: 10, pollIntervalMs: 2 }), /Timed out/);
});
