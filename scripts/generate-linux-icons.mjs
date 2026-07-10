#!/usr/bin/env node
/**
 * Build hicolor PNGs (16–512) from app/electron/resources/icon.png for Linux menus.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "app/electron/resources/icon.png");
const outDir = path.join(root, "app/electron/resources/icons");

const py = `
from PIL import Image
import os
src = Image.open(${JSON.stringify(src)}).convert("RGBA")
out = ${JSON.stringify(outDir)}
os.makedirs(out, exist_ok=True)
for size in (16, 24, 32, 48, 64, 128, 256, 512):
    img = src.resize((size, size), Image.Resampling.LANCZOS)
    img.save(os.path.join(out, f"{size}x{size}.png"))
print(f"[generate-linux-icons] wrote icons to {out}")
`;

if (!fs.existsSync(src)) {
  console.error(`[generate-linux-icons] missing ${src}`);
  process.exit(1);
}

const r = spawnSync("python3", ["-c", py], { stdio: "inherit" });
if (r.status !== 0) {
  console.error("[generate-linux-icons] FAILED — install python3-pil (Pillow)");
  process.exit(r.status ?? 1);
}
