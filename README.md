# Dispatcher

A desktop terminal multiplexer built with Tauri, React, and xterm.js. Organize shells into projects, tabs, and split panes, keep notes next to live terminals, and bridge `tmux -CC` sessions into native Dispatcher tabs.

<img width="2846" height="2046" alt="CleanShot 2026-03-01 at 20 33 45@2x" src="https://github.com/user-attachments/assets/6071950f-3529-426c-bbd5-27007033ca25" />

## Features

- **Project-based organization** — group tabs by project with a tree sidebar and drag-and-drop reordering
- **Split panes** — horizontal and vertical splits with resizable dividers
- **Per-tab notes** — keep notes attached to the tab you are actually working in
- **Activity status dots** — green for active work, pulsing green for stale unseen work, brown for acknowledged stale work, gray for long-idle acknowledged work
- **Fast local terminals** — PTY pooling keeps new local tabs feeling immediate
- **Browser access on port 3003** — the running app also serves itself over HTTP; open it in a browser and you get the same session, mirrored live
- **tmux `-CC` integration** — run `tmux -CC` locally or over SSH and map tmux windows to Dispatcher tabs and tmux panes to Dispatcher splits
- **tmux-aware shortcuts** — `Cmd+T`, split, close, focus, and rename route to tmux when the active tab is backed by a live control-mode session
- **Restart-safe tmux placeholders** — if Dispatcher restarts, saved tmux tabs keep their titles and notes and come back with reconnect instructions instead of disappearing
- **Built-in diagnostics** — startup, crash, renderer, and tmux events are written to a rotating persistent log (`~/Library/Logs/com.dispatcher.desktop/dispatcher-debug.log` on macOS)
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

## Browser access

Whenever Dispatcher is running it also serves itself on port **3003**:

```
http://localhost:3003
```

If 3003 is already taken — another Dispatcher, or anything else — it walks up
to the next free port (3004, 3005, ...). The port it settled on is written to
the diagnostic log at startup, along with the LAN URL.

It listens on all interfaces, so the same URL works from a phone or another
machine on your network using this machine's LAN address.

### How it works

The desktop window is the master. It is the only client that owns PTYs and
drives tmux. A browser is a **replica**: it renders what the desktop mirrors to
it, and anything you do there is sent to the desktop to perform.

```
browser  --- action (keystroke, new tab, split, close) --->  desktop  ---> PTY / tmux
browser  <-------------- mirrored output + grid size --------  desktop  <---
```

Because every effect happens in one place, there is no second writer on a PTY
and no second driver on the tmux control stream — the browser stays interactive
without any of the races that sharing those would create.

What this gives you:

- **Everything is mirrored**, including tmux. Type in the browser and the
  keystroke is performed by the desktop; the output comes back the same way it
  reaches the desktop's own screen. A replica that connects late gets the recent
  scrollback replayed so it starts on the same screen.
- **One workspace.** Projects, tabs, splits, notes, titles and the active tab
  are the same document in both. Open a tab in the browser and it appears in the
  desktop window, and the other way around.
- **The desktop decides sizing.** A replica renders the grid the desktop is
  using, so line wrapping matches instead of reflowing per window.

Set `DISPATCHER_WEB_PORT` to change the port it starts looking from.

> **This is unauthenticated.** Anyone who can reach port 3003 gets a shell as
> you, with no password. Only run it on networks you trust. To reach Dispatcher
> from elsewhere, prefer an SSH tunnel
> (`ssh -L 3003:localhost:3003 your-machine`) over exposing the port.

### On a phone

Below 820px the UI switches to a single column:

- the sidebar becomes a drawer behind the ☰ button, closing as soon as you pick
  a tab
- notes move behind a **Notes** toggle instead of taking a column
- the terminal gets the rest of the screen, with tap targets sized for thumbs

The grid belongs to the desktop, and a desktop's 97 columns do not fit a phone,
so a replica scales its own font rather than reflowing the terminal — reflowing
would change what the desktop shows. The **Fit** button chooses how to lose:

- **off (default)** — text stays readable and long lines run off the side to be
  swiped to
- **on** — shrink until every column is on screen, however small

The choice is per-device, so a phone can differ from the desktop.

Two boxes can be scrolled away from the prompt and both are handled: xterm's
own scrollback, and — because in readable mode the grid is larger than the
screen — the `.terminal-container` that scrolls the element itself. The second
is the one a soft keyboard pushes off screen.

The terminal opens on the newest output and stays there as output arrives,
unless you scroll up — then it leaves you where you put it until you scroll
back down. Opening the keyboard does not cost you that position: a soft
keyboard shrinks the *visual* viewport rather than the window, so the app
sizes itself to the visual viewport and re-pins the terminal each time the
keyboard opens, closes or rotates. Without that the prompt sits behind the
keyboard and every tap means scrolling again.

The terminal is also focused on load, so the first tap types rather than
merely focusing. iOS will not raise the keyboard until that first tap
regardless — it only opens one in response to a gesture, never on load.

### Dictation

Dictation revises as it listens, sending the whole phrase so far on every
update and expecting the target to replace its value. A text input does that; a
terminal cannot, because it has no value — only a byte stream. Left alone,
"can you do it for me" arrives as
`ccancan ycan youcan you dcan you docan you do it for me?can you do it for me?`.

iOS fires no composition events for dictation, so there is nothing to bracket
the utterance with. What it does do is send a strictly longer string beginning
with the previous one, so Dispatcher sends only the new part, and drops the
duplicate final result. A revision more than five seconds after the last one is
treated as a fresh utterance, and anything containing a control character ends
one.

A soft keyboard has no Ctrl, Esc, Tab or arrows, so a key bar sits under the
terminal with **esc**, **tab**, **^C**, **^R** and the four arrows. **ctrl** is
sticky: tap it, then tap a letter, and the two are folded into a control code —
so Ctrl+anything is reachable, not just the two shortcuts with their own key.

### Under `tauri dev`

The dev server is proxied through the Dispatcher port, so the URL above is the
only one you need in development too — including from another device. Live
reload is the exception: it does not tunnel through the proxy, so a browser
viewing a dev build will not hot-reload. The desktop window, which loads Vite
directly, still does.

### Limits

The desktop window has to be running — it is the thing being replicated. If it
is closed, the browser has nothing to mirror.

A few things stay native-only because they have no browser equivalent: the
macOS font panel, window theming, dock attention bounces, and dragging files in
from the OS. The browser uses its own clipboard and opens links in a new tab.

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

## Session recordings

Every run records its terminals to disk so a rendering bug can be looked at
after it happens, instead of being reproduced on demand.

```
~/Library/Logs/com.dispatcher.desktop/recordings/<run>/
  index.json              which recording is which tab: title, project, backend, tmux ids
  events.jsonl            resizes and dropped output — the things that reshape a pane
  transport-<id>.cast     raw PTY bytes, both directions: exactly what ssh and tmux exchanged
  pane-<id>.cast          bytes written into one pane's terminal, after tmux was decoded
```

The `.cast` files are [asciinema](https://asciinema.org) v2, so they are plain
JSON lines — `[seconds, "o"|"i", "data"]` — and can also be replayed:

```bash
asciinema play transport-<id>.cast
```

Two streams are kept because they answer different questions. The **transport**
is the ground truth from the remote: for a `tmux -CC` tab it is the whole
control-mode conversation, `%output` and `%layout-change` and all, plus every
byte Dispatcher sent back. The **pane** stream is what one pane's terminal
actually received once that conversation was decoded — which is what rendering
follows. If a pane draws wrong, the two together say whether the remote sent
something odd or Dispatcher mis-handled it. Local shells only get a transport
recording, because their pane stream is the same bytes.

To report a problem, note the **tab title** and roughly **when** it happened;
`index.json` maps titles to files and every entry is timestamped from the start
of the run. The current directory is written to the debug log at startup.

Recordings are capped at 24 MB each, the last 12 runs are kept, and the whole
directory is held under 2 GB. They contain full terminal output — set
`DISPATCHER_RECORD=0` to turn recording off.

## Terminals outlive the UI

PTYs are owned by the backend process, not by the window, and they are
*reattached* rather than recreated when the UI comes back. Reloading the
frontend — which happens on every edit under `tauri dev` — keeps:

- the shell, and its process tree, running untouched
- any ssh connection, so no re-authenticating
- the tmux control session, so no `tmux -CC a` again

On reload the UI asks the backend which terminals are still running. Those are
reattached and replayed the output they missed; tmux tabs backed by a live
transport keep their windows and panes instead of collapsing into
placeholders, and the control session is resumed by nudging the live transport
until tmux answers. Terminals that really are gone still become the
restart-safe placeholders they always did.

### The terminal daemon

PTYs do not live in the app process at all. Dispatcher starts a small daemon —
the same binary, run with `--dispatcher-daemon` — and attaches to it over a
loopback socket. Because the terminals belong to the daemon rather than to the
window, they also survive the app itself:

- quitting and reopening Dispatcher
- the app crashing
- `tauri dev` rebuilding after a Rust change

On attach the app asks the daemon which terminals are still running, reattaches
to them, and is replayed the output it missed — the same path a UI reload
takes, so ssh connections and tmux control sessions come back intact rather
than as placeholders.

The daemon exits on its own once it has no terminals left and nothing has been
attached for fifteen minutes, so it does not linger after you are done. Dev and
release builds use separate daemons, so a dev rebuild never hands its terminals
to the installed app.

The socket is loopback TCP rather than a unix socket so the same code works on
Windows. Anyone who can open a loopback port could otherwise reach it, so a
connection is only served after presenting the token from the endpoint file,
which is written owner-readable next to the diagnostic log.

Because the daemon is the same binary as the app, a pattern kill aimed at
Dispatcher matches it too and takes every terminal down. To restart the app
without touching them, exclude the daemon:

```bash
pkill -f 'Dispatcher$'                       # app only
pgrep -f -- --dispatcher-daemon              # the daemon, left alone
```

Set `DISPATCHER_DAEMON=0` to keep terminals in the app process instead. That is
also the automatic fallback: if the daemon cannot be started or reached,
Dispatcher runs them in-process rather than leaving you with no terminals, and
says which it chose in the diagnostic log.

### When a tmux attach goes silent

`tmux -CC` normally answers within milliseconds. Dispatcher watches for a
control-mode command and, if nothing comes back, says so in the tab rather than
leaving it looking frozen.

The cause is almost always a tmux server whose binary was replaced while it was
running — a package upgrade some time after the server started. Traced on a
live server, it accepts the connection, receives both terminal descriptors over
`SCM_RIGHTS`, receives the `attach` command, and then reaches `control_start()`
with both descriptors already lost: it runs `close(-1)` / `fcntl(-1)` and writes
the `\x1bP1000p` preamble into a bufferevent on fd -1. Nothing ever reaches the
client, the tty is already in raw mode so Ctrl-C does not help, and each attempt
strands another client on the server and leaks two descriptors there.

Commands keep working, because they are answered over the socket and never need
those descriptors — which is why such a server looks healthy. Confirm it with:

```bash
readlink /proc/$(tmux display-message -p '#{pid}')/exe
# ending in "(deleted)" means the binary was replaced under the server
```

A server in this state cannot be repaired; attaching will never work again.
Save any scrollback with `tmux capture-pane -p -S - -t <pane>`, then
`tmux kill-server` — which destroys every session on that host. This is not
something Dispatcher causes, and no client-side change can avoid it.

### Bounce When Done

Right-click a tab and toggle **Bounce When Done** to have the dock icon bounce
when that tab starts needing attention. It bounces on the transition into
needing attention rather than repeatedly while it persists, and stays quiet
when you are already looking at that tab in a focused window. On macOS the
bounce continues until Dispatcher is activated, so a tab that finished while
you were in another app is still asking for you when you come back.

This is separate from **Notify on Inaction**, which plays a sound once a tab
has been quiet for a while; the two can be enabled independently.

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
