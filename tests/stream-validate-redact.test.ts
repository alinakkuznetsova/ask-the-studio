import { describe, expect, it } from "vitest";
import { AnswerFieldStreamer, MarkerRewriter, rewriteMarkers } from "../src/answer/stream-parse.js";
import { leaksPrompt, validateCitations } from "../src/answer/validate.js";
import { redact } from "../src/server/redact.js";

describe("AnswerFieldStreamer", () => {
  it("decodes the answer field across arbitrary chunk boundaries", () => {
    const json = JSON.stringify({ answerable: true, decline_type: "none", answer: 'Say "hi"\nthen £5 é', citations: [] });
    for (const size of [1, 2, 3, 5, 13]) {
      const s = new AnswerFieldStreamer();
      let out = "";
      for (let i = 0; i < json.length; i += size) out += s.feed(json.slice(i, i + size));
      expect(out).toBe('Say "hi"\nthen £5 é');
    }
  });
});

describe("markers", () => {
  it("numbers labels by first appearance, across split deltas", () => {
    const r = new MarkerRewriter();
    const out = ["A [S", "3] b [S1", "] c [S3", "]"].map((d) => r.push(d)).join("") + r.flush();
    expect(out).toBe("A [1] b [2] c [1]");
  });
  it("expands comma lists and removes disallowed labels", () => {
    expect(rewriteMarkers("x [S1, S2] y [S9].", new Set(["S1", "S2"])).text).toBe("x [1][2] y.");
  });
});

describe("validateCitations", () => {
  const src = new Map([["S1", "Refunds are issued to your **original** payment method within 5 working days."]]);
  it("accepts verbatim quotes ignoring case, markdown and curly quotes", () => {
    const r = validateCitations([{ source: "S1", quote: "refunds are issued to your original payment method" }], src);
    expect(r.valid).toHaveLength(1);
  });
  it("rejects paraphrases and unknown sources", () => {
    const r = validateCitations(
      [
        { source: "S1", quote: "refunds go back to your card" },
        { source: "S7", quote: "anything" },
      ],
      src,
    );
    expect(r.valid).toHaveLength(0);
    expect(r.dropped).toBe(2);
  });
});

describe("leaksPrompt", () => {
  it("flags long verbatim runs from the system prompt", () => {
    expect(leaksPrompt("Sure: Ground every statement in the sources. Do not use outside knowledge")).toBe(true);
    expect(leaksPrompt("Our returns window is 30 days.")).toBe(false);
  });
});

describe("redact", () => {
  it("masks emails, phones, order numbers and postcodes", () => {
    const out = redact("I'm jo@x.com, 07700 900123, order 104233, #55821, SW1A 1AA");
    expect(out).toBe("I'm [email], [phone], order [order], [order], [postcode]");
  });
  it("leaves prices and sizes alone", () => {
    expect(redact("Is the £225 set in UK size O?")).toBe("Is the £225 set in UK size O?");
  });
});
