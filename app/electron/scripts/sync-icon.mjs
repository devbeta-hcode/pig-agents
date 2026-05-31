/**
 * Copy project root icon.png into electron + renderer asset paths.
 * Usage: node scripts/sync-icon.mjs  (from app/electron)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const rootIcon = path.join(here, "../../../icon.png");
const targets = [
  path.join(here, "../resources/icon.png"),
  path.join(here, "../../renderer/public/icon.png"),
];

if (!fs.existsSync(rootIcon)) {
  console.error("Missing", rootIcon);
  process.exit(1);
}

for (const dest of targets) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(rootIcon, dest);
  console.log("Copied →", dest);
}
