import React from "react";
import ReactDOM from "react-dom/client";
import { debugLog } from "./lib/debugLog";
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

debugLog("app.runtime", "render root start", {
  href: window.location.href,
});
startRendererHeartbeat();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>
);
