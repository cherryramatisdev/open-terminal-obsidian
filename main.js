"use strict";

const { Plugin, PluginSettingTab, Setting, Notice, ItemView, FileSystemAdapter, TFile, TFolder } = require("obsidian");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const VIEW_TYPE = "open-terminal-view";

const DEFAULT_SETTINGS = {
  // "auto", "powershell", "pwsh", "cmd" (Windows), "zsh", "bash" (macOS/Linux) ou "custom"
  shell: "auto",
  customShell: "",
  // "bottom" (painel abaixo), "tab" (nova aba) ou "right" (barra lateral direita)
  location: "bottom",
  // Vazio = detectar automaticamente
  nodePath: "",
  fontSize: 14,
};

const SHELLS = {
  powershell: { cmd: "powershell.exe", args: ["-NoLogo"], win: true },
  pwsh: { cmd: "pwsh.exe", args: ["-NoLogo"], win: true },
  cmd: { cmd: "cmd.exe", args: [], win: true },
  zsh: { cmd: "/bin/zsh", args: ["-l"], win: false },
  bash: { cmd: "/bin/bash", args: ["-l"], win: false },
};

class TerminalView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.cwd = null;
    this.host = null;
    this.term = null;
    this.fit = null;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return this.cwd ? `Terminal: ${path.basename(this.cwd)}` : "Terminal";
  }

  getIcon() {
    return "terminal-square";
  }

  getState() {
    return { cwd: this.cwd };
  }

  async setState(state, result) {
    if (state && state.cwd && !this.host) {
      this.cwd = state.cwd;
      this.pendingCommand = state.command || null;
      this.startShell();
    }
    await super.setState(state, result);
  }

  async onOpen() {
    const { Terminal, FitAddon } = this.plugin.loadXterm();

    this.contentEl.empty();
    this.contentEl.addClass("open-terminal-container");
    const termEl = this.contentEl.createDiv({ cls: "open-terminal-xterm" });

    const css = getComputedStyle(document.body);
    const cssVar = (name, fallback) => css.getPropertyValue(name).trim() || fallback;

    this.term = new Terminal({
      cursorBlink: true,
      fontSize: this.plugin.settings.fontSize,
      fontFamily: cssVar("--font-monospace", "Consolas, 'Courier New', monospace"),
      scrollback: 5000,
      allowProposedApi: true,
      theme: {
        background: cssVar("--background-primary", "#1e1e1e"),
        foreground: cssVar("--text-normal", "#dcddde"),
        cursor: cssVar("--text-accent", "#7f6df2"),
        selectionBackground: cssVar("--text-selection", "rgba(127,109,242,0.35)"),
      },
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(termEl);

    // Ctrl+C copia quando há seleção; Ctrl+V / Ctrl+Shift+V colam
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const key = e.key.toLowerCase();
      if (e.ctrlKey && key === "c" && this.term.hasSelection()) {
        navigator.clipboard.writeText(this.term.getSelection());
        this.term.clearSelection();
        return false;
      }
      if (e.ctrlKey && e.shiftKey && key === "c") return false;
      if (e.ctrlKey && key === "v") {
        e.preventDefault();
        navigator.clipboard.readText().then((text) => this.term.paste(text));
        return false;
      }
      return true;
    });

    this.term.onData((data) => {
      if (this.host) this.send({ t: "i", d: data });
      else if (this.exited) this.startShell();
    });

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.contentEl);

    // Caso a view seja aberta sem estado (ex.: layout restaurado sem cwd)
    setTimeout(() => {
      if (!this.host && !this.exited) {
        this.cwd = this.cwd || this.plugin.getVaultPath();
        this.startShell();
      }
    }, 150);
  }

  startShell() {
    if (!this.term || !this.cwd) return;
    this.exited = false;

    const node = this.plugin.resolveNodePath();
    if (!node) {
      this.term.writeln("\x1b[31mNode.js não encontrado. Configure o caminho do Node nas opções do plugin.\x1b[0m");
      return;
    }

    const { cmd, args } = this.plugin.getShell();
    this.fitNow();
    const hostArgs = [this.plugin.hostPath(), this.cwd, cmd, String(this.term.cols), String(this.term.rows), ...args];

    this.host = spawn(node, hostArgs, {
      cwd: this.plugin.pluginDir(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.host.stdout.setEncoding("utf8");
    this.host.stderr.setEncoding("utf8");
    this.host.stdout.on("data", (d) => {
      if (this.term) this.term.write(d);
      // Comando inicial (ex.: vindo do plugin Claude Skills): envia quando o shell já respondeu
      if (this.pendingCommand) {
        const cmd = this.pendingCommand;
        this.pendingCommand = null;
        setTimeout(() => this.send({ t: "i", d: cmd + "\r" }), 400);
      }
    });
    this.host.stderr.on("data", (d) => this.term && this.term.write(`\x1b[31m${d.replace(/\n/g, "\r\n")}\x1b[0m`));
    this.host.on("error", (err) => {
      this.term && this.term.writeln(`\x1b[31mErro ao iniciar o terminal: ${err.message}\x1b[0m`);
    });
    this.host.on("exit", () => {
      this.host = null;
      this.exited = true;
      if (this.term) this.term.write("\r\n\x1b[2m[processo finalizado — pressione qualquer tecla para reiniciar]\x1b[0m\r\n");
    });

    this.leaf.updateHeader && this.leaf.updateHeader();
    this.term.focus();
  }

  send(msg) {
    if (this.host && this.host.stdin.writable) this.host.stdin.write(JSON.stringify(msg) + "\n");
  }

  /** O shell está rodando (processo vivo)? */
  isAlive() {
    return !!this.host && !!this.term;
  }

  /** Texto da linha do cursor, até a posição do cursor. */
  cursorLineText() {
    if (!this.term) return "";
    const b = this.term.buffer.active;
    const line = b.getLine(b.baseY + b.cursorY);
    return line ? line.translateToString(true, 0, b.cursorX) : "";
  }

  /** O shell está parado no prompt (nenhum programa em execução)? */
  isAtPrompt() {
    if (!this.isAlive() || this.pendingCommand) return false;
    const text = this.cursorLineText().trimEnd();
    // PowerShell: "PS C:\...>" | cmd: "C:\...>" | bash/zsh: "...$" "...#" "...%"
    return /^PS [^>]*>$/.test(text) || /^[A-Za-z]:\\[^>]*>$/.test(text) || /[$#%]$/.test(text);
  }

  /** Digita texto no terminal; submit=true pressiona Enter. */
  sendText(text, { submit = true } = {}) {
    this.send({ t: "i", d: text });
    if (submit) setTimeout(() => this.send({ t: "i", d: "\r" }), 150);
  }

  reveal() {
    this.app.workspace.revealLeaf(this.leaf);
    this.app.workspace.setActiveLeaf(this.leaf, { focus: true });
    if (this.term) this.term.focus();
  }

  fitNow() {
    if (!this.fit || !this.contentEl.isShown()) return;
    try {
      this.fit.fit();
    } catch {}
  }

  resize() {
    if (!this.term) return;
    const { cols, rows } = this.term;
    this.fitNow();
    if (this.term.cols !== cols || this.term.rows !== rows || !this.lastSize) {
      this.lastSize = true;
      this.send({ t: "r", c: this.term.cols, r: this.term.rows });
    }
  }

  onResize() {
    this.resize();
  }

  async onClose() {
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.host) {
      const host = this.host;
      this.send({ t: "k" });
      setTimeout(() => {
        try {
          host.kill();
        } catch {}
      }, 1000);
      this.host = null;
    }
    if (this.term) {
      this.term.dispose();
      this.term = null;
    }
  }
}

class OpenTerminalPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new TerminalView(leaf, this));

    this.addRibbonIcon("terminal-square", "Abrir terminal", () => {
      this.openTerminal(this.getVaultPath());
    });

    this.addCommand({
      id: "open-terminal-vault",
      name: "Abrir terminal na raiz do vault",
      callback: () => this.openTerminal(this.getVaultPath()),
    });

    this.addCommand({
      id: "open-terminal-current-folder",
      name: "Abrir terminal na pasta da nota atual",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) this.openTerminal(this.getAbsolutePath(file.parent));
        return true;
      },
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        const folder = file instanceof TFolder ? file : file instanceof TFile ? file.parent : null;
        if (!folder) return;
        menu.addItem((item) =>
          item
            .setTitle("Abrir no terminal")
            .setIcon("terminal-square")
            .onClick(() => this.openTerminal(this.getAbsolutePath(folder)))
        );
      })
    );

    this.addSettingTab(new OpenTerminalSettingTab(this.app, this));
  }

  /**
   * API pública para outros plugins: abre um terminal e executa um comando.
   * Ex.: app.plugins.plugins["open-terminal"].runInTerminal("claude", { cwd })
   */
  async runInTerminal(command, { cwd, reuse = false } = {}) {
    cwd = cwd || this.getVaultPath();
    if (reuse) {
      const view = this.getTerminals().find((v) => v.isAtPrompt());
      if (view) {
        view.reveal();
        view.sendText(`${this.cdCommand(cwd)} ${this.shellSeparator()} ${command}`);
        return view;
      }
    }
    return this.openTerminal(cwd, command);
  }

  /** Terminais embutidos abertos, do mais recente para o mais antigo. */
  getTerminals() {
    return this.app.workspace
      .getLeavesOfType(VIEW_TYPE)
      .map((l) => l.view)
      .filter((v) => v instanceof TerminalView)
      .reverse();
  }

  cdCommand(dir) {
    const shell = this.getShell().cmd.toLowerCase();
    if (shell.includes("powershell") || shell.includes("pwsh")) return `Set-Location -LiteralPath ${this.quoteArg(dir)}`;
    if (shell.includes("cmd")) return `cd /d ${this.quoteArg(dir)}`;
    return `cd ${this.quoteArg(dir)}`;
  }

  shellSeparator() {
    const shell = this.getShell().cmd.toLowerCase();
    return shell.includes("cmd") ? "&&" : ";";
  }

  /** Cita um argumento de acordo com o shell configurado. */
  quoteArg(arg) {
    const shell = this.getShell().cmd.toLowerCase();
    if (shell.includes("cmd")) return '"' + String(arg).replace(/"/g, '""') + '"';
    // PowerShell, bash, zsh: aspas simples (sem expansão de variáveis)
    if (shell.includes("powershell") || shell.includes("pwsh")) return "'" + String(arg).replace(/'/g, "''") + "'";
    return "'" + String(arg).replace(/'/g, "'\\''") + "'";
  }

  async openTerminal(cwd, command) {
    if (!cwd) {
      new Notice("Não foi possível determinar o caminho da pasta.");
      return;
    }
    const { workspace } = this.app;
    let leaf;
    switch (this.settings.location) {
      case "tab":
        leaf = workspace.getLeaf("tab");
        break;
      case "right":
        leaf = workspace.getRightLeaf(false);
        break;
      default:
        leaf = workspace.getLeaf("split", "horizontal");
    }
    await leaf.setViewState({ type: VIEW_TYPE, active: true, state: { cwd, command } });
    workspace.revealLeaf(leaf);
    return leaf.view;
  }

  loadXterm() {
    if (!this.xterm) {
      const base = path.join(this.pluginDir(), "node_modules", "@xterm");
      const { Terminal } = window.require(path.join(base, "xterm", "lib", "xterm.js"));
      const { FitAddon } = window.require(path.join(base, "addon-fit", "lib", "addon-fit.js"));
      this.xterm = { Terminal, FitAddon };
    }
    return this.xterm;
  }

  getShell() {
    if (this.settings.shell === "custom" && this.settings.customShell.trim()) {
      const parts = this.settings.customShell.trim().match(/"[^"]*"|\S+/g).map((p) => p.replace(/^"|"$/g, ""));
      return { cmd: parts[0], args: parts.slice(1) };
    }
    const isWin = process.platform === "win32";
    const picked = SHELLS[this.settings.shell];
    if (picked && picked.win === isWin) return picked;
    if (isWin) return SHELLS.powershell;
    return { cmd: process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash"), args: ["-l"] };
  }

  resolveNodePath() {
    if (this.settings.nodePath.trim()) return this.settings.nodePath.trim();
    const candidates = [];
    const dirs = (process.env.PATH || "").split(path.delimiter);
    const exe = process.platform === "win32" ? "node.exe" : "node";
    for (const d of dirs) if (d) candidates.push(path.join(d, exe));
    if (process.platform === "win32") {
      candidates.push(path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"));
      if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, "nvm", "current", "node.exe"));
    } else {
      candidates.push("/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node");
    }
    return candidates.find((c) => fs.existsSync(c)) || null;
  }

  pluginDir() {
    return path.join(this.getVaultPath(), this.manifest.dir);
  }

  hostPath() {
    return path.join(this.pluginDir(), "pty-host.js");
  }

  getVaultPath() {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
    return null;
  }

  getAbsolutePath(folder) {
    const base = this.getVaultPath();
    if (!base) return null;
    if (!folder || folder.isRoot()) return base;
    return path.join(base, folder.path);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class OpenTerminalSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();

    new Setting(containerEl)
      .setName("Shell")
      .setDesc("Shell executado dentro do terminal embutido.")
      .addDropdown((dd) => {
        dd.addOption("auto", "Automático (recomendado)");
        if (process.platform === "win32") {
          dd.addOption("powershell", "Windows PowerShell");
          dd.addOption("pwsh", "PowerShell 7 (pwsh)");
          dd.addOption("cmd", "Prompt de Comando (cmd)");
        } else {
          dd.addOption("zsh", "Zsh");
          dd.addOption("bash", "Bash");
        }
        dd.addOption("custom", "Personalizado");
        dd.setValue(s.shell).onChange(async (v) => {
          s.shell = v;
          await save();
          this.display();
        });
      });

    if (s.shell === "custom") {
      new Setting(containerEl)
        .setName("Shell personalizado")
        .setDesc('Executável e argumentos. Ex.: "C:\\Program Files\\Git\\bin\\bash.exe" --login')
        .addText((t) =>
          t.setValue(s.customShell).onChange(async (v) => {
            s.customShell = v;
            await save();
          })
        );
    }

    new Setting(containerEl)
      .setName("Onde abrir")
      .addDropdown((dd) =>
        dd
          .addOption("bottom", "Painel abaixo (split)")
          .addOption("tab", "Nova aba")
          .addOption("right", "Barra lateral direita")
          .setValue(s.location)
          .onChange(async (v) => {
            s.location = v;
            await save();
          })
      );

    new Setting(containerEl)
      .setName("Tamanho da fonte")
      .setDesc("Vale para terminais abertos a partir de agora.")
      .addSlider((sl) =>
        sl
          .setLimits(9, 24, 1)
          .setValue(s.fontSize)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.fontSize = v;
            await save();
          })
      );

    new Setting(containerEl)
      .setName("Caminho do Node.js")
      .setDesc(`Deixe vazio para detectar automaticamente. Detectado: ${this.plugin.resolveNodePath() || "nenhum"}`)
      .addText((t) =>
        t
          .setPlaceholder("C:\\Program Files\\nodejs\\node.exe")
          .setValue(s.nodePath)
          .onChange(async (v) => {
            s.nodePath = v;
            await save();
          })
      );
  }
}

module.exports = OpenTerminalPlugin;
