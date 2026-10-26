import { z } from "zod";
import path from "node:path";
import { fileURLToPath } from "node:url";

// all runtime configuration comes from env vars, validated once at startup.
// secrets never have defaults and are never logged.

const here = path.dirname(fileURLToPath(import.meta.url));
// works from src/ (tsx) and dist/src/ (compiled)
export const ROOT = here.includes(`${path.sep}dist${path.sep}`)
  ? path.resolve(here, "../..")
  : path.resolve(here, "..");

const bool = z
  .enum(["0", "1", "true", "false"])
  .default("0")
  .transform((v) => v === "1" || v === "true");

const EnvSchema = z.object({
  OPENAI_API_KEY: z.string().min(1).optional(),
  CHAT_MODEL: z.string().default("gpt-4.1-mini"),
  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  JUDGE_MODEL: z.string().default("gpt-4.1-mini"),
  PORT: z.coerce.number().int().positive().default(3000),
  TRUST_PROXY: bool,
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  DAILY_REQUEST_CAP: z.coerce.number().int().positive().default(1000),
  NODE_ENV: z.string().default("development"),
  // optional langfuse tracing; off unless both keys are set
  LANGFUSE_PUBLIC_KEY: z.string().min(1).optional(),
  LANGFUSE_SECRET_KEY: z.string().min(1).optional(),
  LANGFUSE_BASE_URL: z.string().url().optional(),
  LANGFUSE_HOST: z.string().url().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;
export function env(): Env {
  if (!cached) cached = EnvSchema.parse(process.env);
  return cached;
}

export function requireApiKey(): string {
  const key = env().OPENAI_API_KEY;
  if (!key) {
    throw new Error("OPENAI_API_KEY is not set. copy .env.example to .env and add a key.");
  }
  return key;
}

// tunable retrieval and answering settings. kept in code (not env) because
// changing them changes behaviour and should go through evals and review.
export const settings = {
  kbDir: path.join(ROOT, "knowledge-base"),
  cacheDir: path.join(ROOT, ".cache"),
  dataDir: path.join(ROOT, "data"),
  reportsDir: path.join(ROOT, "evals", "reports"),

  // chunking
  wholeDocMaxWords: 220, // short docs (product pages) stay as one chunk
  wholePolicyMaxWords: 400, // a whole policy, so its conditions travel together
  sectionMinWords: 35, // smaller neighbouring sections get merged
  sectionMaxWords: 300, // long sections get split on paragraphs

  // retrieval
  candidatesPerRetriever: 20,
  rrfK: 60,
  topK: 6,
  archivedPerAnswer: 2,
  // below this best cosine similarity the question is almost certainly not
  // about parure, so we decline without calling the chat model
  minSimilarity: 0.2,

  // request limits
  maxQuestionChars: 500,
  maxHistoryTurns: 6,
  maxHistoryChars: 1500,
  // the json carries each sentence twice (text and quote) plus follow-ups,
  // so a broad question ("how do returns work?") needs room. 600 cut those off
  maxAnswerTokens: 1200,

  supportEmail: "hello@parurelondon.com",
} as const;

// usd per 1m tokens, used for the cost-per-answer metric.
// unknown models fall back to zero and the ui shows "n/a".
export const PRICES: Record<string, { input: number; output: number }> = {
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "text-embedding-3-small": { input: 0.02, output: 0 },
  "text-embedding-3-large": { input: 0.13, output: 0 },
};

export function costUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = PRICES[model];
  if (!p) return null;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}
