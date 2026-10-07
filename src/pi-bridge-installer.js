"use strict";

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const BRIDGE_DIRECTORY = [".pi", "extensions", "open-terminal-canvas"];
const BRIDGE_FILENAME = "index.js";
const MANIFEST_FILENAME = "manifest.json";
const MANAGED_BY = "open-terminal-obsidian";
const PROTOCOL_VERSION = 1;

class BridgeModifiedError extends Error {
  constructor(bridgePath) {
    super(`The managed Pi bridge was modified and will not be overwritten: ${bridgePath}`);
    this.name = "BridgeModifiedError";
    this.bridgePath = bridgePath;
  }
}

function sha256(content) {
  return `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
}

async function readFileOrNull(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeAtomically(filePath, content) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporaryPath, filePath);
}

function parseManifest(content, manifestPath) {
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    throw new BridgeModifiedError(manifestPath);
  }
}

/**
 * Installs or updates the project-local Pi bridge without replacing a file that
 * has diverged from the last version Open Terminal managed.
 */
async function ensurePiBridgeInstalled({ sourcePath, vaultPath, pluginVersion, force = false }) {
  if (!sourcePath || !vaultPath || !pluginVersion) throw new Error("Bridge installation requires sourcePath, vaultPath, and pluginVersion.");

  const source = await fs.readFile(sourcePath, "utf8");
  const sourceHash = sha256(source);
  const extensionDir = path.join(vaultPath, ...BRIDGE_DIRECTORY);
  const bridgePath = path.join(extensionDir, BRIDGE_FILENAME);
  const manifestPath = path.join(extensionDir, MANIFEST_FILENAME);
  const currentBridge = await readFileOrNull(bridgePath);
  const currentManifest = parseManifest(await readFileOrNull(manifestPath), manifestPath);

  if (!force && currentBridge !== null) {
    const currentHash = sha256(currentBridge);
    const isManaged =
      currentManifest &&
      currentManifest.managedBy === MANAGED_BY &&
      typeof currentManifest.managedHash === "string" &&
      currentManifest.managedHash === currentHash;
    if (!isManaged) throw new BridgeModifiedError(bridgePath);
  }

  const manifest = {
    managedBy: MANAGED_BY,
    pluginVersion,
    protocolVersion: PROTOCOL_VERSION,
    managedHash: sourceHash,
  };
  const unchanged = currentBridge === source && currentManifest && JSON.stringify(currentManifest) === JSON.stringify(manifest);
  if (unchanged) return { status: "current", bridgePath, manifestPath, manifest };

  await fs.mkdir(extensionDir, { recursive: true, mode: 0o700 });
  await writeAtomically(bridgePath, source);
  await writeAtomically(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  return { status: currentBridge === null ? "installed" : "updated", bridgePath, manifestPath, manifest };
}

module.exports = {
  BRIDGE_DIRECTORY,
  BridgeModifiedError,
  PROTOCOL_VERSION,
  ensurePiBridgeInstalled,
  sha256,
};
