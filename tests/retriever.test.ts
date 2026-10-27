import { describe, expect, it } from "vitest";
import { chunkDocs } from "../src/kb/chunker.js";
import { loadDocs, parseDoc, validateLinks } from "../src/kb/loader.js";
import { settings } from "../src/config.js";
import { HashEmbedder } from "../src/retrieval/embeddings.js";
import { Retriever } from "../src/retrieval/retriever.js";
import { DEFAULT_RETRIEVAL } from "../src/kb/build.js";

// these tests run on the real knowledge base with an offline embedder,
// so they check structure and filtering, not semantic quality (that is the evals' job)

describe("knowledge base", () => {
  it("loads, validates links and chunks without errors", async () => {
    const docs = await loadDocs(settings.kbDir);
    expect(docs.length).toBeGreaterThanOrEqual(10);
    const ids = chunkDocs(docs, settings).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("rejects mismatched supersedes links", () => {
    const a = parseDoc("---\nid: a\ntitle: A\ntype: policy\neffective_from: 2025-01-01\nsuperseded_by: b\n---\nx", "a.md");
    const b = parseDoc("---\nid: b\ntitle: B\ntype: policy\neffective_from: 2026-01-01\n---\ny", "b.md");
    expect(() => validateLinks([a, b])).toThrow(/do not match/);
  });

  it("rejects bad frontmatter", () => {
    expect(() => parseDoc("---\nid: Bad Id\ntitle: A\ntype: policy\neffective_from: 2025-01-01\n---\nx", "a.md")).toThrow();
  });
});

describe("retriever", () => {
  it("never returns archived chunks as results, but offers them as history", async () => {
    const chunks = chunkDocs(await loadDocs(settings.kbDir), settings);
    const r = await Retriever.build(chunks, new HashEmbedder(), DEFAULT_RETRIEVAL);
    const { results, archived } = await r.search("how many days do I have to return an item returns policy");
    expect(results.length).toBe(DEFAULT_RETRIEVAL.topK);
    expect(results.every((x) => !x.chunk.archived)).toBe(true);
    expect(results.some((x) => x.chunk.docId === "returns-policy-2026")).toBe(true);
    expect(archived.map((c) => c.docId)).toContain("returns-policy-2025");
  });

  it("includes archived chunks when filtering is off (baseline)", async () => {
    const chunks = chunkDocs(await loadDocs(settings.kbDir), settings);
    const r = await Retriever.build(chunks, new HashEmbedder(), { ...DEFAULT_RETRIEVAL, filterArchived: false, mode: "bm25" });
    const { results, archived } = await r.search("returns policy 2025 store credit 14 days");
    expect(results.some((x) => x.chunk.archived)).toBe(true);
    expect(archived).toEqual([]);
  });
});

describe("addExtras", () => {
  const chunk = (id: string) => ({ id, docId: id.split("#")[0]! }) as unknown as import("../src/types.js").Chunk;
  const hit = (id: string) => ({ chunk: chunk(id), score: 0, vectorScore: 0.5, bm25Score: null });
  it("keeps the rewrite's results whole and adds the best new ones from the customer's words", async () => {
    const { addExtras } = await import("../src/retrieval/retriever.js");
    const merged = addExtras(
      { results: [hit("a#1"), hit("b#1")], bestSimilarity: 0.5, archived: [] },
      { results: [hit("b#1"), hit("c#1"), hit("d#1"), hit("e#1")], bestSimilarity: 0.7, archived: [chunk("old#1")] },
      2,
      2,
    );
    expect(merged.results.map((r) => r.chunk.id)).toEqual(["a#1", "b#1", "c#1", "d#1"]);
    expect(merged.bestSimilarity).toBe(0.7);
    expect(merged.archived.map((c) => c.id)).toEqual(["old#1"]);
  });
});
