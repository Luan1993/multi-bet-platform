/** Logger estruturado e enxuto (sem dependência externa). */
type Level = "info" | "warn" | "error" | "debug";

function log(level: Level, msg: string, extra?: Record<string, unknown>): void {
  if (level === "debug" && process.env.NODE_ENV === "production") return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...extra,
  };
  const out = JSON.stringify(line);
  if (level === "error") console.error(out);
  else if (level === "warn") console.warn(out);
  else console.log(out);
}

export const logger = {
  info: (msg: string, extra?: Record<string, unknown>) => log("info", msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => log("warn", msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => log("error", msg, extra),
  debug: (msg: string, extra?: Record<string, unknown>) => log("debug", msg, extra),
};
