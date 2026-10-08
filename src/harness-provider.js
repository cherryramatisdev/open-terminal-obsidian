"use strict";

const crypto = require("crypto");
const path = require("path");

class PiHarnessProvider {
  constructor(plugin) {
    this.id = "pi";
    this.plugin = plugin;
  }

  createLaunchSpec({ bridge, vaultPath }) {
    const bridgeExtensionPath = path.join(this.plugin.pluginDir(), "bridge", "open-terminal-canvas.js");
    const executable = this.plugin.settings.harnessProviders?.pi?.executable?.trim() || "pi";
    const env = {
      OPEN_TERMINAL_VAULT_ID: crypto.createHash("sha256").update(vaultPath).digest("hex"),
      OPEN_TERMINAL_HARNESS_ID: bridge.harnessId,
      OPEN_TERMINAL_BRIDGE_DIR: bridge.directory,
      OPEN_TERMINAL_BRIDGE_TOKEN: bridge.bridgeToken,
      OPEN_TERMINAL_PROTOCOL_VERSION: String(bridge.protocolVersion),
      OPEN_TERMINAL_CANVAS_PATH: bridge.canvasPath || "",
      OPEN_TERMINAL_HARNESS_NODE_ID: bridge.harnessNodeId || "",
      OPEN_TERMINAL_CANVAS_TARGETS: JSON.stringify(bridge.targets || []),
    };
    return {
      cwd: vaultPath,
      command: `${this.plugin.quoteArg(executable)} --extension ${this.plugin.quoteArg(bridgeExtensionPath)} --exclude-tools edit,write`,
      env,
    };
  }
}

class HarnessProviderRegistry {
  constructor(providers) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]));
  }

  get(id) {
    return this.providers.get(id) || null;
  }
}

module.exports = { HarnessProviderRegistry, PiHarnessProvider };
