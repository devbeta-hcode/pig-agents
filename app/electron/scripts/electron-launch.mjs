/**
 * Launch Electron with Linux sandbox disabled when chrome-sandbox lacks setuid.
 * Must pass --no-sandbox before the native process starts (main.ts is too late).
 */
import { spawn } from "node:child_process";
import electron from "electron";

const args = process.platform === "linux" ? ["--no-sandbox", "."] : ["."];

const child = spawn(electron, args, {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
