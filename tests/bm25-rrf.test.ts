import { describe, expect, it } from "vitest";
import { BM25, stem, tokenize } from "../src/retrieval/bm25.js";
import { rrf } from "../src/retrieval/rrf.js";

describe("tokenize", () => {
  it("keeps prices, drops stopwords, stems plurals", () => {
    expect(tokenize("The earrings are £225 in the set")).toEqual(["earring", "£225", "set"]);
  });
  it("stems common suffixes", () => {
    expect(stem("shipping")).toBe("ship");
    expect(stem("returns")).toBe("return");
    expect(stem("accessories")).toBe("accessory");
    expect(stem("glass")).toBe("glass");
  });
});

describe("BM25", () => {
  const index = new BM25(["returns within 30 days", "free shipping over £100", "pearl care guide"]);
  it("ranks the matching doc first", () => {
    expect(index.search("how much is shipping", 3)[0]![0]).toBe(1);
  });
  it("respects the allowed filter", () => {
    expect(index.search("shipping", 3, (i) => i !== 1)).toEqual([]);
  });
});

describe("rrf", () => {
  it("rewards items ranked well in both lists", () => {
    const fused = [...rrf([["a", "b", "c"], ["b", "c", "a"]]).keys()];
    expect(fused[0]).toBe("b");
  });
  it("includes items found by only one retriever", () => {
    expect(rrf([["a"], ["z"]]).has("z")).toBe(true);
  });
});
