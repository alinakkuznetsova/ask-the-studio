import "dotenv/config";
import { serve } from "@hono/node-server";
import { env } from "./config.js";
import { buildIndex, openaiClient } from "./kb/build.js";
import { OpenAIChat } from "./answer/llm.js";
import { createApp } from "./server/app.js";
import { log } from "./server/logger.js";

const cfg = env();
const t0 = Date.now();

// ingest at startup: 31 docs embed in about a second, and the cache makes
// restarts nearly free. a large kb would ingest offline into a vector db.
let index: Awaited<ReturnType<typeof buildIndex>>;
try {
  index = await buildIndex();
} catch (err) {
  // fail fast with a readable message; the host restarts the service
  log("error", "startup_failed", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}
const { docs, retriever, embedder } = index;
log("info", "index_ready", {
  docs: docs.length,
  chunks: retriever.chunks.length,
  embeddedNow: embedder.stats.misses,
  fromCache: embedder.stats.hits,
  ms: Date.now() - t0,
});

const app = createApp({
  deps: { retriever, chat: new OpenAIChat(openaiClient(), cfg.CHAT_MODEL) },
  trustProxy: cfg.TRUST_PROXY,
  ratePerMinute: cfg.RATE_LIMIT_PER_MINUTE,
  dailyCap: cfg.DAILY_REQUEST_CAP,
  docs: docs.length,
  serveWeb: true,
});

const server = serve({ fetch: app.fetch, port: cfg.PORT, hostname: "0.0.0.0" }, (info) => {
  log("info", "listening", { port: info.port, model: cfg.CHAT_MODEL });
});

// graceful shutdown so in-flight answers finish during a deploy
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log("info", "shutdown", { signal: sig });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
