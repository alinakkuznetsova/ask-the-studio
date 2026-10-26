import { z } from "zod";
import { settings } from "../src/config.js";
import type { AskResult } from "../src/types.js";

export const CaseSchema = z.object({
  id: z.string(),
  category: z.enum(["straightforward", "multi_doc", "conflict", "unanswerable", "off_script"]),
  question: z.string(),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).optional(),
  expect: z.enum(["answer", "decline", "partial_or_decline"]),
  declineType: z.enum(["off_topic", "not_in_sources"]).optional(),
  requiredDocs: z.array(z.array(z.string())),
  acceptableDocs: z.array(z.string()),
  mustInclude: z.array(z.string()),
  mustNotInclude: z.array(z.string()),
  reference: z.string(),
});
export type EvalCase = z.infer<typeof CaseSchema>;
export const DatasetSchema = z.object({
  version: z.string(),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().optional(),
  cases: z.array(CaseSchema),
});

export interface Judgement {
  correctness: number; // 1 to 5
  grounded: boolean; // every claim supported by the cited sources
  focused: boolean; // sticks to the question, no padding or system wording
  reason: string;
}

export interface CaseResult {
  id: string;
  category: EvalCase["category"];
  question: string;
  expect: EvalCase["expect"];
  answer: string;
  answerable: boolean;
  declineReason?: string;
  // null when the metric does not apply to this case
  retrievalRecall: number | null;
  declineCorrect: boolean;
  factsPass: boolean | null;
  factFailures: string[];
  citationPrecision: number | null;
  quoteVerification: number | null; // share of model quotes that verified
  sentenceCoverage: number | null; // share of answer sentences with a verified source
  judge: Judgement | null;
  pass: boolean;
  latencyMs: number;
  costUsd: number | null;
  tokens: { input: number; output: number };
  sources: string[];
  retrieved: string[];
  error?: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// case-insensitive; whole-word when the term starts or ends with a letter or
// digit, so "arr" does not match "arrive" and "£65" does not match "£650"
export function containsTerm(text: string, term: string): boolean {
  const t = term.trim();
  const pre = /^[a-z0-9]/i.test(t) ? "\\b" : "";
  const post = /[a-z0-9]$/i.test(t) ? "\\b" : "";
  return new RegExp(`${pre}${escapeRe(t)}${post}`, "i").test(text);
}

export function checkFacts(answer: string, c: EvalCase): string[] {
  const failures: string[] = [];
  for (const item of c.mustInclude) {
    if (!item.split("|").some((alt) => containsTerm(answer, alt))) failures.push(`missing: ${item}`);
  }
  for (const item of c.mustNotInclude) {
    if (containsTerm(answer, item)) failures.push(`should not say: ${item}`);
  }
  return failures;
}

const docOf = (chunkId: string) => chunkId.split("#")[0]!;

export function scoreCase(c: EvalCase, r: AskResult, judge: Judgement | null): CaseResult {
  const retrievedDocs = r.meta.retrieved.map((x) => docOf(x.chunkId));
  const citedDocs = r.sources.map((s) => s.docId);

  // retrieval: share of required groups with at least one doc in the top k.
  // only meaningful when retrieval actually ran (not the low-relevance gate)
  const retrievalRecall = c.requiredDocs.length
    ? c.requiredDocs.filter((g) => g.some((d) => retrievedDocs.includes(d))).length / c.requiredDocs.length
    : null;

  const pointsToSupport = r.answer.includes(settings.supportEmail);
  const declineCorrect =
    c.expect === "answer"
      ? r.answerable
      : c.expect === "decline"
        ? !r.answerable
        : !r.answerable || pointsToSupport;

  const factFailures = checkFacts(r.answer, c);
  // an answer with sources must also number them inline, so readers can tell
  // which sentence each source supports
  const missingMarkers = r.answerable && r.sources.length > 0 && !/\[\d+\]/.test(r.answer);
  if (missingMarkers) factFailures.push("no inline citation numbers");
  const factsPass =
    c.mustInclude.length || c.mustNotInclude.length || missingMarkers ? factFailures.length === 0 : null;

  const allowed = new Set([...c.requiredDocs.flat(), ...c.acceptableDocs]);
  const citationPrecision =
    r.answerable && citedDocs.length ? citedDocs.filter((d) => allowed.has(d)).length / citedDocs.length : null;

  const sentenceCoverage =
    r.answerable && r.meta.sentencesTotal ? r.meta.sentencesCited / r.meta.sentencesTotal : null;

  const quoteVerification = r.meta.citationsChecked
    ? (r.meta.citationsChecked - r.meta.droppedCitations) / r.meta.citationsChecked
    : null;

  // a case passes when the decline decision is right, the hard facts hold,
  // and (for answers) the judge rates it correct, grounded and focused
  const judgeOk = !judge || (judge.correctness >= 4 && judge.grounded && judge.focused);
  const pass = declineCorrect && factsPass !== false && (r.answerable ? judgeOk : true);

  return {
    id: c.id,
    category: c.category,
    question: c.question,
    expect: c.expect,
    answer: r.answer,
    answerable: r.answerable,
    declineReason: r.declineReason,
    retrievalRecall,
    declineCorrect,
    factsPass,
    factFailures,
    citationPrecision,
    quoteVerification,
    sentenceCoverage,
    judge,
    pass,
    latencyMs: r.meta.latencyMs.total,
    costUsd: r.meta.costUsd,
    tokens: r.meta.tokens,
    sources: r.sources.map((s) => s.chunkId),
    retrieved: r.meta.retrieved.map((x) => x.chunkId),
  };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const pct = (xs: boolean[]) => mean(xs.map((x) => (x ? 1 : 0)));

function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
}

export interface Summary {
  cases: number;
  passRate: number | null;
  retrievalRecall: number | null;
  declineAccuracy: number | null;
  falseDeclines: number; // declined a question it should have answered
  falseAnswers: number; // answered a question it should have declined
  factAccuracy: number | null;
  correctness: number | null; // judge mean, 1 to 5
  groundedness: number | null; // share of answers the judge rated fully supported
  focus: number | null; // share of answers the judge rated focused
  quoteVerification: number | null;
  sentenceCoverage: number | null;
  citationPrecision: number | null;
  latencyP50: number | null;
  latencyP95: number | null;
  costPerAnswerUsd: number | null;
  byCategory: Record<string, { cases: number; passRate: number | null }>;
}

export function summarise(results: CaseResult[]): Summary {
  const vals = <T>(f: (r: CaseResult) => T | null) => results.map(f).filter((x): x is T => x !== null);
  const answered = results.filter((r) => r.answerable && r.judge);
  const costs = vals((r) => r.costUsd);
  const byCategory: Summary["byCategory"] = {};
  for (const cat of [...new Set(results.map((r) => r.category))]) {
    const rs = results.filter((r) => r.category === cat);
    byCategory[cat] = { cases: rs.length, passRate: pct(rs.map((r) => r.pass)) };
  }
  return {
    cases: results.length,
    passRate: pct(results.map((r) => r.pass)),
    retrievalRecall: mean(vals((r) => r.retrievalRecall)),
    declineAccuracy: pct(results.map((r) => r.declineCorrect)),
    falseDeclines: results.filter((r) => r.expect === "answer" && !r.answerable).length,
    falseAnswers: results.filter((r) => r.expect === "decline" && r.answerable).length,
    factAccuracy: pct(vals((r) => r.factsPass)),
    correctness: mean(answered.map((r) => r.judge!.correctness)),
    groundedness: pct(answered.map((r) => r.judge!.grounded)),
    focus: pct(answered.map((r) => r.judge!.focused)),
    quoteVerification: mean(vals((r) => r.quoteVerification)),
    sentenceCoverage: mean(vals((r) => r.sentenceCoverage)),
    citationPrecision: mean(vals((r) => r.citationPrecision)),
    latencyP50: percentile(results.map((r) => r.latencyMs), 50),
    latencyP95: percentile(results.map((r) => r.latencyMs), 95),
    costPerAnswerUsd: mean(costs),
    byCategory,
  };
}
