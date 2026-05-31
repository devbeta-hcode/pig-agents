#!/usr/bin/env node
/** Quick node-pty smoke test (Node ABI). Run: node scripts/test-pty.mjs */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"));
const pty = require("node-pty");
const shell = process.platform === "win32" ? (process.env.COMSPEC || "powershell.exe") : (process.env.SHELL || "bash");
const term = pty.spawn(shell, [], { name: "xterm-color", cols: 80, rows: 24, cwd: process.cwd() });
let buf = "";
term.onData((d) => { buf += d; });
term.write("echo PTY_OK\r\n");
setTimeout(() => {
  const ok = buf.includes("PTY_OK");
  console.log(ok ? "PASS: node-pty works" : "FAIL: no output", buf.slice(0, 120));
  try { term.kill(); } catch { /* noop */ }
  process.exit(ok ? 0 : 1);
}, 2000);
