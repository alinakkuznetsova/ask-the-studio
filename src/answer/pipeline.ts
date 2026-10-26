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

const ModelOutput = z.object({
  answerable: z.boolean(),
  decline_type: z.enum(["none", "not_in_sources", "off_topic"]),
  partial: z.boolean(),
  sentences: z.array(z.object({ sources: z.array(z.string()), text: z.string() })),
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

// strip control characters (keeps newlines and tabs) and trim
export function cleanInput(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
}

export async function ask(question: string, deps: PipelineDeps, opts: AskOptions = {}): Promise<AskResult> {
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
    const res = await deps.chat.complete(
      [
        { role: "system", content: REWRITE_PROMPT },
        { role: "user", content: buildRewriteMessage(q, history) },
      ],
      120,
      opts.signal,
    );
    addUsage(res.usage);
    const r = cleanInput(res.text).slice(0, settings.maxQuestionChars);
    if (r) searchQuery = rewritten = r;
  }
  const rewriteMs = performance.now() - tRewrite;

  // 2. retrieve
  const tRetrieve = performance.now();
  const { results, bestSimilarity, archived } = await deps.retriever.search(searchQuery);
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
    finish({ answer: DECLINES[reason], answerable: false, declineReason: reason, sources: [] }, generateMs, stats);

  // 3. relevance gate: nothing in the kb is close, so do not spend a model call
  if (bestSimilarity < settings.minSimilarity) return decline("low_relevance");

  // 4. generate, streaming each sentence (with its source markers) as it arrives
  const tGen = performance.now();
  const labels = new Map<string, { chunk: (typeof results)[number]["chunk"]; archived: boolean }>();
  results.forEach((r, i) => labels.set(sourceLabel(i, false), { chunk: r.chunk, archived: false }));
  archived.forEach((c, i) => labels.set(sourceLabel(i, true), { chunk: c, archived: true }));

  const sentenceStreamer = new SentenceStreamer();
  const markers = new MarkerRewriter(new Set(labels.keys()));
  const gen = await deps.chat.streamJson(
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserMessage(q, results, archived, history, formatToday(opts.now ?? new Date())) },
    ],
    { name: "grounded_answer", schema: ANSWER_SCHEMA },
    settings.maxAnswerTokens,
    (delta) => {
      const text = sentenceStreamer.feed(delta);
      if (text && opts.onDelta) {
        const out = markers.push(text);
        if (out) opts.onDelta(out);
      }
    },
    opts.signal,
  );
  if (opts.onDelta) {
    const rest = markers.flush();
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
  const { valid, dropped, checked } = validateCitations(parsed.citations, sourceText);
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
  const text = parsed.partial ? `${display.text}\n\n${PARTIAL_LINE}` : display.text;
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

  return finish({ answer: text, answerable: true, sources }, generateMs, {
    dropped,
    checked,
    sentencesTotal: parts.length,
    sentencesCited,
  });
}
