"use strict";

const { MarkdownRenderChild, setIcon } = require("obsidian");
const path = require("path");

/** Terminal embedded in a ```terminal block (notes and Canvas text cards). */
class TerminalBlockChild extends MarkdownRenderChild {
  constructor(el, blocks, session, key, sourcePath) {
    super(el);
    this.blocks = blocks;
    this.session = session;
    this.key = key;
    this.sourcePath = sourcePath;
  }

  onload() {
    const el = this.containerEl;
    el.empty();
    el.addClass("open-terminal-block");

    const toolbar = el.createDiv({ cls: "open-terminal-block-toolbar" });
    setIcon(toolbar.createSpan({ cls: "open-terminal-block-icon" }), "terminal-square");
    toolbar.createSpan({ cls: "open-terminal-block-title", text: path.basename(this.session.cwd || "") || "Terminal" });
    toolbar.setAttr("title", this.session.cwd || "");
    const button = (icon, label, onClick) => {
      const b = toolbar.createEl("button", { cls: "clickable-icon open-terminal-block-button", attr: { "aria-label": label } });
      setIcon(b, icon);
      this.registerDomEvent(b, "click", (e) => {
        e.stopPropagation();
        onClick();
      });
    };
    button("rotate-ccw", "Restart terminal", () => this.session.restart());
    button("square", "Stop process", () => this.session.kill());

    this.body = el.createDiv({ cls: "open-terminal-block-body" });

    // Keep Canvas from dragging/selecting/zooming or deleting the card while the terminal is in use.
    // The toolbar still works as the handle for dragging and editing the card.
    for (const ev of ["pointerdown", "mousedown", "click", "dblclick", "wheel", "keydown", "keyup", "contextmenu"]) {
      this.registerDomEvent(this.body, ev, (e) => e.stopPropagation());
    }

    this.session.onReveal = () => el.scrollIntoView({ block: "nearest" });
    whenConnected(el, () => {
      if (this.unloaded) return;
      this.fitToCanvasNode();
      this.session.attach(this.body);
    });
  }

  /** In Canvas, makes the terminal fill the card's full height. */
  fitToCanvasNode() {
    const nodeEl = this.containerEl.closest(".canvas-node-content");
    if (!nodeEl) return;
    this.containerEl.addClass("is-canvas");
    const apply = () => (this.containerEl.style.height = `${nodeEl.clientHeight}px`);
    apply();
    this.nodeObserver = new ResizeObserver(apply);
    this.nodeObserver.observe(nodeEl);
  }

  onunload() {
    this.unloaded = true;
    if (this.nodeObserver) this.nodeObserver.disconnect();
    if (this.session.parentEl === this.body) this.session.detach();
    // If the block was deleted from the note/canvas, stop the shell; if it just went off-screen, keep it alive
    this.blocks.scheduleOrphanCheck(this.key, this.sourcePath);
  }
}

/** Runs cb once el is in the document (Markdown rendering creates the element before inserting it). */
function whenConnected(el, cb, tries = 120) {
  if (el.isConnected) return cb();
  if (tries <= 0) return;
  requestAnimationFrame(() => whenConnected(el, cb, tries - 1));
}

module.exports = { TerminalBlockChild };
