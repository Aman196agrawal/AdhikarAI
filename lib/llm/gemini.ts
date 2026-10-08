/**
 * The Gemini provider.
 *
 * Uses constrained decoding: the Zod schema for each task is converted to JSON
 * Schema and handed to the model as `responseJsonSchema`, then the response is
 * validated against the same Zod schema. One source of truth for the shape,
 * and a validation failure cannot slip through as a "close enough" object.
 *
 * Temperature defaults to 0. Extraction and interpretation in a benefits
 * system should give the same answer twice.
 */

import { GoogleGenAI } from "@google/genai";
import * as z from "zod";

import { log } from "@/lib/log";
import {
  generateValidated,
  toModelSchema,
  type LlmOutcome,
  type LlmProvider,
  type LlmRequest,
} from "./provider";

/**
 * Model choice: Flash is the right default here. Every task is extraction,
 * classification or short explanation over text we supply, none of it
 * demanding deep reasoning, and the cost difference matters for a free-tier
 * deployment.
 */
const DEFAULT_MODEL = "gemini-2.5-flash";

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function createGeminiProvider(options?: {
  apiKey?: string;
  model?: string;
}): LlmProvider {
  const apiKey = options?.apiKey ?? process.env.GEMINI_API_KEY ?? "";
  const model = options?.model ?? process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
  const isConfigured = apiKey.trim() !== "";

  const client = isConfigured ? new GoogleGenAI({ apiKey }) : null;

  return {
    name: "gemini",
    isConfigured,

    async complete<T>(request: LlmRequest<T>): Promise<LlmOutcome<T>> {
      if (!client) {
        return {
          ok: false,
          reason: "NOT_CONFIGURED",
          message:
            "GEMINI_API_KEY is not set. Set LLM_PROVIDER=stub to run without a key.",
          provider: "gemini",
          attempts: 0,
        };
      }

      // performance.now() is a monotonic clock, which is what a duration
      // measurement wants. It is also not a read of "now" in the benefit
      // sense, so it stays clear of the simulated clock entirely.
      const startedAt = performance.now();
      const responseJsonSchema = toModelSchema(
        request.schema as z.ZodType<unknown>,
        z,
      );

      const outcome = await generateValidated(request, "gemini", async (correction) => {
        // Document bytes travel inline and are never written anywhere. The
        // caller is responsible for dropping the buffer afterwards.
        const parts: Array<Record<string, unknown>> = [];

        if (request.document) {
          parts.push({
            inlineData: {
              mimeType: request.document.mimeType,
              data: toBase64(request.document.bytes),
            },
          });
        }

        parts.push({
          text: correction
            ? `${request.prompt}\n\n---\n${correction}`
            : request.prompt,
        });

        const response = await client.models.generateContent({
          model,
          contents: [{ role: "user", parts }],
          config: {
            systemInstruction: request.system,
            temperature: request.temperature ?? 0,
            responseMimeType: "application/json",
            responseJsonSchema,
          },
        });

        return response.text;
      });

      log.info("llm.complete", {
        task: request.task,
        provider: "gemini",
        model,
        ok: outcome.ok,
        attempts: outcome.attempts,
        durationMs: Math.round(performance.now() - startedAt),
        hasDocument: request.document !== undefined,
        ...(outcome.ok ? {} : { reason: outcome.reason }),
      });

      return outcome;
    },
  };
}
