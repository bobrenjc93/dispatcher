import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

document.title = "DevDispatcher";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
