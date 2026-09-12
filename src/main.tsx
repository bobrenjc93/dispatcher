import React from "react";
import ReactDOM from "react-dom/client";
import { debugLog } from "./lib/debugLog";
import { initWebBridge, isWebClient, onBridgeReattach } from "./lib/webBridge";
import { startRendererHeartbeat } from "./lib/rendererHeartbeat";
import App from "./App";

document.title = "Dispatcher";

class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    debugLog("app.runtime", "react render error", {
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
    });
  }

  render() {
    if (this.state.error) {
      return (
        <div className="empty-view">
          <p>Dispatcher failed to render. Check the Dispatcher diagnostic log.</p>
        </div>
      );
    }

    return this.props.children;
  }
}

// In a browser there is no Tauri IPC until the bridge installs it, and the
// first thing the app does is issue commands. Rendering before that leaves
// every Tauri call reading an undefined `__TAURI_INTERNALS__`, and leaves
// `isWebClient()` false so the page does not even know it is a replica.
// Resolves immediately inside Tauri.
const hadTauriInternalsAtBoot =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

void initWebBridge().then(() => {
  debugLog("app.runtime", "bridge bootstrap", {
    hadTauriInternalsAtBoot,
    isWebClient: isWebClient(),
    href: window.location.href,
  });
  debugLog("app.runtime", "render root start", {
    href: window.location.href,
  });
  startRendererHeartbeat();

  const root = ReactDOM.createRoot(document.getElementById("root")!);
  // Bumped to rebuild the tree from scratch. A replica's terminal output
  // channels belong to the socket that created them, so a reconnect has to
  // make them again — and mounting is what makes them. The alternative was
  // reloading the page, which on a phone meant fetching and parsing
  // everything a second time before any of this ran.
  let generation = 0;
  const draw = () => {
    root.render(
      <React.StrictMode>
        <RootErrorBoundary>
          <App key={generation} />
        </RootErrorBoundary>
      </React.StrictMode>
    );
  };

  onBridgeReattach(() => {
    generation += 1;
    debugLog("app.runtime", "rebuilding on a new connection", { generation });
    draw();
  });

  draw();
});
