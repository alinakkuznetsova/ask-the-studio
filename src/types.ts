// shared domain types

export type DocType = "policy" | "product" | "collection" | "guide" | "faq" | "brand" | "contact";

export interface Doc {
  id: string;
  title: string;
  type: DocType;
  collection?: string;
  effectiveFrom: string; // iso date
  supersedes?: string;
  supersededBy?: string;
  url?: string;
  body: string; // markdown without frontmatter
  path: string; // relative to the knowledge base
}

export interface Chunk {
  id: string; // `${docId}#${sectionSlug}` plus a part suffix when split
  docId: string;
  docTitle: string;
  docType: DocType;
  section: string;
  text: string; // raw section text, used for quotes and display
  // contextual header + text. this is what gets embedded and keyword indexed,
  // so "returns" in the title helps a chunk that only says "30 days"
  indexText: string;
  archived: boolean; // true when the parent doc has been superseded
  supersedes?: string; // doc id this chunk's doc replaced
  effectiveFrom: string;
  url?: string;
}

export interface ScoredChunk {
  chunk: Chunk;
  score: number; // fused rrf score
  vectorScore: number | null; // cosine similarity to the question, computed for every chunk
  bm25Score: number | null;
}

export interface Citation {
  n: number; // number shown in the answer, [1], [2] ...
  chunkId: string;
  docId: string;
  title: string;
  section: string;
  quotes: string[]; // verified verbatim against the source text
  archived: boolean; // an older, superseded version shown to explain a change
  effectiveFrom: string;
  url?: string;
}

export type DeclineReason = "not_in_sources" | "off_topic" | "low_relevance" | "unverified" | "too_long";

export interface AskMeta {
  traceId: string;
  model: string;
  promptVersion: string;
  latencyMs: { rewrite: number; retrieve: number; generate: number; followUps?: number; total: number };
  tokens: { input: number; output: number };
  costUsd: number | null;
  rewrittenQuestion?: string;
  retrieved: { chunkId: string; score: number; vectorScore: number | null }[];
  citationsChecked: number;
  droppedCitations: number;
  sentencesTotal: number;
  sentencesCited: number; // sentences with at least one verified source
  langfuseTraceId?: string; // set when tracing is on, to attach scores
}

export interface AskResult {
  answer: string;
  answerable: boolean;
  declineReason?: DeclineReason;
  sources: Citation[];
  // suggested next questions, only on answered questions
  followUps: string[];
  meta: AskMeta;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}
