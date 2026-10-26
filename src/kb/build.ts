import path from "node:path";
import OpenAI from "openai";
import { env, requireApiKey, settings } from "../config.js";
import { CachedEmbedder, OpenAIEmbedder, type Embedder } from "../retrieval/embeddings.js";
import { Retriever, type RetrievalConfig } from "../retrieval/retriever.js";
import type { Doc } from "../types.js";
import { chunkDocs } from "./chunker.js";
import { loadDocs } from "./loader.js";

export const DEFAULT_RETRIEVAL: RetrievalConfig = {
  mode: "hybrid",
  filterArchived: true,
  contextualHeaders: true,
  topK: settings.topK,
  candidates: settings.candidatesPerRetriever,
  rrfK: settings.rrfK,
  archivedPerAnswer: settings.archivedPerAnswer,
};

// the "before" configuration used in the readme comparison
export const BASELINE_RETRIEVAL: RetrievalConfig = {
  ...DEFAULT_RETRIEVAL,
  mode: "vector",
  filterArchived: false,
  contextualHeaders: false,
};

export function openaiClient(): OpenAI {
  // timeouts and retries are bounded so a slow upstream cannot pin requests open
  return new OpenAI({ apiKey: requireApiKey(), timeout: 30_000, maxRetries: 2 });
}

export interface KnowledgeIndex {
  docs: Doc[];
  retriever: Retriever;
  embedder: CachedEmbedder;
}

export async function buildIndex(
  config: RetrievalConfig = DEFAULT_RETRIEVAL,
  embedder?: Embedder,
): Promise<KnowledgeIndex> {
  const docs = await loadDocs(settings.kbDir);
  const chunks = chunkDocs(docs, settings);
  const inner = embedder ?? new OpenAIEmbedder(openaiClient(), env().EMBEDDING_MODEL);
  const cached = new CachedEmbedder(inner, path.join(settings.cacheDir, `embeddings-${inner.model}.json`));
  const retriever = await Retriever.build(chunks, cached, config);
  return { docs, retriever, embedder: cached };
}
