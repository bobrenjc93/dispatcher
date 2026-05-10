# Dispatcher

A desktop terminal multiplexer built with Tauri, React, and xterm.js. Organize shells into projects, tabs, and split panes, keep notes next to live terminals, and bridge `tmux -CC` sessions into native Dispatcher tabs.

<img width="2846" height="2046" alt="CleanShot 2026-03-01 at 20 33 45@2x" src="https://github.com/user-attachments/assets/6071950f-3529-426c-bbd5-27007033ca25" />

## Features

- **Project-based organization** — group tabs by project with a tree sidebar and drag-and-drop reordering
- **Split panes** — horizontal and vertical splits with resizable dividers
- **Per-tab notes** — keep notes attached to the tab you are actually working in
- **Activity status dots** — green for active work, pulsing green for stale unseen work, brown for acknowledged stale work, gray for long-idle acknowledged work
- **Fast local terminals** — PTY pooling keeps new local tabs feeling immediate
- **tmux `-CC` integration** — run `tmux -CC` locally or over SSH and map tmux windows to Dispatcher tabs and tmux panes to Dispatcher splits
- **tmux-aware shortcuts** — `Cmd+T`, split, close, focus, and rename route to tmux when the active tab is backed by a live control-mode session
- **Restart-safe tmux placeholders** — if Dispatcher restarts, saved tmux tabs keep their titles and notes and come back with reconnect instructions instead of disappearing
- **Built-in diagnostics** — tmux control-mode events are logged to `/tmp/dispatcher-debug.log` for debugging
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
npm run tauri -- dev
```

### Production build

```bash
npm run tauri -- build
```

Build artifacts are written to `src-tauri/target/release/bundle/`.

## tmux `-CC`

Dispatcher can promote a regular shell into a tmux control-mode session.

```bash
tmux -CC new-session -A -s dispatcher
```

You can do that locally or after `ssh`-ing into another machine. Once tmux enters control mode:

- tmux windows become Dispatcher tabs
- tmux panes become Dispatcher splits
- `Cmd+T` creates a tmux window instead of a local tab
- split and close actions target tmux instead of the local PTY layer

If Dispatcher restarts while a tmux-backed workspace is open, those tabs come back as disconnected placeholders. Open a normal terminal with `Cmd+T`, re-ssh if needed, then run:

```bash
tmux -CC a
```

Dispatcher will reconnect and hydrate the saved tmux tabs in place.

## Status Dots

Dispatcher's status dots are intentionally a small state machine, not raw PTY
output indicators:

- **Green** means the agent appears active: Dispatcher is seeing accepted
  progress, or the tab has not yet crossed the stale threshold.
- **Pulsing green** means the tab was green, then became stale while it was in
  the background. It needs the user's attention because the current output has
  not been acknowledged.
- **Brown** means stale output has been acknowledged. The common flow is:
  a background tab pulses, the user views it, and no real progress or user input
  follows. Focusing the pulsing tab must not restart the inactivity timer.
- **Gray** means a brown tab stayed unchanged for the long-inactivity window.

Tmux tabs can redraw on focus or resize without real agent progress. Dispatcher
suppresses those focus-only redraws briefly so tmux churn does not incorrectly
clear pulsing or brown state.

## Releasing

Releases are automated via GitHub Actions. To create a new release:

```bash
# Bump the app version, commit, then:
git tag vX.Y.Z
git push origin main --tags
```

This triggers the release workflow, builds the installers for all platforms, and publishes the GitHub Release with the compiled assets attached.

## Tech Stack

- **Frontend:** React 19, TypeScript, Vite, xterm.js, Zustand
- **Backend:** Tauri 2 (Rust), portable-pty
- **CI/CD:** GitHub Actions with `tauri-apps/tauri-action`
