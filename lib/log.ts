/**
 * Logging with redaction.
 *
 * Observability is required (spec section 38) and so is never writing citizen
 * data to a log (sections 30 and 48). Those pull against each other, so all
 * logging goes through here rather than through bare `console` calls.
 *
 * What must never be logged: document bytes, extracted bank transactions,
 * full Aadhaar or account numbers, API keys, or raw model prompts containing
 * citizen details. What is useful and safe: task names, durations, outcome
 * codes, record ids, and counts.
 */

/** Keys whose values are replaced wholesale, however deeply nested. */
const REDACTED_KEYS = new Set([
  "aadhaar",
  "aadhaarnumber",
  "accountnumber",
  "bankaccountnumber",
  "ifsc",
  "ifsccode",
  "apikey",
  "geminiapikey",
  "authorization",
  "cronsecret",
  "password",
  "token",
  "document",
  "documentbytes",
  "buffer",
  "data",
  "statement",
  "transactions",
  "rawintake",
  "prompt",
  "contents",
]);

/** Patterns redacted inside any string value. */
const PATTERNS: Array<[RegExp, string]> = [
  // A 12-digit Aadhaar, with or without grouping.
  [/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, "[aadhaar-redacted]"],
  // Bank account numbers: 9-18 consecutive digits.
  [/\b\d{9,18}\b/g, "[account-redacted]"],
  // IFSC codes.
  [/\b[A-Z]{4}0[A-Z0-9]{6}\b/g, "[ifsc-redacted]"],
  // Anything that looks like a bearer token or key.
  [/\b(?:AIza|sk-|Bearer\s+)[A-Za-z0-9_\-.]{8,}/g, "[secret-redacted]"],
];

const MAX_STRING = 300;

function redactString(value: string): string {
  let out = value;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}...[truncated]` : out;
}

/**
 * Recursively redact a value for logging.
 *
 * Exported so tests can assert that sensitive shapes do not survive it.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]";

  if (value === null || value === undefined) return value;

  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();

  // Never log binary payloads. Report only that one was present, and its size.
  if (
    value instanceof Uint8Array ||
    (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer)
  ) {
    const size = value instanceof Uint8Array ? value.byteLength : value.byteLength;
    return `[binary ${size} bytes omitted]`;
  }

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }

  if (Array.isArray(value)) {
    const head = value.slice(0, 20).map((v) => redact(v, depth + 1));
    return value.length > 20 ? [...head, `[+${value.length - 20} more]`] : head;
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACTED_KEYS.has(key.toLowerCase())
        ? "[redacted]"
        : redact(inner, depth + 1);
    }
    return out;
  }

  return "[unloggable]";
}

export type LogLevel = "debug" | "info" | "warn" | "error";

function emit(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
  const payload = {
    level,
    event,
    ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
  };

  const line = JSON.stringify(payload);

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else if (level === "debug") {
    if (process.env.NODE_ENV === "development") console.debug(line);
  } else console.log(line);
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => emit("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
};
