"use strict";

// Registry of terminals embedded in ```terminal blocks (notes and Canvas).

const { TFile } = require("obsidian");
const path = require("path");
const { BLOCK_LANG } = require("./constants");
const { TerminalSession } = require("./terminal-session");
const { TerminalBlockChild } = require("./terminal-block");

/** "key: value" options of a ```terminal block. */
function parseBlockOptions(source) {
  const opts = {};
  for (const line of source.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/);
    if (m) opts[m[1].toLowerCase()] = m[2];
  }
  return opts;
}

/** Session key: the block's "id:", or file + block content. */
function blockKey(source, sourcePath) {
  const { id } = parseBlockOptions(source);
  return id ? `id:${id}` : `${sourcePath}::${source.trim()}`;
}

function newBlockId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** Markdown for a new terminal block with a fresh id. */
function newBlockMarkdown() {
  return "```" + BLOCK_LANG + "\nid: " + newBlockId() + "\n```";
}

class BlockSessions {
  constructor(plugin, { language = BLOCK_LANG, createSession } = {}) {
    this.plugin = plugin;
    this.language = language;
    this.createSession = createSession || ((opts, ctx) => new TerminalSession(this.plugin, {
      cwd: this.resolveCwd(opts.cwd, ctx.sourcePath),
      command: opts.command,
    }));
    this.sessions = new Map(); // block key -> TerminalSession
    this.orphanTimers = new Map();
  }

  /** Markdown code block processor for a terminal-like block. */
  async process(source, el, ctx) {
    const opts = parseBlockOptions(source);
    const key = blockKey(source, ctx.sourcePath);
    let session = this.sessions.get(key);
    if (!session || session.disposed) {
      session = await this.createSession(opts, ctx, source);
      if (!session) return;
      this.sessions.set(key, session);
    }
    ctx.addChild(new TerminalBlockChild(el, this, session, key, ctx.sourcePath));
  }

  /** Block cwd: absolute, relative to the vault root, or (default) the folder of the file containing the block. */
  resolveCwd(cwd, sourcePath) {
    const vault = this.plugin.getVaultPath();
    if (cwd) return path.isAbsolute(cwd) ? cwd : path.join(vault, cwd);
    const file = this.plugin.app.vault.getAbstractFileByPath(sourcePath);
    return file instanceof TFile ? this.plugin.getAbsolutePath(file.parent) : vault;
  }

  /** Sessions currently shown on screen, most recently used first. */
  visible() {
    return [...this.sessions.values()]
      .filter((s) => !s.disposed && s.isAttached())
      .sort((a, b) => b.lastActive - a.lastActive);
  }

  /**
   * Called when a block leaves the DOM. Canvas unloads off-screen cards,
   * so the shell is only stopped if the block no longer exists in the file.
   */
  scheduleOrphanCheck(key, sourcePath) {
    clearTimeout(this.orphanTimers.get(key));
    this.orphanTimers.set(
      key,
      setTimeout(async () => {
        this.orphanTimers.delete(key);
        const session = this.sessions.get(key);
        if (!session || session.isAttached()) return;
        const file = this.plugin.app.vault.getAbstractFileByPath(sourcePath);
        let keys = new Set();
        if (file instanceof TFile) {
          try {
            keys = this.keysInFile(await this.plugin.app.vault.cachedRead(file), file);
          } catch {
            return;
          }
        }
        if (keys === null) return;
        if (!keys.has(key) && !session.isAttached()) {
          session.dispose();
          this.sessions.delete(key);
        }
      }, 5000)
    );
  }

  keysInFile(content, file) {
    let texts = [content];
    if (file.extension === "canvas") {
      try {
        const data = JSON.parse(content);
        texts = (data.nodes || []).filter((n) => n.type === "text").map((n) => n.text || "");
      } catch {
        return null;
      }
    }
    const keys = new Set();
    const fence = new RegExp("^(`{3,}|~{3,})[ \\t]*" + this.language + "[ \\t]*\\r?\\n([\\s\\S]*?)^\\1[ \\t]*$", "gm");
    for (const text of texts) {
      for (const m of text.matchAll(fence)) keys.add(blockKey(m[2], file.path));
    }
    return keys;
  }

  disposeAll() {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
    for (const timer of this.orphanTimers.values()) clearTimeout(timer);
    this.orphanTimers.clear();
  }
}

module.exports = { BlockSessions, parseBlockOptions, blockKey, newBlockMarkdown };
