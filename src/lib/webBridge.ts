/**
 * Lets the Dispatcher frontend run in an ordinary web browser.
 *
 * Inside the Tauri window, `window.__TAURI_INTERNALS__` is injected by the
 * runtime and every `invoke`, `Channel` and `listen` call goes over native IPC.
 * A browser has none of that, so this module installs a stand-in backed by a
 * WebSocket to the Dispatcher process (see `src-tauri/src/web_server.rs`).
 *
 * Because the stand-in matches the shapes `@tauri-apps/api` expects, the rest
 * of the app — stores, hooks, terminal bridge — is identical in both runtimes
 * and never has to ask which one it is running in.
 */

import { getClientId } from "./clientId";

const WEB_PORT = 3003;
/** Vite's port in `tauri dev`, per vite.config.ts. */
const VITE_DEV_PORT = "1420";
const RECONNECT_DELAY_MS = 1_000;

type Callback = (payload: unknown) => void;

interface PendingInvoke {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface ServerMessage {
  type: "ready" | "response" | "channel" | "event";
  id?: number;
  ok?: boolean;
  value?: unknown;
  error?: string;
  channelId?: string;
  message?: unknown;
  event?: string;
  payload?: unknown;
}

interface EventListenerEntry {
  eventId: number;
  event: string;
  handler: (event: { event: string; id: number; payload: unknown }) => void;
}

/** True when the app is running in a plain browser rather than the Tauri window. */
export function isWebClient(): boolean {
  return webClient;
}

let webClient = false;

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

let socket: WebSocket | null = null;
let socketReady = false;
const outboundQueue: string[] = [];

const pendingInvokes = new Map<number, PendingInvoke>();
let nextInvokeId = 1;

const callbacks = new Map<number, { fn: Callback; once: boolean }>();
let nextCallbackId = 1;

/** Tauri channels expect strictly ordered, indexed messages. */
const channelMessageIndex = new Map<number, number>();

const eventListeners = new Map<string, EventListenerEntry[]>();
let nextEventId = 1;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function serverOrigin(): string {
  // `?dispatcherServer=host:port` covers reverse proxies and SSH tunnels.
  const override = new URLSearchParams(window.location.search).get("dispatcherServer");
  if (override) {
    return override;
  }

  // Opening the Vite dev server directly is the one case where the page and the
  // bridge are on different ports; the bridge is on the Dispatcher port.
  if (import.meta.env.DEV && window.location.port === VITE_DEV_PORT) {
    return `${window.location.hostname}:${WEB_PORT}`;
  }

  // Otherwise Dispatcher served this page — in a release build from its own
  // assets, in dev by proxying Vite — so the bridge is on this very origin.
  // Using the origin rather than a fixed port is also what keeps a shifted
  // port (3004, 3005, ...) and remote hosts working with no configuration.
  return window.location.host;
}

function socketUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${serverOrigin()}/dispatcher-ws?clientId=${encodeURIComponent(getClientId())}`;
}

function send(payload: unknown) {
  const text = JSON.stringify(payload);
  if (socket && socketReady) {
    socket.send(text);
    return;
  }
  outboundQueue.push(text);
}

function flushQueue() {
  if (!socket || !socketReady) {
    return;
  }
  while (outboundQueue.length > 0) {
    socket.send(outboundQueue.shift()!);
  }
}

function runCallback(id: number, payload: unknown) {
  const entry = callbacks.get(id);
  if (!entry) {
    return;
  }
  if (entry.once) {
    callbacks.delete(id);
  }
  entry.fn(payload);
}

function handleServerMessage(raw: string) {
  let message: ServerMessage;
  try {
    message = JSON.parse(raw) as ServerMessage;
  } catch {
    return;
  }

  switch (message.type) {
    case "response": {
      if (message.id === undefined) {
        return;
      }
      const pending = pendingInvokes.get(message.id);
      if (!pending) {
        return;
      }
      pendingInvokes.delete(message.id);
      if (message.ok) {
        pending.resolve(message.value ?? null);
      } else {
        pending.reject(new Error(message.error ?? "invoke failed"));
      }
      return;
    }
    case "channel": {
      const callbackId = Number(message.channelId);
      if (!callbacks.has(callbackId)) {
        return;
      }
      const index = channelMessageIndex.get(callbackId) ?? 0;
      channelMessageIndex.set(callbackId, index + 1);
      runCallback(callbackId, { index, message: message.message });
      return;
    }
    case "event": {
      const listeners = eventListeners.get(message.event ?? "");
      if (!listeners) {
        return;
      }
      for (const listener of [...listeners]) {
        listener.handler({
          event: listener.event,
          id: listener.eventId,
          payload: message.payload,
        });
      }
      return;
    }
    default:
      return;
  }
}

function connect(onFirstOpen: () => void) {
  let opened = false;
  const ws = new WebSocket(socketUrl());
  socket = ws;

  ws.onopen = () => {
    opened = true;
    socketReady = true;
    setDisconnectedOverlay(false);
    flushQueue();
    onFirstOpen();
  };

  ws.onmessage = (event) => {
    if (typeof event.data === "string") {
      handleServerMessage(event.data);
    }
  };

  ws.onclose = () => {
    socketReady = false;
    socket = null;
    setDisconnectedOverlay(true);
    // Terminal subscriptions live on the dropped socket, so rather than trying
    // to re-attach every terminal in place, come back with a clean boot once
    // the app is reachable again. Scrollback is replayed on attach, and tab
    // state is restored from the shared snapshot, so little is lost.
    window.setTimeout(() => {
      if (opened) {
        window.location.reload();
      } else {
        connect(onFirstOpen);
      }
    }, RECONNECT_DELAY_MS);
  };

  ws.onerror = () => {
    // `onclose` always follows; the retry is handled there.
  };
}

// ---------------------------------------------------------------------------
// Disconnected overlay
// ---------------------------------------------------------------------------

const OVERLAY_ID = "dispatcher-web-disconnected";

function setDisconnectedOverlay(visible: boolean) {
  const existing = document.getElementById(OVERLAY_ID);
  if (!visible) {
    existing?.remove();
    return;
  }
  if (existing) {
    return;
  }

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.textContent = "Reconnecting to Dispatcher…";
  overlay.setAttribute(
    "style",
    [
      "position:fixed",
      "inset:0",
      "z-index:99999",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "background:rgba(0,0,0,0.72)",
      "color:#e6e6e6",
      "font:14px system-ui,-apple-system,sans-serif",
    ].join(";")
  );
  document.body?.appendChild(overlay);
}

// ---------------------------------------------------------------------------
// Locally handled commands
// ---------------------------------------------------------------------------

type LocalHandler = (args: Record<string, unknown>) => Promise<unknown>;

/**
 * Commands that must not go to the Dispatcher process because they mean
 * something different in a browser — the clipboard and the "open a link"
 * action belong to the machine sitting in front of the browser, not the one
 * running the terminals.
 */
const localCommands: Record<string, LocalHandler> = {
  "plugin:clipboard-manager|read_text": async () => {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return "";
    }
  },
  "plugin:clipboard-manager|write_text": async (args) => {
    const text = typeof args.text === "string" ? args.text : "";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // A browser can refuse clipboard access; copying silently fails.
    }
    return null;
  },
  "plugin:shell|open": async (args) => {
    const path = typeof args.path === "string" ? args.path : null;
    if (path) {
      window.open(path, "_blank", "noopener,noreferrer");
    }
    return null;
  },
  "plugin:event|listen": async (args) => {
    const event = String(args.event ?? "");
    const callbackId = Number(args.handler);
    if (!callbacks.has(callbackId)) {
      return 0;
    }

    const eventId = nextEventId++;
    const listeners = eventListeners.get(event) ?? [];
    listeners.push({
      eventId,
      event,
      handler: (payload) => runCallback(callbackId, payload),
    });
    eventListeners.set(event, listeners);
    return eventId;
  },
  // The macOS font panel belongs to the desktop window; there is nothing to
  // show over here, and resolving quietly keeps the shared UI check-free.
  show_font_panel: async () => null,
  hide_font_panel: async () => null,
  "plugin:event|unlisten": async (args) => {
    const event = String(args.event ?? "");
    const eventId = Number(args.eventId);
    const listeners = eventListeners.get(event);
    if (listeners) {
      eventListeners.set(
        event,
        listeners.filter((listener) => listener.eventId !== eventId)
      );
    }
    return null;
  },
};

/**
 * Window-management commands have no browser equivalent (there is no native
 * window to theme, focus or bounce in the dock). Resolving them quietly keeps
 * the shared UI code free of runtime checks.
 */
function isNoOpCommand(cmd: string): boolean {
  return (
    cmd.startsWith("plugin:window|")
    || cmd.startsWith("plugin:webview|")
    || cmd.startsWith("plugin:event|emit")
  );
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

function invokeOverSocket(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  const id = nextInvokeId++;
  return new Promise((resolve, reject) => {
    pendingInvokes.set(id, { resolve, reject });
    send({ type: "invoke", id, cmd, args });
  });
}

function installInternals() {
  const internals = {
    invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
      const payload = args ?? {};
      const local = localCommands[cmd];
      if (local) {
        return local(payload);
      }
      if (isNoOpCommand(cmd)) {
        return Promise.resolve(null);
      }
      return invokeOverSocket(cmd, payload);
    },

    transformCallback(callback: Callback, once = false): number {
      const id = nextCallbackId++;
      callbacks.set(id, { fn: callback, once });
      return id;
    },

    unregisterCallback(id: number) {
      callbacks.delete(id);
      channelMessageIndex.delete(id);
    },

    convertFileSrc(filePath: string): string {
      return filePath;
    },

    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
    },

    plugins: {},
  };

  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = internals;
  (window as unknown as Record<string, unknown>).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener(event: string, eventId: number) {
      const listeners = eventListeners.get(event);
      if (listeners) {
        eventListeners.set(
          event,
          listeners.filter((listener) => listener.eventId !== eventId)
        );
      }
    },
  };
}

/**
 * Sets up browser IPC when needed. Resolves once the app can safely issue
 * commands: immediately inside Tauri, and after the socket is up in a browser.
 */
export function initWebBridge(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.resolve();
  }

  if ("__TAURI_INTERNALS__" in window) {
    // Native window: Tauri already installed the real IPC.
    return Promise.resolve();
  }

  webClient = true;
  installInternals();

  return new Promise((resolve) => {
    let settled = false;
    connect(() => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
  });
}
