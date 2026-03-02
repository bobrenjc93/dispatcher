# Dispatcher

A cross-platform desktop terminal multiplexer built with Tauri, React, and xterm.js. Organize your terminal sessions into projects and groups with a visual tree sidebar, split panes, and drag-and-drop reordering.

<img width="2822" height="2356" alt="CleanShot 2026-03-01 at 20 01 32@2x" src="https://github.com/user-attachments/assets/fbb8441b-d426-4875-8a47-093e4bc88a21" />

## Features

- **Project-based organization** — Group terminals by project, each with its own working directory
- **Hierarchical tree sidebar** — Nest terminals inside groups and projects; drag-and-drop to reorder
- **Split panes** — Horizontal and vertical splits with resizable dividers
- **Instant terminal creation** — PTY pool pre-spawns shells so new tabs open immediately
- **Cross-platform** — macOS (Apple Silicon + Intel), Linux, and Windows

## Install

Download the latest release for your platform from the [Releases](https://github.com/TheBuilderJR/dispatcher/releases) page:

| Platform | Asset |
|----------|-------|
| macOS (Apple Silicon) | `Dispatcher_x.x.x_aarch64.dmg` |
| macOS (Intel) | `Dispatcher_x.x.x_x64.dmg` |
| Linux | `Dispatcher_x.x.x_amd64.AppImage` or `.deb` |
| Windows | `Dispatcher_x.x.x_x64-setup.exe` or `.msi` |

### macOS

Open the `.dmg` and drag Dispatcher to your Applications folder. On first launch, you may need to right-click and select "Open" to bypass Gatekeeper (until signed releases are configured).

### Linux

Make the AppImage executable and run it:

```bash
chmod +x Dispatcher_*.AppImage
./Dispatcher_*.AppImage
```

Or install the `.deb`:

```bash
sudo dpkg -i Dispatcher_*.deb
```

### Windows

Run the `.msi` installer or the setup `.exe`.

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) (LTS)
- [Rust](https://www.rust-lang.org/tools/install) (stable)
- Platform-specific dependencies:
  - **Ubuntu/Debian:** `sudo apt install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`)
  - **Windows:** [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/), WebView2

### Setup

```bash
npm install
npm run tauri dev
```

### Production build

```bash
npm run tauri build
```

Build artifacts are written to `src-tauri/target/release/bundle/`.

## Releasing

Releases are automated via GitHub Actions. To create a new release:

```bash
# Bump version in src-tauri/tauri.conf.json, then:
git tag v0.2.0
git push origin v0.2.0
```

This triggers the release workflow which builds for all platforms and creates a draft GitHub Release with the compiled assets. Review the draft and publish it when ready.

## Tech Stack

- **Frontend:** React 19, TypeScript, Vite, xterm.js, Zustand
- **Backend:** Tauri 2 (Rust), portable-pty
- **CI/CD:** GitHub Actions with `tauri-apps/tauri-action`
