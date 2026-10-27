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

  // searches a follow-up with its rewrite first, then adds the best passages
  // for the customer's own words. the rewrite's results are kept whole, so a
  // real follow-up ("what about the SOLAR ones?") loses nothing; the extra
  // passages protect a complete new question from a rewrite that drifted
  // towards the previous topic. one model call should not be a single point
  // of failure for what gets retrieved.
  async searchFollowUp(rewritten: string, original: string, extra = 2): Promise<RetrievalResult> {
    if (!original.trim() || rewritten.trim() === original.trim()) return this.search(rewritten);
    const [primary, own] = await Promise.all([this.search(rewritten), this.search(original)]);
    return addExtras(primary, own, extra, this.config.archivedPerAnswer);
  }
}

// the primary results unchanged, then up to `extra` of the secondary's best
// passages that aren't already there. relevance is the best of the two, and
// archived passages attached to either are kept
export function addExtras(primary: RetrievalResult, secondary: RetrievalResult, extra: number, archivedLimit: number): RetrievalResult {
  const have = new Set(primary.results.map((r) => r.chunk.id));
  const added = secondary.results.filter((r) => !have.has(r.chunk.id)).slice(0, extra);
  const archived = [...primary.archived];
  for (const c of secondary.archived) if (!archived.some((a) => a.id === c.id)) archived.push(c);
  return {
    results: [...primary.results, ...added],
    bestSimilarity: Math.max(primary.bestSimilarity, secondary.bestSimilarity),
    archived: archived.slice(0, archivedLimit),
  };
}

// true when `current` comes from the doc that superseded `old`'s doc
function isReplacement(current: Chunk, old: Chunk): boolean {
  return !current.archived && current.supersedes === old.docId;
}
