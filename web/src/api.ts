// api client. types mirror src/types.ts on the server.

export interface Citation {
  n: number;
  chunkId: string;
  docId: string;
  title: string;
  section: string;
  quotes: string[];
  archived: boolean;
  effectiveFrom: string;
  url?: string;
}

export interface AskResult {
  answer: string;
  answerable: boolean;
  declineReason?: "not_in_sources" | "off_topic" | "low_relevance" | "unverified";
  sources: Citation[];
  meta: {
    traceId: string;
    model: string;
    promptVersion: string;
    latencyMs: { rewrite: number; retrieve: number; generate: number; total: number };
    tokens: { input: number; output: number };
    costUsd: number | null;
    rewrittenQuestion?: string;
    retrieved: { chunkId: string; score: number; vectorScore: number | null }[];
    citationsChecked: number;
    droppedCitations: number;
  };
}

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

export class ApiError extends Error {}

async function errorFrom(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { message?: string };
    return new ApiError(body.message ?? "Something went wrong. Please try again.");
  } catch {
    return new ApiError("Something went wrong. Please try again.");
  }
}

// posts the question and reads the server-sent event stream by hand
// (EventSource cannot send a POST body)
export async function askStream(
  question: string,
  history: Turn[],
  onDelta: (text: string) => void,
  signal: AbortSignal,
): Promise<AskResult> {
  const res = await fetch("/ask/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question, history }),
    signal,
  });
  if (!res.ok || !res.body) throw await errorFrom(res);

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let result: AskResult | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      const payload = JSON.parse(data.join("\n"));
      if (event === "delta") onDelta(payload.text);
      else if (event === "result") result = payload as AskResult;
      else if (event === "error") throw new ApiError(payload.message);
    }
  }
  if (!result) throw new ApiError("The answer was interrupted. Please try again.");
  return result;
}

export async function sendFeedback(traceId: string, rating: "up" | "down"): Promise<void> {
  const res = await fetch("/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ traceId, rating }),
  });
  if (!res.ok) throw await errorFrom(res);
}

export async function fetchEvals(): Promise<EvalReport | null> {
  const res = await fetch("/evals/latest");
  if (res.status === 404) return null;
  if (!res.ok) throw await errorFrom(res);
  return (await res.json()) as EvalReport;
}

export interface EvalSummary {
  cases: number;
  passRate: number | null;
  retrievalRecall: number | null;
  declineAccuracy: number | null;
  falseDeclines: number;
  falseAnswers: number;
  factAccuracy: number | null;
  correctness: number | null;
  groundedness: number | null;
  quoteVerification: number | null;
  citationPrecision: number | null;
  latencyP50: number | null;
  latencyP95: number | null;
  costPerAnswerUsd: number | null;
  byCategory: Record<string, { cases: number; passRate: number | null }>;
}

export interface EvalCaseResult {
  id: string;
  category: string;
  question: string;
  expect: string;
  answer: string;
  answerable: boolean;
  declineReason?: string;
  retrievalRecall: number | null;
  declineCorrect: boolean;
  factsPass: boolean | null;
  factFailures: string[];
  judge: { correctness: number; grounded: boolean; reason: string } | null;
  pass: boolean;
  latencyMs: number;
  sources: string[];
  retrieved: string[];
  error?: string;
}

export interface EvalReport {
  runAt: string;
  datasetVersion: string;
  promptVersion: string;
  models: { chat: string; embedding: string; judge: string };
  summary: EvalSummary;
  previous: { runAt: string; summary: EvalSummary } | null;
  baseline: { runAt: string; summary: EvalSummary } | null;
  results: EvalCaseResult[];
}
