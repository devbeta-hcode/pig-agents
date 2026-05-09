import React from "react";
import ReactDOM from "react-dom/client";
import "antd/dist/reset.css";
import App from "./App";
import { DialogProvider } from "./components/DialogProvider";
import "./styles/variables.css";
import "./styles/layout.css";
import "./styles/file-tree.css";
import "./styles/modal.css";
import "./styles/editor.css";
import "./styles/terminal.css";
import "./styles/diff.css";
import "./styles/chat.css";
import "./styles/composer.css";
import "./styles/chats-list.css";
import "./styles/tool-output.css";
import "./styles/workspace-manager.css";
import "./styles/overrides.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
    <DialogProvider>
      <App />
    </DialogProvider>
);
