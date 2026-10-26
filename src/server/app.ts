import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import { getConnInfo } from "@hono/node-server/conninfo";
import { z } from "zod";
import { ROOT, settings } from "../config.js";
import { ask, type PipelineDeps } from "../answer/pipeline.js";
import { PROMPT_VERSION } from "../answer/prompt.js";
import type { AskResult } from "../types.js";
import { DailyCap, RateLimiter, Semaphore, TraceStore } from "./limits.js";
import { log } from "./logger.js";
import { redact } from "./redact.js";
import { score } from "../observability/tracing.js";

const AskBody = z.object({
  question: z.string().trim().min(1, "question is required").max(settings.maxQuestionChars),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(settings.maxHistoryChars) }))
    .max(settings.maxHistoryTurns * 2)
    .optional(),
});

const FeedbackBody = z.object({
  traceId: z.string().uuid(),
  rating: z.enum(["up", "down"]),
  comment: z.string().max(500).optional(),
});

export interface AppOptions {
  deps: PipelineDeps;
  trustProxy: boolean;
  ratePerMinute: number;
  dailyCap: number;
  maxConcurrent?: number;
  docs: number;
  serveWeb?: boolean;
}

interface TraceRecord {
  question: string;
  answer: string;
  answerable: boolean;
  sources: string[];
  promptVersion: string;
  langfuseTraceId?: string;
}

export function createApp(opts: AppOptions) {
  const app = new Hono();
  const perIp = new RateLimiter(opts.ratePerMinute, 60_000);
  const feedbackPerIp = new RateLimiter(30, 60_000);
  const daily = new DailyCap(opts.dailyCap);
  const inflight = new Semaphore(opts.maxConcurrent ?? 20);
  const traces = new TraceStore<TraceRecord>();

  // the client ip, for rate limiting only (never logged).
  // behind one trusted proxy the real ip is the last x-forwarded-for entry,
  // because the proxy appends it; earlier entries are client-controlled.
  const clientIp = (c: Context): string => {
    if (opts.trustProxy) {
      const xff = c.req.header("x-forwarded-for");
      const last = xff?.split(",").pop()?.trim();
      if (last) return last;
    }
    try {
      return getConnInfo(c).remote.address ?? "unknown";
    } catch {
      return "unknown";
    }
  };

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        styleSrcAttr: ["'unsafe-inline'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
      strictTransportSecurity: "max-age=63072000; includeSubDomains",
      referrerPolicy: "strict-origin-when-cross-origin",
      permissionsPolicy: { camera: [], microphone: [], geolocation: [] },
    }),
  );

  // api responses are never cached by browsers or intermediaries
  app.use("/ask/*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  const limitBody = bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => c.json({ error: "payload_too_large", message: "Request body is too large." }, 413),
  });

  // json only: a cross-site form cannot send application/json without a cors
  // preflight, and we send no cors headers, so other origins are blocked
  const requireJson = async (c: Context, next: () => Promise<void>) => {
    if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
      return c.json({ error: "unsupported_media_type", message: "Send JSON." }, 415);
    }
    await next();
  };

  // shared validation and limits for both ask endpoints
  async function admit(c: Context): Promise<{ body: z.infer<typeof AskBody> } | Response> {
    const wait = perIp.check(clientIp(c));
    if (wait > 0) {
      c.header("Retry-After", String(wait));
      return c.json({ error: "rate_limited", message: `Too many questions. Try again in ${wait}s.` }, 429);
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json", message: "Body must be valid JSON." }, 400);
    }
    const parsed = AskBody.safeParse(raw);
    if (!parsed.success) {
      const msg = parsed.error.issues[0]?.message ?? "Invalid request.";
      return c.json({ error: "invalid_request", message: msg }, 400);
    }
    if (!daily.take()) {
      return c.json({ error: "daily_limit", message: "The demo has reached today's question limit. Please try tomorrow." }, 429);
    }
    if (!inflight.tryAcquire()) {
      return c.json({ error: "busy", message: "Lots of questions right now. Please try again in a moment." }, 503);
    }
    return { body: parsed.data };
  }

  function record(result: AskResult, question: string) {
    traces.set(result.meta.traceId, {
      question: redact(question),
      answer: redact(result.answer),
      answerable: result.answerable,
      sources: result.sources.map((s) => s.chunkId),
      promptVersion: result.meta.promptVersion,
      langfuseTraceId: result.meta.langfuseTraceId,
    });
    log("info", "ask", {
      traceId: result.meta.traceId,
      answerable: result.answerable,
      declineReason: result.declineReason,
      sources: result.sources.map((s) => s.chunkId),
      latencyMs: result.meta.latencyMs,
      tokens: result.meta.tokens,
      costUsd: result.meta.costUsd,
      droppedCitations: result.meta.droppedCitations,
      // the question is redacted and truncated before logging
      question: redact(question).slice(0, 200),
    });
  }

  app.get("/health", (c) =>
    c.json({ ok: true, docs: opts.docs, chunks: opts.deps.retriever.chunks.length, model: opts.deps.chat.model, promptVersion: PROMPT_VERSION }),
  );

  // the endpoint from the brief: plain json in, { answer, sources } out
  app.post("/ask", limitBody, requireJson, async (c) => {
    const admitted = await admit(c);
    if (admitted instanceof Response) return admitted;
    try {
      const result = await ask(admitted.body.question, opts.deps, { history: admitted.body.history });
      record(result, admitted.body.question);
      return c.json(result);
    } finally {
      inflight.release();
    }
  });

  // same pipeline, streamed as server-sent events for the ui
  app.post("/ask/stream", limitBody, requireJson, async (c) => {
    const admitted = await admit(c);
    if (admitted instanceof Response) return admitted;
    const controller = new AbortController();
    const traceId = crypto.randomUUID();
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => controller.abort());
      try {
        const result = await ask(admitted.body.question, opts.deps, {
          history: admitted.body.history,
          signal: controller.signal,
          traceId,
          onDelta: (text) => void stream.writeSSE({ event: "delta", data: JSON.stringify({ text }) }),
        });
        record(result, admitted.body.question);
        await stream.writeSSE({ event: "result", data: JSON.stringify(result) });
      } catch (err) {
        if (!controller.signal.aborted) {
          log("error", "ask_failed", { traceId, error: err instanceof Error ? err.message : String(err) });
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({ error: "internal_error", message: "Something went wrong. Please try again.", traceId }),
          });
        }
      } finally {
        inflight.release();
      }
    });
  });

  app.post("/feedback", limitBody, requireJson, async (c) => {
    if (feedbackPerIp.check(clientIp(c)) > 0) return c.json({ error: "rate_limited", message: "Too many requests." }, 429);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json", message: "Body must be valid JSON." }, 400);
    }
    const parsed = FeedbackBody.safeParse(raw);
    if (!parsed.success) return c.json({ error: "invalid_request", message: "Invalid feedback." }, 400);
    const trace = traces.get(parsed.data.traceId);
    // feedback is only accepted for answers this server actually gave recently
    if (!trace) return c.json({ error: "unknown_trace", message: "That answer has expired." }, 404);
    const entry = {
      at: new Date().toISOString(),
      traceId: parsed.data.traceId,
      rating: parsed.data.rating,
      comment: parsed.data.comment ? redact(parsed.data.comment) : undefined,
      ...trace,
    };
    await fs.mkdir(settings.dataDir, { recursive: true });
    await fs.appendFile(path.join(settings.dataDir, "feedback.jsonl"), JSON.stringify(entry) + "\n");
    log("info", "feedback", { traceId: entry.traceId, rating: entry.rating });
    // thumbs up/down also lands on the answer's trace in langfuse
    score(trace.langfuseTraceId, "user-feedback", parsed.data.rating === "up", entry.comment);
    return c.json({ ok: true });
  });

  // latest eval report, read by the dashboard page
  app.get("/evals/latest", async (c) => {
    try {
      const raw = await fs.readFile(path.join(settings.reportsDir, "latest.json"), "utf8");
      return c.json(JSON.parse(raw));
    } catch {
      return c.json({ error: "not_found", message: "No eval report yet. Run npm run eval." }, 404);
    }
  });

  if (opts.serveWeb) {
    const webRoot = path.relative(process.cwd(), path.join(ROOT, "web", "dist"));
    app.use("/assets/*", async (c, next) => {
      await next();
      // vite fingerprints asset filenames, so they can be cached forever
      c.header("Cache-Control", "public, max-age=31536000, immutable");
    });
    app.use("/*", serveStatic({ root: webRoot }));
    app.get("*", serveStatic({ root: webRoot, path: "index.html" }));
  }

  app.notFound((c) => c.json({ error: "not_found", message: "Not found." }, 404));

  // never leak stack traces or upstream error details to the client
  app.onError((err, c) => {
    const traceId = crypto.randomUUID();
    log("error", "unhandled", { traceId, error: err.message });
    return c.json({ error: "internal_error", message: "Something went wrong. Please try again.", traceId }, 500);
  });

  return app;
}
