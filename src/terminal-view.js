"use strict";

const { ItemView } = require("obsidian");
const path = require("path");
const { VIEW_TYPE } = require("./constants");
const { TerminalSession } = require("./terminal-session");

class TerminalView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.cwd = null;
    this.session = null;
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
    if (state && state.cwd && !this.session) this.startSession(state.cwd, state.command);
    await super.setState(state, result);
  }

  async onOpen() {
    this.contentEl.empty();
    this.contentEl.addClass("open-terminal-container");

    // In case the view is opened without state (e.g. a restored layout with no cwd)
    setTimeout(() => {
      if (!this.session) this.startSession(this.plugin.getVaultPath());
    }, 150);
  }

  startSession(cwd, command) {
    if (!cwd) return;
    this.cwd = cwd;
    this.session = new TerminalSession(this.plugin, { cwd, command });
    this.session.onReveal = () => {
      this.app.workspace.revealLeaf(this.leaf);
      this.app.workspace.setActiveLeaf(this.leaf, { focus: true });
    };
    this.session.attach(this.contentEl);
    this.leaf.updateHeader && this.leaf.updateHeader();
    this.session.focus();
  }

  // Kept for compatibility with code that uses the view directly
  isAlive() {
    return !!this.session && this.session.isAlive();
  }

  isAtPrompt() {
    return !!this.session && this.session.isAtPrompt();
  }

  sendText(text, opts) {
    if (this.session) this.session.sendText(text, opts);
  }

  reveal() {
    if (this.session) this.session.reveal();
  }

  onResize() {
    if (this.session) this.session.resize();
  }

  async onClose() {
    if (this.session) {
      this.session.dispose();
      this.session = null;
    }
  }
}

module.exports = { TerminalView };
