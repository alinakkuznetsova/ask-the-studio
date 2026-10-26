import crypto from "node:crypto";
import { z } from "zod";
import { costUsd, settings } from "../config.js";
import type { Retriever } from "../retrieval/retriever.js";
import type { AskResult, ChatTurn, Citation, DeclineReason } from "../types.js";
import type { ChatModel, Usage } from "./llm.js";
import {
  ANSWER_SCHEMA,
  buildRewriteMessage,
  buildUserMessage,
  DECLINES,
  PARTIAL_LINE,
  PROMPT_VERSION,
  REWRITE_PROMPT,
  sourceLabel,
  SYSTEM_PROMPT,
} from "./prompt.js";
import { joinSentences, MarkerRewriter, rewriteMarkers, SentenceStreamer } from "./stream-parse.js";
import { leaksPrompt, validateCitations } from "./validate.js";
import { redactAnswer, StreamRedactor } from "./safety.js";
import { startActiveObservation } from "@langfuse/tracing";
import { generation, step, tracingEnabled } from "../observability/tracing.js";

const ModelOutput = z.object({
  answerable: z.boolean(),
  decline_type: z.enum(["none", "not_in_sources", "off_topic"]),
  partial: z.boolean(),
  sentences: z.array(z.object({ sources: z.array(z.string()), text: z.string() })),
  follow_ups: z.array(z.string()),
  citations: z.array(z.object({ source: z.string(), quote: z.string() })),
});

export interface PipelineDeps {
  retriever: Retriever;
  chat: ChatModel;
}

export interface AskOptions {
  history?: ChatTurn[];
  // called with display-ready text as the answer streams in. the final
  // result may differ (unverified citations removed, or a decline)
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
  traceId?: string;
  // the date used for offers and deadlines; injectable so tests are stable
  now?: Date;
}

// e.g. "26 October 2026", in the brand's own time zone
export function formatToday(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" });
}

// normalises unicode (so look-alike characters compare equal), strips
// control characters (keeping newlines and tabs) and invisible formatting
// characters (zero-width and bidirectional overrides), which can hide
// instructions from filters and from a human reading the logs
export function cleanInput(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, "")
    .trim();
}

// follow-up suggestions are model output shown as buttons, so they get the
// same scrutiny as answers: short, question-shaped, no markup, no leaks,
// no personal data, no repeats of the question just asked
export function cleanFollowUps(raw: string[], question: string): string[] {
  const seen = new Set([question.toLowerCase().replace(/\W+/g, " ").trim()]);
  const out: string[] = [];
  for (const r of raw) {
    if (/[<>{}]/.test(r)) continue; // no markup, ever
    const f = redactAnswer(cleanInput(r)).replace(/\s+/g, " ");
    const key = f.toLowerCase().replace(/\W+/g, " ").trim();
    if (!f.endsWith("?") || f.length < 8 || f.length > 90 || seen.has(key) || leaksPrompt(f) || /removed\]/.test(f)) continue;
    seen.add(key);
    out.push(f);
    if (out.length === 3) break;
  }
  return out;
}

// one trace per question when tracing is on (see observability/tracing.ts)
export async function ask(question: string, deps: PipelineDeps, opts: AskOptions = {}): Promise<AskResult> {
  return startActiveObservation("ask", async (root) => {
    root.update({ input: { question, historyTurns: opts.history?.length ?? 0 } });
    try {
      const result = await askSteps(question, deps, opts);
      root.update({
        output: {
          answer: result.answer,
          answerable: result.answerable,
          declineReason: result.declineReason,
          sources: result.sources.map((x) => x.chunkId),
        },
        metadata: {
          traceId: result.meta.traceId,
          promptVersion: result.meta.promptVersion,
          costUsd: result.meta.costUsd,
          latencyMs: result.meta.latencyMs,
          droppedCitations: result.meta.droppedCitations,
        },
      });
      if (tracingEnabled()) result.meta.langfuseTraceId = root.traceId;
      return result;
    } catch (err) {
      root.update({ level: "ERROR", statusMessage: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  });
}

async function askSteps(question: string, deps: PipelineDeps, opts: AskOptions): Promise<AskResult> {
  const t0 = performance.now();
  const traceId = opts.traceId ?? crypto.randomUUID();
  const usage: Usage = { input: 0, output: 0 };
  const addUsage = (u: Usage) => {
    usage.input += u.input;
    usage.output += u.output;
  };
  const q = cleanInput(question);
  const history = (opts.history ?? []).slice(-settings.maxHistoryTurns).map((t) => ({
    role: t.role,
    content: cleanInput(t.content).slice(0, settings.maxHistoryChars),
  }));

  // 1. follow-ups: rewrite into a standalone question for retrieval
  let searchQuery = q;
  let rewritten: string | undefined;
  const tRewrite = performance.now();
  if (history.length) {
    const rw = generation("rewrite follow-up", deps.chat.model, { question: q, history });
    const res = await deps.chat.complete(
      [
        { role: "system", content: REWRITE_PROMPT },
        { role: "user", content: buildRewriteMessage(q, history) },
      ],
      120,
      opts.signal,
    );
    addUsage(res.usage);
    rw.end(res.text, res.usage);
    const r = cleanInput(res.text).slice(0, settings.maxQuestionChars);
    if (r) searchQuery = rewritten = r;
  }
  const rewriteMs = performance.now() - tRewrite;

  // 2. retrieve
  const tRetrieve = performance.now();
  const rs = step("retrieve", "retriever", { query: searchQuery });
  const { results, bestSimilarity, archived } = await deps.retriever.search(searchQuery);
  rs.end(
    {
      current: results.map((r) => ({ chunk: r.chunk.id, fused: r.score, similarity: r.vectorScore, bm25: r.bm25Score })),
      archived: archived.map((c) => c.id),
    },
    { bestSimilarity },
  );
  const retrieveMs = performance.now() - tRetrieve;

  interface Stats {
    dropped?: number;
    checked?: number;
    sentencesTotal?: number;
    sentencesCited?: number;
  }
  const finish = (body: Omit<AskResult, "meta">, generateMs: number, stats: Stats = {}): AskResult => ({
    ...body,
    meta: {
      traceId,
      model: deps.chat.model,
      promptVersion: PROMPT_VERSION,
      latencyMs: {
        rewrite: Math.round(rewriteMs),
        retrieve: Math.round(retrieveMs),
        generate: Math.round(generateMs),
        total: Math.round(performance.now() - t0),
      },
      tokens: usage,
      costUsd: costUsd(deps.chat.model, usage.input, usage.output),
      rewrittenQuestion: rewritten,
      retrieved: results.map((r) => ({
        chunkId: r.chunk.id,
        score: Number(r.score.toFixed(4)),
        vectorScore: r.vectorScore === null ? null : Number(r.vectorScore.toFixed(4)),
      })),
      citationsChecked: stats.checked ?? 0,
      droppedCitations: stats.dropped ?? 0,
      sentencesTotal: stats.sentencesTotal ?? 0,
      sentencesCited: stats.sentencesCited ?? 0,
    },
  });
  const decline = (reason: DeclineReason, generateMs = 0, stats: Stats = {}) =>
    finish({ answer: DECLINES[reason], answerable: false, declineReason: reason, sources: [], followUps: [] }, generateMs, stats);

  // 3. relevance gate: nothing in the kb is close, so do not spend a model call
  if (bestSimilarity < settings.minSimilarity) return decline("low_relevance");

  // 4. generate, streaming each sentence (with its source markers) as it arrives
  const tGen = performance.now();
  const labels = new Map<string, { chunk: (typeof results)[number]["chunk"]; archived: boolean }>();
  results.forEach((r, i) => labels.set(sourceLabel(i, false), { chunk: r.chunk, archived: false }));
  archived.forEach((c, i) => labels.set(sourceLabel(i, true), { chunk: c, archived: true }));

  const sentenceStreamer = new SentenceStreamer();
  // masks personal data in the stream before it is shown (see safety.ts)
  const guard = new StreamRedactor();
  const markers = new MarkerRewriter(new Set(labels.keys()));
  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    { role: "user" as const, content: buildUserMessage(q, results, archived, history, formatToday(opts.now ?? new Date())) },
  ];
  const gt = generation("generate answer", deps.chat.model, messages);
  let gen: Awaited<ReturnType<ChatModel["streamJson"]>>;
  try {
    gen = await deps.chat.streamJson(
    messages,
    { name: "grounded_answer", schema: ANSWER_SCHEMA },
    settings.maxAnswerTokens,
    (delta) => {
      const text = sentenceStreamer.feed(delta);
      if (text && opts.onDelta) {
        const out = guard.push(markers.push(text));
        if (out) opts.onDelta(out);
      }
    },
    opts.signal,
  );
  } catch (err) {
    gt.fail(err);
    throw err;
  }
  gt.end(gen.text, gen.usage, { promptVersion: PROMPT_VERSION });
  if (opts.onDelta) {
    const rest = guard.push(markers.flush()) + guard.flush();
    if (rest) opts.onDelta(rest);
  }
  addUsage(gen.usage);
  const generateMs = performance.now() - tGen;

  // 5. parse and validate. anything malformed becomes a safe decline
  let parsed: z.infer<typeof ModelOutput>;
  try {
    parsed = ModelOutput.parse(JSON.parse(gen.text));
  } catch {
    return decline("unverified", generateMs);
  }

  if (leaksPrompt(parsed.sentences.map((x) => x.text).join(" "))) return decline("off_topic", generateMs);
  if (!parsed.answerable) {
    return decline(parsed.decline_type === "off_topic" ? "off_topic" : "not_in_sources", generateMs);
  }

  const sourceText = new Map([...labels].map(([label, v]) => [label, v.chunk.text]));
  const vt = step("verify citations", "guardrail", { citations: parsed.citations });
  const { valid, dropped, checked } = validateCitations(parsed.citations, sourceText);
  vt.end({ verified: valid, dropped }, { checked });
  // an answer must be backed by at least one verified quote from a current source
  if (!valid.some((v) => !labels.get(v.source)!.archived)) return decline("unverified", generateMs, { dropped, checked });

  // markers are added by code from each sentence's declared sources, keeping
  // only sources whose quotes verified. the model cannot forget to cite.
  const validLabels = new Set(valid.map((v) => v.source));
  const parts = parsed.sentences
    .map((x) => ({ text: x.text, labels: [...new Set(x.sources.map((l) => l.trim()))].filter((l) => validLabels.has(l)) }))
    .filter((x) => x.text.trim());
  const sentencesCited = parts.filter((x) => x.labels.length > 0).length;
  const display = rewriteMarkers(joinSentences(parts), validLabels);
  const { order } = display;
  // add the contact line unless the answer already gives the email
  const needsContact = parsed.partial && !display.text.includes(settings.supportEmail);
  const text = redactAnswer(needsContact ? `${display.text}\n\n${PARTIAL_LINE}` : display.text);
  // sources cited with a quote but not marked inline still get listed, after the inline ones
  for (const v of valid) if (!order.includes(v.source)) order.push(v.source);

  const sources: Citation[] = order.map((label, i) => {
    const { chunk, archived: isArchived } = labels.get(label)!;
    return {
      n: i + 1,
      chunkId: chunk.id,
      docId: chunk.docId,
      title: chunk.docTitle,
      section: chunk.section,
      quotes: valid.find((v) => v.source === label)!.quotes,
      archived: isArchived,
      effectiveFrom: chunk.effectiveFrom,
      url: chunk.url,
    };
  });

  return finish({ answer: text, answerable: true, sources, followUps: cleanFollowUps(parsed.follow_ups, q) }, generateMs, {
    dropped,
    checked,
    sentencesTotal: parts.length,
    sentencesCited,
  });
}
