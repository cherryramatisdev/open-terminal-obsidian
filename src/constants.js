"use strict";

const VIEW_TYPE = "open-terminal-view";
const BLOCK_LANG = "terminal";

const DEFAULT_SETTINGS = {
  // "auto", "powershell", "pwsh", "cmd" (Windows), "zsh", "bash" (macOS/Linux) or "custom"
  shell: "auto",
  customShell: "",
  // "bottom" (split panel below), "tab" (new tab) or "right" (right sidebar)
  location: "bottom",
  // Empty = auto-detect
  nodePath: "",
  harnessProviders: {
    pi: { executable: "" },
  },
  fontSize: 14,
};

const SHELLS = {
  powershell: { cmd: "powershell.exe", args: ["-NoLogo"], win: true },
  pwsh: { cmd: "pwsh.exe", args: ["-NoLogo"], win: true },
  cmd: { cmd: "cmd.exe", args: [], win: true },
  zsh: { cmd: "/bin/zsh", args: ["-l"], win: false },
  bash: { cmd: "/bin/bash", args: ["-l"], win: false },
};

module.exports = { VIEW_TYPE, BLOCK_LANG, DEFAULT_SETTINGS, SHELLS };
