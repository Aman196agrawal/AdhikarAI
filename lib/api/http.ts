/**
 * Shared HTTP helpers for route handlers.
 *
 * Every response goes through here so that error shapes are consistent and,
 * more importantly, so that an unexpected failure cannot leak a stack trace or
 * a database error string to the client. Those go to the redacting log; the
 * caller gets a code and a safe message.
 */

import * as z from "zod";

import { log } from "@/lib/log";

export type ApiErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNPROCESSABLE"
  | "NEEDS_HUMAN_REVIEW"
  | "INTERNAL";

const STATUS: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  NEEDS_HUMAN_REVIEW: 422,
  INTERNAL: 500,
};

/** A failure a route handler raises deliberately. */
export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function ok<T>(data: T, init?: ResponseInit): Response {
  return Response.json({ ok: true, data }, { status: 200, ...init });
}

export function fail(
  code: ApiErrorCode,
  message: string,
  details?: unknown,
): Response {
  return Response.json(
    { ok: false, error: { code, message, ...(details ? { details } : {}) } },
    { status: STATUS[code] },
  );
}

/** Parse and validate a JSON body, raising ApiError on a bad shape. */
export async function parseBody<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ApiError("BAD_REQUEST", "Request body must be valid JSON.");
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ApiError(
      "BAD_REQUEST",
      "Request body did not match the expected shape.",
      result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

/** Validate query parameters from a URL. */
export function parseQuery<T>(request: Request, schema: z.ZodType<T>): T {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const result = schema.safeParse(params);
  if (!result.success) {
    throw new ApiError(
      "BAD_REQUEST",
      "Query parameters did not match the expected shape.",
      result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

/**
 * Wrap a handler so thrown errors become safe responses.
 *
 * An unexpected error is logged (through the redacting logger) and returned as
 * a bare INTERNAL. A Prisma error message can contain column values, so it
 * must never reach the client.
 */
export function handler(
  route: string,
  fn: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    try {
      return await fn(request);
    } catch (error) {
      if (error instanceof ApiError) {
        log.warn("api.error", {
          route,
          code: error.code,
          message: error.message,
        });
        return fail(error.code, error.message, error.details);
      }

      log.error("api.unhandled", {
        route,
        error: error instanceof Error ? error : String(error),
      });
      return fail(
        "INTERNAL",
        "Something went wrong handling this request. The problem has been logged.",
      );
    }
  };
}

export { z };
