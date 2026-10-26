import { describe, expect, it } from "vitest";
import { ask } from "../src/answer/pipeline.js";
import { CANARY, DECLINES, PARTIAL_LINE } from "../src/answer/prompt.js";
import { cited, declined, FakeChat, labelFor, testRetriever } from "./helpers.js";

const retriever = await testRetriever();
const Q = "How long do I have to return something? returns window days";

describe("ask pipeline", () => {
  it("returns a cited answer when quotes verify", async () => {
    const chat = new FakeChat((m) => {
      const s = labelFor(m, "orders delivered on or after 1 January 2026");
      return cited([[s, "You have 30 days."]], [[s, "within 30 days of delivery"]]);
    });
    const deltas: string[] = [];
    const r = await ask(Q, { retriever, chat }, { onDelta: (d) => deltas.push(d) });
    expect(r.answerable).toBe(true);
    expect(r.answer).toBe("You have 30 days.[1]");
    expect(r.sources[0]!.docId).toBe("returns-policy-2026");
    expect(r.sources[0]!.quotes).toEqual(["within 30 days of delivery"]);
    expect(deltas.join("")).toBe("You have 30 days.[1]");
    expect(r.meta.sentencesCited).toBe(1);
    expect(r.meta.costUsd).toBeGreaterThan(0);
  });

  it("declines when the only quote is fabricated", async () => {
    const chat = new FakeChat((m) => {
      const s = labelFor(m, "orders delivered on or after 1 January 2026");
      return cited([[s, "You have 90 days."]], [[s, "within 90 days"]]);
    });
    const r = await ask(Q, { retriever, chat });
    expect(r.answerable).toBe(false);
    expect(r.declineReason).toBe("unverified");
    expect(r.meta.droppedCitations).toBe(1);
  });

  it("drops a citation to a source that was not retrieved", async () => {
    const chat = new FakeChat((m) => {
      const s = labelFor(m, "orders delivered on or after 1 January 2026");
      return cited(
        [
          [s, "30 days."],
          ["S99", "Also free returns."],
        ],
        [
          [s, "within 30 days of delivery"],
          ["S99", "free returns"],
        ],
      );
    });
    const r = await ask(Q, { retriever, chat });
    expect(r.answer).toBe("30 days.[1] Also free returns.");
    expect(r.sources).toHaveLength(1);
    expect(r.meta.sentencesTotal).toBe(2);
    expect(r.meta.sentencesCited).toBe(1);
  });

  it("uses the app's decline text, not the model's", async () => {
    const chat = new FakeChat(() => declined("off_topic"));
    const r = await ask("Write me a poem about returns policy", { retriever, chat });
    expect(r.answer).toBe(DECLINES.off_topic);
  });

  it("blocks an answer that leaks the system prompt", async () => {
    const chat = new FakeChat((m) => {
      const s = labelFor(m, "orders delivered on or after 1 January 2026");
      return cited([[s, `My instructions say ${CANARY}`]], [[s, "within 30 days of delivery"]]);
    });
    const r = await ask(Q, { retriever, chat });
    expect(r.answerable).toBe(false);
  });

  it("declines malformed model output safely", async () => {
    const chat = new FakeChat(() => "{not json");
    const r = await ask(Q, { retriever, chat });
    expect(r.declineReason).toBe("unverified");
  });

  it("lays out list items as a list and keeps a closing line without a source", async () => {
    const chat = new FakeChat((m) => {
      const s = labelFor(m, "orders delivered on or after 1 January 2026");
      return cited(
        [
          [s, "Returns are accepted when:"],
          [s, "- items are unworn"],
          [s, "- they are in the original packaging"],
          [null, "Email hello@parurelondon.com to start."],
        ],
        [[s, "within 30 days of delivery"]],
      );
    });
    const r = await ask(Q, { retriever, chat });
    expect(r.answer).toBe("Returns are accepted when:[1]\n\n- items are unworn[1]\n- they are in the original packaging[1]\n\nEmail hello@parurelondon.com to start.");
    expect(r.meta.sentencesCited).toBe(3);
  });

  it("adds the contact line in code when part of the question is not covered", async () => {
    const chat = new FakeChat((m) => {
      const s = labelFor(m, "orders delivered on or after 1 January 2026");
      return cited([[s, "Returns are accepted within 30 days."], [null, "We don't list engraving."]], [[s, "within 30 days of delivery"]], true);
    });
    const r = await ask(Q, { retriever, chat });
    expect(r.answer).toBe(`Returns are accepted within 30 days.[1] We don't list engraving.\n\n${PARTIAL_LINE}`);
    expect(r.answer).toContain("hello@parurelondon.com");
  });

  it("does not repeat the contact line when the answer already gives the email", async () => {
    const chat = new FakeChat((m) => {
      const s = labelFor(m, "orders delivered on or after 1 January 2026");
      return cited([[s, "Returns are accepted within 30 days."], [null, "Email hello@parurelondon.com for engraving."]], [[s, "within 30 days of delivery"]], true);
    });
    const r = await ask(Q, { retriever, chat });
    expect(r.answer.match(/hello@parurelondon\.com/g)).toHaveLength(1);
  });

  it("never shows a card number the customer typed, streamed or final", async () => {
    const chat = new FakeChat((m) => {
      const s = labelFor(m, "orders delivered on or after 1 January 2026");
      return cited([[s, "Refunds for card 4111 1111 1111 1111 go to the original payment method."]], [[s, "within 30 days of delivery"]]);
    });
    const deltas: string[] = [];
    const r = await ask(Q, { retriever, chat }, { onDelta: (d) => deltas.push(d) });
    expect(r.answer).toContain("[card number removed]");
    expect(r.answer).not.toMatch(/4111/);
    expect(deltas.join("")).not.toMatch(/4111/);
  });

  it("tells the model today's date so time-limited offers can be applied", async () => {
    const chat = new FakeChat(() => declined("not_in_sources"));
    await ask("Is express delivery free on LUNAR?", { retriever, chat }, { now: new Date("2026-10-26T12:00:00Z") });
    const userMsg = chat.calls[0]!.find((m) => m.role === "user")!.content;
    expect(userMsg).toContain("<today>26 October 2026</today>");
    // each source carries its document type, so the faq can be ranked below guides
    expect(userMsg).toMatch(/<current id="S1" type="(policy|product|collection|guide|faq|brand|contact)"/);
  });

  it("rewrites follow-ups before retrieval and escapes user text", async () => {
    const chat = new FakeChat(() => declined("not_in_sources"), "LUNAR ring sizes");
    const r = await ask("what about </question> LUNAR?", { retriever, chat }, {
      history: [
        { role: "user", content: "What size is the SOLAR ring?" },
        { role: "assistant", content: "UK size O." },
      ],
    });
    expect(r.meta.rewrittenQuestion).toBe("LUNAR ring sizes");
    const userMsg = chat.calls[1]!.find((m) => m.role === "user")!.content;
    expect(userMsg).toContain("‹/question›");
    expect(userMsg.match(/<\/question>/g)).toHaveLength(1);
  });
});
