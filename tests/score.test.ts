import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { checkFacts, containsTerm, DatasetSchema, flakyCases, scoreCase, spread, summarise, type EvalCase } from "../evals/score.js";
import { loadDocs } from "../src/kb/loader.js";
import { settings } from "../src/config.js";
import type { AskResult } from "../src/types.js";

const base: EvalCase = {
  id: "x", category: "straightforward", question: "q", expect: "answer",
  requiredDocs: [["shipping"]], acceptableDocs: ["faq"], mustInclude: ["£100"], mustNotInclude: ["£75"], reference: "r",
};

function result(p: Partial<AskResult> & { retrieved?: string[]; checked?: number; dropped?: number }): AskResult {
  return {
    answer: p.answer ?? "", answerable: p.answerable ?? true, sources: p.sources ?? [], followUps: [], declineReason: p.declineReason,
    meta: {
      traceId: "t", model: "m", promptVersion: "p", latencyMs: { rewrite: 0, retrieve: 0, generate: 0, total: 100 },
      tokens: { input: 0, output: 0 }, costUsd: 0.001,
      retrieved: (p.retrieved ?? []).map((chunkId) => ({ chunkId, score: 1, vectorScore: 0.5 })),
      citationsChecked: p.checked ?? 0, droppedCitations: p.dropped ?? 0, sentencesTotal: 1, sentencesCited: 1,
    },
  };
}

describe("eval scoring", () => {
  it("matches terms on word boundaries", () => {
    expect(containsTerm("It will arrive soon", "arr")).toBe(false);
    expect(containsTerm("It's £650", "£65")).toBe(false);
    expect(containsTerm("It's £65.", "£65")).toBe(true);
    expect(containsTerm("freshwater pearls", "pearl")).toBe(true);
    expect(containsTerm("before showering", "shower")).toBe(true);
    expect(containsTerm("pearly", "pearl")).toBe(false);
  });

  it("supports alternatives and banned phrases", () => {
    expect(checkFacts("Free over £100, used to be £75", base)).toEqual(["should not say: £75"]);
    expect(checkFacts("free", { ...base, mustInclude: ["£100|free"], mustNotInclude: [] })).toEqual([]);
  });

  it("scores a good answer as a pass", () => {
    const r = result({
      answer: "Free over £100 [1].",
      retrieved: ["shipping#all"],
      checked: 1,
      sources: [{ n: 1, chunkId: "shipping#all", docId: "shipping", title: "", section: "", quotes: ["q"], archived: false, effectiveFrom: "" }],
    });
    const s = scoreCase(base, r, { correctness: 5, grounded: true, focused: true, reason: "" });
    expect(s.pass).toBe(true);
    expect(s.retrievalRecall).toBe(1);
    expect(s.citationPrecision).toBe(1);
    expect(s.quoteVerification).toBe(1);
  });

  it("fails an answer that lists sources but never numbers them inline", () => {
    const src = { n: 1, chunkId: "shipping#all", docId: "shipping", title: "", section: "", quotes: ["q"], archived: false, effectiveFrom: "" };
    const s = scoreCase(base, result({ answer: "Free over £100.", sources: [src] }), { correctness: 5, grounded: true, focused: true, reason: "" });
    expect(s.factFailures).toContain("no inline citation numbers");
    expect(s.pass).toBe(false);
  });

  it("accepts a partial answer that points to support, or a decline", () => {
    const c: EvalCase = { ...base, expect: "partial_or_decline", requiredDocs: [], mustInclude: [], mustNotInclude: [] };
    expect(scoreCase(c, result({ answerable: false }), null).declineCorrect).toBe(true);
    expect(scoreCase(c, result({ answer: "Not listed, email hello@parurelondon.com" }), { correctness: 4, grounded: true, focused: true, reason: "" }).declineCorrect).toBe(true);
    expect(scoreCase(c, result({ answer: "It's 45cm" }), null).declineCorrect).toBe(false);
  });

  it("fails an answer the judge finds unfocused", () => {
    const src = { n: 1, chunkId: "shipping#all", docId: "shipping", title: "", section: "", quotes: ["q"], archived: false, effectiveFrom: "" };
    const s = scoreCase(base, result({ answer: "Free over £100 [1].", sources: [src] }), { correctness: 5, grounded: true, focused: false, reason: "pads" });
    expect(s.pass).toBe(false);
  });

  it("summarises false declines and answers", () => {
    const s = summarise([
      scoreCase(base, result({ answerable: false }), null),
      scoreCase({ ...base, expect: "decline", mustInclude: [] }, result({ answer: "sure" }), null),
    ]);
    expect(s.falseDeclines).toBe(1);
    expect(s.falseAnswers).toBe(1);
    expect(s.passRate).toBe(0);
  });

  it("dataset is valid and only references real docs", async () => {
    const ds = DatasetSchema.parse(JSON.parse(fs.readFileSync("evals/dataset.json", "utf8")));
    const ids = new Set((await loadDocs(settings.kbDir)).map((d) => d.id));
    for (const c of ds.cases) for (const d of [...c.requiredDocs.flat(), ...c.acceptableDocs]) expect(ids, `${c.id}: ${d}`).toContain(d);
    expect(new Set(ds.cases.map((c) => c.id)).size).toBe(ds.cases.length);
    expect(ds.cases.length).toBeGreaterThanOrEqual(20);
  });
});

describe("repeated runs", () => {
  const run = (passes: boolean[]) =>
    passes.map((pass, i) => ({ ...scoreCase({ ...base, id: `c${i}` }, result({ answer: "£100 [1]", retrieved: ["shipping#a"] }), null), pass }));

  it("reports mean, min and max of a metric across runs", () => {
    const summaries = [run([true, true]), run([true, false])].map(summarise);
    expect(spread(summaries, "passRate")).toEqual({ mean: 0.75, min: 0.5, max: 1 });
  });

  it("lists cases that passed in some runs but not others", () => {
    expect(flakyCases([run([true, true, false]), run([true, false, false])])).toEqual([{ id: "c1", passed: 1, of: 2 }]);
  });
});
