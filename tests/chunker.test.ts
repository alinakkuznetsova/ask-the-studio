import { describe, expect, it } from "vitest";
import { chunkDoc, packSections } from "../src/kb/chunker.js";
import type { Doc } from "../src/types.js";

const opts = { wholeDocMaxWords: 20, sectionMinWords: 5, sectionMaxWords: 30 };

function doc(body: string, extra: Partial<Doc> = {}): Doc {
  return { id: "d", title: "Doc", type: "policy", effectiveFrom: "2026-01-01", body, path: "d.md", ...extra };
}

describe("chunkDoc", () => {
  it("keeps short docs whole and drops the h1", () => {
    const chunks = chunkDoc(doc("# Doc\n\nShort body."), opts);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.id).toBe("d#all");
    expect(chunks[0]!.text).toBe("Short body.");
  });

  it("splits long docs on h2 headings with a contextual header", () => {
    const body = "# Doc\n\n## Alpha\none two three four five six\n\n## Beta\nseven eight nine ten eleven twelve thirteen fourteen fifteen";
    const chunks = chunkDoc(doc(body), opts);
    expect(chunks.map((c) => c.section)).toEqual(["Alpha", "Beta"]);
    expect(chunks[0]!.indexText.startsWith("Doc > Alpha")).toBe(true);
    expect(chunks[0]!.text).not.toContain("Doc > Alpha");
  });

  it("keeps a policy whole up to its own limit, but splits other long docs", () => {
    const body = "# Doc\n\n## Alpha\none two three four five six\n\n## Beta\nseven eight nine ten eleven twelve thirteen fourteen fifteen";
    const withPolicyLimit = { ...opts, wholePolicyMaxWords: 50 };
    expect(chunkDoc(doc(body), withPolicyLimit)).toHaveLength(1);
    expect(chunkDoc(doc(body, { type: "guide" }), withPolicyLimit)).toHaveLength(2);
  });

  it("marks superseded docs as archived in the header and flag", () => {
    const chunks = chunkDoc(doc("old policy", { supersededBy: "new" }), opts);
    expect(chunks[0]!.archived).toBe(true);
    expect(chunks[0]!.indexText).toContain("archived");
  });

  it("gives every chunk a unique id", () => {
    const body = "## Same\n" + "w ".repeat(25) + "\n\n## Same\n" + "x ".repeat(25);
    const ids = chunkDoc(doc(body), opts).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("packSections", () => {
  it("merges small sections forward and folds a small tail back", () => {
    const out = packSections(
      [
        { heading: "Overview", text: "tiny" },
        { heading: "A", text: "one two three four five" },
        { heading: "B", text: "six" },
      ],
      5,
      30,
    );
    expect(out.map((s) => s.heading)).toEqual(["A; B"]);
  });
});
