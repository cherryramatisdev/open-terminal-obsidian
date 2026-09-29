"use strict";

// Canvas helpers. These use Obsidian's internal, undocumented Canvas API.

const { ItemView, Notice } = require("obsidian");
const { newBlockMarkdown } = require("./block-sessions");

/** The canvas in the active view, or null. */
function getActiveCanvas(app) {
  const view = app.workspace.getActiveViewOfType(ItemView);
  return view && view.getViewType() === "canvas" && view.canvas ? view.canvas : null;
}

/** Adds a text card containing a ```terminal block at the center of the canvas view. */
function addTerminalToCanvas(canvas) {
  if (typeof canvas.createTextNode !== "function") {
    new Notice("This Obsidian version doesn't allow plugins to create cards. Create a text card with a ```terminal block instead.");
    return;
  }
  const center = typeof canvas.posCenter === "function" ? canvas.posCenter() : { x: 0, y: 0 };
  canvas.createTextNode({
    pos: center,
    position: "center",
    size: { width: 640, height: 380 },
    text: newBlockMarkdown(),
    focus: false,
    save: true,
  });
  if (typeof canvas.requestSave === "function") canvas.requestSave();
}

module.exports = { getActiveCanvas, addTerminalToCanvas };
