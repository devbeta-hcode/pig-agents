import { Router } from "express";
import fs from "node:fs/promises";
import fssync from "node:fs";
import os from "node:os";
import path from "node:path";
import { safeJoin } from "../utils/workspace.js";

export const fsRouter = Router();

interface BrowseEntry {
  name: string;
  path: string;
  isDir: boolean;
}

fsRouter.get("/fs/home", (_req, res) => {
  const home = os.homedir();
  const roots: { label: string; path: string }[] = [
    { label: "Home", path: home },
    { label: "Root", path: "/" },
  ];
  // common dev locations
  for (const sub of ["projects", "code", "workspace", "Documents", "Desktop"]) {
    const p = path.join(home, sub);
    if (fssync.existsSync(p)) roots.push({ label: sub, path: p });
  }
  res.json({ home, roots });
});

fsRouter.get("/fs/browse", async (req, res) => {
  try {
    const target = String(req.query.path || os.homedir());
    const showHidden = req.query.hidden === "1";
    const abs = path.resolve(target);
    const stat = await fs.stat(abs);
    if (!stat.isDirectory()) return res.status(400).json({ error: "Not a directory" });

    const dirents = await fs.readdir(abs, { withFileTypes: true });
    const entries: BrowseEntry[] = [];
    for (const d of dirents) {
      if (!showHidden && d.name.startsWith(".")) continue;
      let isDir = d.isDirectory();
      if (d.isSymbolicLink()) {
        try {
          const st = await fs.stat(path.join(abs, d.name));
          isDir = st.isDirectory();
        } catch { continue; }
      }
      entries.push({ name: d.name, path: path.join(abs, d.name), isDir });
    }
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const parent = path.dirname(abs);
    const crumbs: { label: string; path: string }[] = [];
    let cur = abs;
    while (true) {
      const parentDir = path.dirname(cur);
      crumbs.unshift({ label: path.basename(cur) || cur, path: cur });
      if (parentDir === cur) break;
      cur = parentDir;
    }

    res.json({
      path: abs,
      parent: parent === abs ? null : parent,
      entries,
      crumbs,
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

fsRouter.post("/fs/rename", async (req, res) => {
  try {
    const from = String(req.body?.from || "");
    const to = String(req.body?.to || "");
    if (!from || !to) return res.status(400).json({ error: "from and to required" });
    const fromAbs = safeJoin(from);
    const toAbs = safeJoin(to);
    await fs.mkdir(path.dirname(toAbs), { recursive: true });
    await fs.rename(fromAbs, toAbs);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
