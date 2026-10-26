// langfuse tracing over opentelemetry. off unless both keys are set, so the
// app runs exactly the same without an account. when on, every question
// becomes a trace: rewrite, retrieval, generation and verification steps,
// with timings, token usage, inputs and outputs. personal data is masked
// before anything leaves the server.

import { LangfuseSpanProcessor } from "@langfuse/otel";
import { startObservation, type LangfuseGeneration, type LangfuseSpan } from "@langfuse/tracing";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseClient } from "@langfuse/client";
import { env } from "../config.js";
import { redact } from "../server/redact.js";

let processor: LangfuseSpanProcessor | null = null;
let client: LangfuseClient | null = null;

export function langfuseConfig(): { publicKey: string; secretKey: string; baseUrl: string } | null {
  const e = env();
  if (!e.LANGFUSE_PUBLIC_KEY || !e.LANGFUSE_SECRET_KEY) return null;
  return {
    publicKey: e.LANGFUSE_PUBLIC_KEY,
    secretKey: e.LANGFUSE_SECRET_KEY,
    baseUrl: e.LANGFUSE_BASE_URL ?? e.LANGFUSE_HOST ?? "https://cloud.langfuse.com",
  };
}

// masks strings anywhere in an exported value (the sdk calls this for
// inputs, outputs and metadata before export)
function maskDeep(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v)]));
  }
  return value;
}

export function initTracing(environment: string): boolean {
  const config = langfuseConfig();
  if (!config) return false;
  processor = new LangfuseSpanProcessor({
    ...config,
    environment,
    mask: ({ data }) => maskDeep(data),
  });
  new NodeTracerProvider({ spanProcessors: [processor] }).register();
  client = new LangfuseClient(config);
  return true;
}

// records a score on a trace (eval results, user thumbs). scores are
// batched by the client and sent on flush or shutdown
export function score(
  traceId: string | undefined,
  name: string,
  value: number | boolean,
  comment?: string,
): void {
  if (!client || !traceId) return;
  client.score.create({
    traceId,
    name,
    value: typeof value === "boolean" ? (value ? 1 : 0) : value,
    dataType: typeof value === "boolean" ? "BOOLEAN" : "NUMERIC",
    comment: comment ? redact(comment) : undefined,
  });
}

export const tracingEnabled = () => processor !== null;

// sends anything still buffered; call before the process exits
export async function shutdownTracing(): Promise<void> {
  await client?.score.flush();
  await processor?.shutdown();
}

// small wrappers so the pipeline reads as steps rather than sdk calls.
// without a registered provider these are no-ops.
export function step(name: string, type: "span" | "retriever" | "guardrail", input?: unknown) {
  const o = startObservation(name, { input }, { asType: type as "span" }) as LangfuseSpan;
  return {
    end(output?: unknown, metadata?: Record<string, unknown>) {
      o.update({ output, metadata });
      o.end();
    },
  };
}

export function generation(name: string, model: string, input: unknown) {
  const g = startObservation(name, { model, input }, { asType: "generation" }) as LangfuseGeneration;
  return {
    end(output: unknown, usage: { input: number; output: number }, metadata?: Record<string, unknown>) {
      g.update({ output, usageDetails: { input: usage.input, output: usage.output }, metadata });
      g.end();
    },
    fail(error: unknown) {
      g.update({ level: "ERROR", statusMessage: error instanceof Error ? error.message : String(error) });
      g.end();
    },
  };
}
