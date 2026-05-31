#!/usr/bin/env node
/**
 * Pre-install guard: fail if package.json references packages not listed in docs/DEPENDENCIES.md.
 * Run: node scripts/verify-deps.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowDoc = fs.readFileSync(path.join(root, "docs/DEPENDENCIES.md"), "utf8");

const banned = ["express", "cors", "ws", "playwright", "puppeteer"];
const workspaces = ["app/core", "app/electron", "app/renderer"];

function depsInPkg(pkgPath) {
  const j = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  return [
    ...Object.keys(j.dependencies ?? {}),
    ...Object.keys(j.optionalDependencies ?? {}),
    ...Object.keys(j.devDependencies ?? {}),
  ];
}

let failed = false;
for (const ws of workspaces) {
  const pkg = path.join(root, ws, "package.json");
  if (!fs.existsSync(pkg)) continue;
  for (const name of depsInPkg(pkg)) {
    if (banned.includes(name)) {
      console.error(`[verify-deps] BANNED package "${name}" in ${ws}/package.json`);
      failed = true;
      continue;
    }
    if (!allowDoc.includes(`"${name}"`) && !allowDoc.includes(`| \`${name}\` `) && !allowDoc.includes(`| ${name} `)) {
      console.warn(`[verify-deps] WARN: "${name}" in ${ws} — add to docs/DEPENDENCIES.md if intentional`);
    }
  }
}

if (failed) process.exit(1);
console.log("[verify-deps] No banned packages found.");
