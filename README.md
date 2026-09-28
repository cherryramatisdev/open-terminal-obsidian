# 🖥️ Open Terminal

A cozy little terminal for [Obsidian](https://obsidian.md), built with [xterm.js](https://xtermjs.org/) and [node-pty](https://github.com/microsoft/node-pty). It opens a real shell right where you need it — at your vault root, or in the folder of the note you're staring at — so you never have to alt-tab away from your notes just to run a command.

> 🚧 **Work in progress!** This is a personal plugin, still growing and occasionally rough around the edges. Things may change, break, or get polished without warning. Contributions, bug reports, and gentle nudges are very welcome.

Desktop only (Windows, macOS, Linux) — sorry mobile, terminals just don't fit in your pocket yet. 📱🚫

## ✨ Features

- Full terminal emulation (xterm.js) that matches your Obsidian theme's colors and monospace font, so it feels like it belongs.
- Opens at the vault root, at the current note's folder, or at any folder via the right-click menu.
- Pick where it lives: split panel below, new tab, or right sidebar.
- Copy on selection + Ctrl/Cmd shortcuts for copy/paste, like a real terminal should.
- Plays nice with other plugins — reuses an idle terminal at its prompt, or opens a fresh one, via `runInTerminal`.
- Auto-detects your shell and Node.js binary, but you can always override both.

## 📦 Installation

This little guy isn't in the Obsidian Community Plugins directory yet, so for now it's a manual install.

1. Download or clone this repository.
2. Install dependencies (this also builds the native `node-pty` module for your platform):
   ```bash
   npm install
   ```
3. Copy (or symlink) the plugin folder into your vault's plugins directory:
   ```
   <your-vault>/.obsidian/plugins/open-terminal/
   ```
   It must contain `manifest.json`, `main.js`, `pty-host.js`, `styles.css`, and `node_modules/`.
4. In Obsidian, go to **Settings → Community plugins**, disable Safe Mode if needed, and enable **Open Terminal**. 🎉

## 🍎 Running on macOS

The plugin runs happily on macOS out of the box — no code changes needed, just a couple of platform-specific setup steps:

1. **Node.js must be installed on your Mac** (the plugin shells out to a local Node binary to host the pseudoterminal). Install it via [Homebrew](https://brew.sh) if you don't already have it:
   ```bash
   brew install node
   ```
   The plugin auto-detects Node at `/opt/homebrew/bin/node` (Apple Silicon), `/usr/local/bin/node` (Intel Homebrew), `/usr/bin/node`, or anything on your `PATH`. If detection fails, set **Node.js path** manually in the plugin settings (run `which node` in Terminal.app to find it).

2. **`node-pty` is a native addon** and must be built for macOS. Running `npm install` (step 2 above) compiles it locally via `node-gyp`, so make sure Xcode Command Line Tools are installed first:
   ```bash
   xcode-select --install
   ```
   If you copy a `node_modules` folder that was built on Windows or Linux, the terminal won't start — always run `npm install` on the same machine (or at least the same OS/arch) where the plugin will run.

   > **Known gremlin:** if you copy/sync the plugin folder into your vault (iCloud Drive, a zip, some file managers), the executable bit on `node_modules/node-pty/prebuilds/darwin-*/spawn-helper` can get stripped, and the terminal fails with `Error: posix_spawnp failed`. The fix is one line:
   > ```bash
   > chmod +x "<vault>/.obsidian/plugins/open-terminal/node_modules/node-pty/prebuilds"/darwin-*/spawn-helper
   > ```

3. **Shell selection**: in plugin settings, the **Shell** dropdown offers **Automatic** (uses your macOS default login shell, i.e. `$SHELL`, typically Zsh), **Zsh**, **Bash**, or **Custom** (e.g. `/opt/homebrew/bin/fish -l`). Automatic is recommended — it just works.

Everything else — vault/note folders, split/tab/sidebar placement, font size, copy/paste — behaves identically across platforms. 🤝

## ⚙️ Settings

| Setting | Description |
|---|---|
| Shell | Which shell to launch. "Automatic" picks PowerShell on Windows and your `$SHELL` (Zsh by default) on macOS/Linux. Platform-specific options (PowerShell/cmd on Windows, Zsh/Bash on macOS/Linux) and a free-form "Custom" option are also available. |
| Where to open | Split panel below, new tab, or right sidebar. |
| Font size | Applies to terminals opened after the change. |
| Node.js path | Leave empty to auto-detect; set explicitly if detection fails. |

## 🚀 Usage

- Click the terminal icon in the ribbon, or run **Open terminal at vault root** / **Open terminal at current note's folder** from the command palette.
- Right-click a file or folder in the file explorer and choose **Abrir no terminal** to open a terminal rooted there.

## 🔌 For plugin developers

Other plugins can open a terminal and run a command in it:

```js
app.plugins.plugins["open-terminal"].runInTerminal("claude", { cwd, reuse: true });
```

- `cwd` — folder to run in (defaults to the vault root).
- `reuse` — if `true`, reuses an existing idle terminal at its prompt instead of opening a new one.

## 🧠 How it works

`main.js` runs in Obsidian's Electron/Node context and spawns `pty-host.js` as a child process using the system Node binary (not Electron's bundled Node, since native addons like `node-pty` need to match the Node ABI). `pty-host.js` owns the actual pseudoterminal (via `node-pty`) and chats with the plugin over stdio using newline-delimited JSON messages for input, resize, and shutdown.

## 🗺️ Roadmap-ish

Nothing formal yet — this plugin grows as it's needed. Ideas, issues, and PRs are welcome while it finds its shape.

## 📄 License

MIT
