import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { DialogProvider } from "./components/DialogProvider";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
    <DialogProvider>
      <App />
    </DialogProvider>
);
