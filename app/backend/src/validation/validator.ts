import { runCommand, type CommandResult } from "../tools/command.js";
import { safeJoin } from "../utils/workspace.js";
import fs from "node:fs/promises";
import path from "node:path";

export interface ValidationReport {
  ran: { name: string; result: CommandResult }[];
  ok: boolean;
}

async function exists(rel: string): Promise<boolean> {
  try {
    await fs.access(safeJoin(rel));
    return true;
  } catch { return false; }
}

async function readJSON(rel: string): Promise<any | null> {
  try {
    const txt = await fs.readFile(safeJoin(rel), "utf8");
    return JSON.parse(txt);
  } catch { return null; }
}

export async function autoValidate(): Promise<ValidationReport> {
  const ran: { name: string; result: CommandResult }[] = [];
  let ok = true;

  if (await exists("package.json")) {
    const pkg = await readJSON("package.json");
    const scripts = pkg?.scripts ?? {};
    const candidates: string[] = [];
    if (scripts.typecheck) candidates.push("typecheck");
    if (scripts.lint) candidates.push("lint");
    if (scripts.test) candidates.push("test -- --run --silent");
    if (scripts.build) candidates.push("build");
    for (const s of candidates) {
      const cmd = `npm run -s ${s}`;
      const result = await runCommand(cmd, { timeoutMs: 120_000 });
      ran.push({ name: cmd, result });
      if (result.exitCode !== 0) ok = false;
    }
  }

  if (await exists("pyproject.toml") || await exists("requirements.txt")) {
    const result = await runCommand("python -c 'print(1)'", { timeoutMs: 30_000 });
    ran.push({ name: "python smoke", result });
    if (result.exitCode !== 0) ok = false;
  }

  return { ran, ok };
}

export function summarizeValidation(rep: ValidationReport): string {
  if (rep.ran.length === 0) return "No validation steps detected.";
  const lines = rep.ran.map((r) => `- ${r.name}: ${r.result.exitCode === 0 ? "OK" : `FAIL(${r.result.exitCode})`}`);
  return [`Validation: ${rep.ok ? "OK" : "FAIL"}`, ...lines].join("\n");
}
