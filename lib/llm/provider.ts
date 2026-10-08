/**
 * The LLM provider interface.
 *
 * One narrow seam between this product and any language model. Everything the
 * system asks of a model goes through `complete`, which always returns a
 * schema-validated value or an explicit failure - never a half-parsed guess.
 *
 * Three rules this interface exists to enforce:
 *
 *   1. A failure is a value, not an exception to swallow. Callers must handle
 *      it, and the normal handling is to record NEEDS_HUMAN_REVIEW rather than
 *      to proceed on a default (spec section 39).
 *   2. Output is validated against a Zod schema before any caller sees it. The
 *      same schema drives the model's constrained decoding, so there is one
 *      source of truth for the shape.
 *   3. Nothing here decides anything. The model extracts, interprets and
 *      explains; the engine decides. A provider cannot return a verdict, an
 *      amount or a state transition that the engine did not compute.
 */

import type * as z from "zod";

/** A document passed to the model for extraction. Bytes are never persisted. */
export interface DocumentInput {
  bytes: Uint8Array;
  mimeType: string;
}

export interface LlmRequest<T> {
  /**
   * Stable task identifier, e.g. "profile.extract". Used for logging and to
   * select a deterministic fixture in the stub provider.
   */
  task: string;
  /** Role and constraints. Grounding rules belong here. */
  system?: string;
  prompt: string;
  schema: z.ZodType<T>;
  /** Defaults to 0 - extraction and interpretation should be reproducible. */
  temperature?: number;
  document?: DocumentInput;
  /** Total attempts including the first. Defaults to 2. */
  maxAttempts?: number;
}

export type LlmFailureReason =
  /** No API key, or the provider is unavailable by configuration. */
  | "NOT_CONFIGURED"
  /** Network or API error. */
  | "TRANSPORT"
  /** The model returned nothing usable. */
  | "EMPTY_RESPONSE"
  /** The response was not valid JSON. */
  | "MALFORMED_JSON"
  /** Valid JSON that did not satisfy the schema. */
  | "SCHEMA_VALIDATION"
  /** The model declined, or no fixture exists for this task in the stub. */
  | "UNSUPPORTED_TASK";

export type LlmOutcome<T> =
  | { ok: true; value: T; provider: string; attempts: number }
  | {
      ok: false;
      reason: LlmFailureReason;
      message: string;
      provider: string;
      attempts: number;
    };

export interface LlmProvider {
  readonly name: string;
  readonly isConfigured: boolean;
  complete<T>(request: LlmRequest<T>): Promise<LlmOutcome<T>>;
}

// ---------------------------------------------------------------------------
// Shared parsing and validation
// ---------------------------------------------------------------------------

/**
 * Pull a JSON object out of a model response.
 *
 * Even with a response schema set, models occasionally wrap JSON in a fenced
 * code block or add a sentence before it. This recovers the object rather than
 * failing the whole call, but does not attempt to repair malformed JSON:
 * guessing at a broken payload is how a wrong amount gets through.
 */
export function extractJson(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = (fenced?.[1] ?? trimmed).trim();

  if (candidate.startsWith("{") || candidate.startsWith("[")) return candidate;

  // Fall back to the outermost brace pair.
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start !== -1 && end > start) return candidate.slice(start, end + 1);

  return null;
}

/**
 * Convert a Zod schema to a JSON Schema the model can be constrained by.
 *
 * `$schema` is stripped because the Gemini API rejects it, and the numeric
 * bounds Zod emits for plain integers are removed as they add noise without
 * constraining anything useful.
 */
export function toModelSchema(schema: z.ZodType<unknown>, zod: typeof z): unknown {
  const json = zod.toJSONSchema(schema, { io: "output" }) as Record<string, unknown>;
  return stripNoise(json);
}

function stripNoise(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripNoise);
  if (node === null || typeof node !== "object") return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "$schema" || key === "additionalProperties") continue;
    if (
      (key === "minimum" || key === "maximum") &&
      typeof value === "number" &&
      Math.abs(value) >= Number.MAX_SAFE_INTEGER
    ) {
      continue;
    }
    out[key] = stripNoise(value);
  }
  return out;
}

/** A single generation attempt, supplied by a concrete provider. */
export type Generate = (correction: string | null) => Promise<string | undefined>;

/**
 * Run a generation with validation and one corrective retry.
 *
 * On a schema failure the error text is fed back to the model, which recovers
 * most structural mistakes. After the attempt budget is spent the call fails
 * explicitly; it never returns a partially valid object.
 */
export async function generateValidated<T>(
  request: LlmRequest<T>,
  providerName: string,
  generate: Generate,
): Promise<LlmOutcome<T>> {
  const maxAttempts = request.maxAttempts ?? 2;
  let correction: string | null = null;
  let lastReason: LlmFailureReason = "EMPTY_RESPONSE";
  let lastMessage = "No attempt was made.";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let raw: string | undefined;

    try {
      raw = await generate(correction);
    } catch (error) {
      lastReason = "TRANSPORT";
      lastMessage = error instanceof Error ? error.message : String(error);
      // A transport error will not be fixed by rephrasing, so stop.
      return {
        ok: false,
        reason: lastReason,
        message: lastMessage,
        provider: providerName,
        attempts: attempt,
      };
    }

    if (!raw || raw.trim() === "") {
      lastReason = "EMPTY_RESPONSE";
      lastMessage = "The model returned an empty response.";
      correction = "Your previous response was empty. Return only a JSON object.";
      continue;
    }

    const json = extractJson(raw);
    if (json === null) {
      lastReason = "MALFORMED_JSON";
      lastMessage = "The response contained no JSON object.";
      correction =
        "Your previous response contained no JSON object. Return only a single JSON object, with no prose and no code fence.";
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (error) {
      lastReason = "MALFORMED_JSON";
      lastMessage = error instanceof Error ? error.message : "Invalid JSON.";
      correction = `Your previous response was not valid JSON (${lastMessage}). Return only a single valid JSON object.`;
      continue;
    }

    const result = request.schema.safeParse(parsed);
    if (result.success) {
      return {
        ok: true,
        value: result.data,
        provider: providerName,
        attempts: attempt,
      };
    }

    lastReason = "SCHEMA_VALIDATION";
    lastMessage = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    correction = `Your previous response did not match the required schema. Fix these problems and return only JSON: ${lastMessage}`;
  }

  return {
    ok: false,
    reason: lastReason,
    message: lastMessage,
    provider: providerName,
    attempts: maxAttempts,
  };
}
