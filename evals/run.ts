// eval runner.
// usage:
//   npm run eval                      full system
//   npm run eval:baseline             vector-only, no version filtering, no contextual headers
//   npm run eval -- --gate            exit 1 if any threshold in thresholds.json fails (ci)
//   npm run eval -- --only c1-return-window,o2-prompt-injection
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { env, costUsd, settings } from "../src/config.js";
import { ask } from "../src/answer/pipeline.js";
import { OpenAIChat } from "../src/answer/llm.js";
import { PROMPT_VERSION } from "../src/answer/prompt.js";
import { BASELINE_RETRIEVAL, buildIndex, DEFAULT_RETRIEVAL, openaiClient } from "../src/kb/build.js";
import { judge } from "./judge.js";
import { DatasetSchema, scoreCase, summarise, type CaseResult, type Summary } from "./score.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const variant = opt("variant") === "baseline" ? "baseline" : "full";
const only = opt("only")?.split(",");
const concurrency = Number(opt("concurrency") ?? 4);
const here = path.dirname(new URL(import.meta.url).pathname);

const dataset = DatasetSchema.parse(JSON.parse(await fs.readFile(path.join(here, "dataset.json"), "utf8")));
const cases = dataset.cases.filter((c) => !only || only.includes(c.id));

const cfg = env();
const client = openaiClient();
const chat = new OpenAIChat(client, cfg.CHAT_MODEL);
const judgeModel = new OpenAIChat(client, cfg.JUDGE_MODEL);
const retrievalConfig = variant === "baseline" ? BASELINE_RETRIEVAL : DEFAULT_RETRIEVAL;
const { retriever } = await buildIndex(retrievalConfig);
const chunkById = new Map(retriever.chunks.map((c) => [c.id, c]));

console.log(`\nask the studio evals: ${cases.length} cases, variant=${variant}, model=${cfg.CHAT_MODEL}, prompt=${PROMPT_VERSION}\n`);

let judgeCost = 0;
async function runCase(c: (typeof cases)[number]): Promise<CaseResult> {
  try {
    const r = await ask(c.question, { retriever, chat }, { history: c.history });
    let j = null;
    if (r.answerable) {
      const res = await judge(judgeModel, {
        question: c.question,
        reference: c.reference,
        answer: r.answer,
        sources: r.sources.map((s) => ({ title: `${s.title} > ${s.section}`, text: chunkById.get(s.chunkId)?.text ?? "" })),
      });
      judgeCost += costUsd(cfg.JUDGE_MODEL, res.usage.input, res.usage.output) ?? 0;
      j = { correctness: res.correctness, grounded: res.grounded, reason: res.reason };
    }
    return scoreCase(c, r, j);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      id: c.id, category: c.category, question: c.question, expect: c.expect, answer: "", answerable: false,
      retrievalRecall: null, declineCorrect: false, factsPass: false, factFailures: [], citationPrecision: null,
      quoteVerification: null, judge: null, pass: false, latencyMs: 0, costUsd: null, tokens: { input: 0, output: 0 },
      sources: [], retrieved: [], error: message,
    };
  }
}

// small worker pool: fast, but gentle on rate limits
const results: CaseResult[] = new Array(cases.length);
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(concurrency, cases.length) }, async () => {
    while (next < cases.length) {
      const i = next++;
      results[i] = await runCase(cases[i]!);
      const r = results[i]!;
      process.stdout.write(`${r.pass ? "✓" : "✗"} ${r.id}${r.error ? `  error: ${r.error}` : ""}\n`);
    }
  }),
);

const summary = summarise(results);

// ---------- reporting ----------
const f = (x: number | null, kind: "pct" | "num" | "ms" | "usd" = "pct") =>
  x === null ? "n/a" : kind === "pct" ? `${(x * 100).toFixed(0)}%` : kind === "ms" ? `${Math.round(x)}ms` : kind === "usd" ? `$${x.toFixed(5)}` : x.toFixed(2);

const METRICS: [keyof Summary, string, "pct" | "num" | "ms" | "usd"][] = [
  ["passRate", "Pass rate", "pct"],
  ["retrievalRecall", "Retrieval recall@k", "pct"],
  ["declineAccuracy", "Decline accuracy", "pct"],
  ["factAccuracy", "Must-include / must-not facts", "pct"],
  ["correctness", "Correctness (judge, 1 to 5)", "num"],
  ["groundedness", "Groundedness (judge)", "pct"],
  ["quoteVerification", "Quotes verified verbatim", "pct"],
  ["citationPrecision", "Citation precision", "pct"],
  ["latencyP50", "Latency p50", "ms"],
  ["latencyP95", "Latency p95", "ms"],
  ["costPerAnswerUsd", "Cost per answer", "usd"],
];

console.log("\ncase results");
console.table(
  results.map((r) => ({
    case: r.id,
    pass: r.pass ? "✓" : "✗",
    decline: r.declineCorrect ? "ok" : r.answerable ? "answered" : "declined",
    recall: r.retrievalRecall === null ? "" : f(r.retrievalRecall),
    facts: r.factsPass === null ? "" : r.factsPass ? "ok" : r.factFailures.join("; "),
    judge: r.judge ? `${r.judge.correctness}/5${r.judge.grounded ? "" : " ungrounded"}` : "",
    ms: r.latencyMs,
  })),
);

const runsDir = path.join(settings.reportsDir, "runs");
await fs.mkdir(runsDir, { recursive: true });
const latestPath = path.join(settings.reportsDir, `latest-${variant}.json`);
const previous = await fs.readFile(latestPath, "utf8").then((s) => JSON.parse(s) as { summary: Summary; runAt: string }, () => null);

const deltaStr = (k: keyof Summary, kind: "pct" | "num" | "ms" | "usd") => {
  const a = previous?.summary[k];
  const b = summary[k];
  if (typeof a !== "number" || typeof b !== "number") return "";
  const d = b - a;
  if (Math.abs(d) < 1e-9) return "=";
  return kind === "pct" ? `${d > 0 ? "+" : ""}${(d * 100).toFixed(0)}pt` : kind === "ms" ? `${d > 0 ? "+" : ""}${Math.round(d)}ms` : `${d > 0 ? "+" : ""}${d.toFixed(kind === "usd" ? 5 : 2)}`;
};

console.log(`\nsummary (${variant})${previous ? `, change vs previous run (${previous.runAt})` : ""}`);
console.table(Object.fromEntries(METRICS.map(([k, label, kind]) => [label, { value: f(summary[k] as number | null, kind), change: deltaStr(k, kind) }])));
console.log(`false declines: ${summary.falseDeclines}, false answers: ${summary.falseAnswers}, judge cost: $${judgeCost.toFixed(4)}`);

const report = {
  runAt: new Date().toISOString(),
  variant,
  datasetVersion: dataset.version,
  promptVersion: PROMPT_VERSION,
  models: { chat: cfg.CHAT_MODEL, embedding: cfg.EMBEDDING_MODEL, judge: cfg.JUDGE_MODEL },
  retrieval: retrievalConfig,
  summary,
  judgeCostUsd: judgeCost,
  previous: previous ? { runAt: previous.runAt, summary: previous.summary } : null,
  results,
};

// partial runs (--only) are printed but never overwrite the saved reports
if (!only) {
  const stamp = report.runAt.replace(/[:.]/g, "-");
  await fs.writeFile(path.join(runsDir, `${stamp}-${variant}.json`), JSON.stringify(report, null, 2));
  await fs.writeFile(latestPath, JSON.stringify(report, null, 2));

  // latest.json feeds the dashboard: the full run, plus the baseline summary for comparison
  const full = variant === "full" ? report : await fs.readFile(path.join(settings.reportsDir, "latest-full.json"), "utf8").then(JSON.parse, () => null);
  const base = variant === "baseline" ? report : await fs.readFile(path.join(settings.reportsDir, "latest-baseline.json"), "utf8").then(JSON.parse, () => null);
  if (full) {
    await fs.writeFile(
      path.join(settings.reportsDir, "latest.json"),
      JSON.stringify({ ...full, baseline: base ? { runAt: base.runAt, retrieval: base.retrieval, summary: base.summary } : null }, null, 2),
    );
    await fs.writeFile(path.join(settings.reportsDir, "latest.md"), markdown(full, base));
  }
  console.log(`\nreport saved to evals/reports/latest-${variant}.json`);
}

function markdown(full: typeof report, base: typeof report | null): string {
  const lines = [
    `# Eval report`,
    ``,
    `Run ${full.runAt}, dataset ${full.datasetVersion}, prompt ${full.promptVersion}, chat model ${full.models.chat}, judge ${full.models.judge}.`,
    ``,
    `| Metric | ${base ? "Baseline | " : ""}Full system |`,
    `|---|${base ? "---|" : ""}---|`,
    ...METRICS.map(([k, label, kind]) => `| ${label} | ${base ? `${f(base.summary[k] as number | null, kind)} | ` : ""}${f(full.summary[k] as number | null, kind)} |`),
    `| False declines | ${base ? `${base.summary.falseDeclines} | ` : ""}${full.summary.falseDeclines} |`,
    `| False answers | ${base ? `${base.summary.falseAnswers} | ` : ""}${full.summary.falseAnswers} |`,
    ``,
    base ? `Baseline: vector-only retrieval, no version filtering, no contextual headers. Full: hybrid (vector + BM25, RRF), archived docs filtered, contextual headers.\n` : ``,
    `## By category`,
    ``,
    `| Category | Cases | ${base ? "Baseline | " : ""}Full |`,
    `|---|---|${base ? "---|" : ""}---|`,
    ...Object.entries(full.summary.byCategory).map(
      ([cat, v]) => `| ${cat} | ${v.cases} | ${base ? `${f(base.summary.byCategory[cat]?.passRate ?? null)} | ` : ""}${f(v.passRate)} |`,
    ),
    ``,
    `## Failures (full system)`,
    ``,
    ...(full.results.filter((r) => !r.pass).map(
      (r) =>
        `- **${r.id}**: ${r.error ?? [!r.declineCorrect ? (r.answerable ? "answered when it should decline" : "declined when it should answer") : "", ...r.factFailures, r.judge && (r.judge.correctness < 4 || !r.judge.grounded) ? `judge: ${r.judge.reason}` : ""].filter(Boolean).join("; ")}`,
    ) || []),
    full.results.every((r) => r.pass) ? "None." : "",
    ``,
  ];
  return lines.join("\n");
}

// ---------- gate ----------
if (flag("gate")) {
  const thresholds = JSON.parse(await fs.readFile(path.join(here, "thresholds.json"), "utf8")) as {
    min: Partial<Record<keyof Summary, number>>;
    max: Partial<Record<keyof Summary, number>>;
  };
  const failures: string[] = [];
  for (const [k, v] of Object.entries(thresholds.min)) {
    const actual = summary[k as keyof Summary];
    if (typeof actual !== "number" || actual < v!) failures.push(`${k} ${actual} < ${v}`);
  }
  for (const [k, v] of Object.entries(thresholds.max)) {
    const actual = summary[k as keyof Summary];
    if (typeof actual !== "number" || actual > v!) failures.push(`${k} ${actual} > ${v}`);
  }
  if (failures.length) {
    console.error(`\neval gate failed:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
  console.log("\neval gate passed");
}
