type Level = "info" | "warn" | "error" | "debug";

function ts() {
  return new Date().toISOString();
}

function fmt(level: Level, args: unknown[]) {
  return [`[${ts()}] [${level.toUpperCase()}]`, ...args];
}

export const logger = {
  info: (...a: unknown[]) => console.log(...fmt("info", a)),
  warn: (...a: unknown[]) => console.warn(...fmt("warn", a)),
  error: (...a: unknown[]) => console.error(...fmt("error", a)),
  debug: (...a: unknown[]) => {
    if (process.env.DEBUG) console.log(...fmt("debug", a));
  },
};
