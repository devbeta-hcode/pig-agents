/**
 * Dev launcher — starts Vite renderer, waits until it responds, then Electron.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const VITE_URL = "http://127.0.0.1:5190";
const VITE_WAIT_MS = 60_000;

function waitForVite(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve();
        else if (Date.now() > deadline) reject(new Error(`Vite returned ${res.statusCode}`));
        else setTimeout(tick, 400);
      });
      req.on("error", () => {
        if (Date.now() > deadline) reject(new Error(`Vite not ready at ${url} after ${timeoutMs}ms`));
        else setTimeout(tick, 400);
      });
      req.setTimeout(2000, () => {
        req.destroy();
        if (Date.now() > deadline) reject(new Error("Vite request timeout"));
        else setTimeout(tick, 400);
      });
    };
    tick();
  });
}

console.log("[dev] Building electron main + preload…");
await new Promise((resolve, reject) => {
  const b = spawn(npmCmd, ["run", "build", "--workspace", "@pig-agents/electron"], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  b.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`build exit ${c}`))));
});

const devEnv = { ...process.env, PIG_DEV: "1" };

const renderer = spawn(npmCmd, ["run", "dev", "--workspace", "@pig-agents/renderer"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: devEnv,
});

console.log(`[dev] Waiting for Vite at ${VITE_URL}…`);
try {
  await waitForVite(VITE_URL, VITE_WAIT_MS);
  console.log("[dev] Vite is up — starting Electron");
} catch (err) {
  console.error("[dev]", err.message);
  renderer.kill();
  process.exit(1);
}

const electron = spawn(npmCmd, ["run", "start", "--workspace", "@pig-agents/electron"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: devEnv,
});

function shutdown() {
  renderer.kill();
  electron.kill();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
