import type { Chunk, ScoredChunk } from "../types.js";
import { BM25 } from "./bm25.js";
import { CachedEmbedder, cosine, type Embedder } from "./embeddings.js";
import { rrf } from "./rrf.js";

export interface RetrievalConfig {
  mode: "hybrid" | "vector" | "bm25";
  // archived (superseded) docs are kept in the index but excluded from the
  // main results, so an old policy can never be presented as current
  filterArchived: boolean;
  // embed "title > section + text" instead of the bare text
  contextualHeaders: boolean;
  topK: number;
  candidates: number;
  rrfK: number;
  archivedPerAnswer: number;
}

export interface RetrievalResult {
  results: ScoredChunk[];
  // best cosine similarity across current chunks, used to decline early
  bestSimilarity: number;
  // superseded versions related to the question, passed to the model only
  // so it can explain what changed. never cited as current policy.
  archived: Chunk[];
}

export class Retriever {
  private constructor(
    readonly chunks: Chunk[],
    private vectors: number[][],
    private bm25: BM25,
    private embedder: Embedder,
    readonly config: RetrievalConfig,
  ) {}

  static async build(chunks: Chunk[], embedder: Embedder, config: RetrievalConfig): Promise<Retriever> {
    const texts = chunks.map((c) => (config.contextualHeaders ? c.indexText : c.text));
    const vectors = await embedder.embed(texts);
    const bm25 = new BM25(texts);
    return new Retriever(chunks, vectors, bm25, embedder, config);
  }

  private async embedQuery(q: string): Promise<number[]> {
    const vecs =
      this.embedder instanceof CachedEmbedder
        ? await this.embedder.embedEphemeral([q])
        : await this.embedder.embed([q]);
    return vecs[0]!;
  }

  async search(query: string): Promise<RetrievalResult> {
    const cfg = this.config;
    const isCurrent = (i: number) => !cfg.filterArchived || !this.chunks[i]!.archived;

    // vector similarities are needed for the relevance gate even in bm25 mode
    const qv = await this.embedQuery(query);
    const sims = this.vectors.map((v) => cosine(qv, v));

    const vectorRanked = sims
      .map((s, i) => [i, s] as [number, number])
      .filter(([i]) => isCurrent(i))
      .sort((a, b) => b[1] - a[1])
      .slice(0, cfg.candidates);
    const bm25Ranked = this.bm25.search(query, cfg.candidates, isCurrent);

    const lists: string[][] = [];
    if (cfg.mode !== "bm25") lists.push(vectorRanked.map(([i]) => this.chunks[i]!.id));
    if (cfg.mode !== "vector") lists.push(bm25Ranked.map(([i]) => this.chunks[i]!.id));
    const fused = rrf(lists, cfg.rrfK);

    const indexById = new Map(this.chunks.map((c, i) => [c.id, i]));
    const bm25ById = new Map(bm25Ranked.map(([i, s]) => [this.chunks[i]!.id, s]));
    const results: ScoredChunk[] = [...fused.entries()].slice(0, cfg.topK).map(([id, score]) => {
      const i = indexById.get(id)!;
      return { chunk: this.chunks[i]!, score, vectorScore: sims[i]!, bm25Score: bm25ById.get(id) ?? null };
    });

    const bestSimilarity = vectorRanked[0]?.[1] ?? 0;

    // for each current doc in the results that replaced an older one, attach
    // the archived chunk that best matches the question
    const archived: Chunk[] = [];
    if (cfg.filterArchived && cfg.archivedPerAnswer > 0) {
      const replacedDocs = new Set(
        this.chunks
          .filter((c) => c.archived && results.some((r) => isReplacement(r.chunk, c)))
          .map((c) => c.docId),
      );
      for (const docId of replacedDocs) {
        const best = this.chunks
          .map((c, i) => [c, sims[i]!] as const)
          .filter(([c]) => c.docId === docId)
          .sort((a, b) => b[1] - a[1])[0];
        if (best) archived.push(best[0]);
        if (archived.length >= cfg.archivedPerAnswer) break;
      }
    }

    return { results, bestSimilarity, archived };
  }

  // searches with several phrasings of one question and fuses the results.
  // used for follow-ups: the rewritten question finds what "and the LUNAR
  // one?" refers to, while the customer's own words protect against a
  // rewrite that drifts towards the previous topic. one model call should
  // not be a single point of failure for what gets retrieved.
  async searchAll(queries: string[]): Promise<RetrievalResult> {
    const unique = [...new Set(queries.map((q) => q.trim()).filter(Boolean))];
    if (unique.length <= 1) return this.search(unique[0] ?? "");
    const runs = await Promise.all(unique.map((q) => this.search(q)));
    return mergeResults(runs, this.config.topK, this.config.rrfK, this.config.archivedPerAnswer);
  }
}

// fuses several result lists by rank (rrf again), keeping each chunk's best
// similarity, the best relevance across queries, and the archived passages
// attached to any of them
export function mergeResults(runs: RetrievalResult[], topK: number, rrfK: number, archivedLimit: number): RetrievalResult {
  const byId = new Map<string, ScoredChunk>();
  for (const run of runs) {
    for (const r of run.results) {
      const seen = byId.get(r.chunk.id);
      if (!seen || (r.vectorScore ?? 0) > (seen.vectorScore ?? 0)) byId.set(r.chunk.id, r);
    }
  }
  const fused = rrf(runs.map((run) => run.results.map((r) => r.chunk.id)), rrfK);
  const results = [...fused.entries()].slice(0, topK).map(([id, score]) => ({ ...byId.get(id)!, score }));
  const archived: Chunk[] = [];
  for (const run of runs) for (const c of run.archived) if (!archived.some((a) => a.id === c.id)) archived.push(c);
  return {
    results,
    bestSimilarity: Math.max(...runs.map((run) => run.bestSimilarity)),
    archived: archived.slice(0, archivedLimit),
  };
}

// true when `current` comes from the doc that superseded `old`'s doc
function isReplacement(current: Chunk, old: Chunk): boolean {
  return !current.archived && current.supersedes === old.docId;
}
