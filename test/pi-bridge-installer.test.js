"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { BridgeModifiedError, ensurePiBridgeInstalled, sha256 } = require("../src/pi-bridge-installer");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "open-terminal-bridge-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const vaultPath = path.join(root, "vault");
  const sourcePath = path.join(root, "open-terminal-canvas.js");
  await fs.mkdir(vaultPath);
  return { sourcePath, vaultPath };
}

test("installs the bundled bridge and records its managed hash", async (t) => {
  const { sourcePath, vaultPath } = await fixture(t);
  const source = "export default function () {}\n";
  await fs.writeFile(sourcePath, source);

  const result = await ensurePiBridgeInstalled({ sourcePath, vaultPath, pluginVersion: "2.0.0" });
  const extensionDir = path.join(vaultPath, ".pi", "extensions", "open-terminal-canvas");
  const manifest = JSON.parse(await fs.readFile(path.join(extensionDir, "manifest.json"), "utf8"));

  assert.equal(result.status, "installed");
  assert.equal(await fs.readFile(path.join(extensionDir, "index.js"), "utf8"), source);
  assert.deepEqual(manifest, {
    managedBy: "open-terminal-obsidian",
    pluginVersion: "2.0.0",
    protocolVersion: 1,
    managedHash: sha256(source),
  });
});

test("updates a bridge only when its current content is the last managed version", async (t) => {
  const { sourcePath, vaultPath } = await fixture(t);
  await fs.writeFile(sourcePath, "export default function first() {}\n");
  await ensurePiBridgeInstalled({ sourcePath, vaultPath, pluginVersion: "2.0.0" });

  const updated = "export default function second() {}\n";
  await fs.writeFile(sourcePath, updated);
  const result = await ensurePiBridgeInstalled({ sourcePath, vaultPath, pluginVersion: "2.1.0" });
  const installedPath = path.join(vaultPath, ".pi", "extensions", "open-terminal-canvas", "index.js");

  assert.equal(result.status, "updated");
  assert.equal(await fs.readFile(installedPath, "utf8"), updated);
});

test("preserves a manually modified bridge instead of overwriting it", async (t) => {
  const { sourcePath, vaultPath } = await fixture(t);
  await fs.writeFile(sourcePath, "export default function first() {}\n");
  await ensurePiBridgeInstalled({ sourcePath, vaultPath, pluginVersion: "2.0.0" });

  const installedPath = path.join(vaultPath, ".pi", "extensions", "open-terminal-canvas", "index.js");
  const customSource = "export default function custom() {}\n";
  await fs.writeFile(installedPath, customSource);
  await fs.writeFile(sourcePath, "export default function second() {}\n");

  await assert.rejects(
    ensurePiBridgeInstalled({ sourcePath, vaultPath, pluginVersion: "2.1.0" }),
    BridgeModifiedError
  );
  assert.equal(await fs.readFile(installedPath, "utf8"), customSource);
});
