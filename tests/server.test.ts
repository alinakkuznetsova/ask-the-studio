import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.js";
import { FakeChat, labelFor, testRetriever } from "./helpers.js";

const retriever = await testRetriever();
const chat = new FakeChat((m) => {
  const s = labelFor(m, "orders delivered on or after 1 January 2026");
  return { answerable: true, decline_type: "none", answer: `30 days [${s}].`, citations: [{ source: s, quote: "within 30 days of delivery" }] };
});
const mk = (rate = 100) => createApp({ deps: { retriever, chat }, trustProxy: true, ratePerMinute: rate, dailyCap: 1000, docs: 31 });
const post = (app: ReturnType<typeof mk>, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "1.2.3.4", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("server", () => {
  it("answers POST /ask with answer and sources", async () => {
    const res = await post(mk(), "/ask", { question: "returns window days" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.answer).toBe("30 days [1].");
    expect(json.sources[0].docId).toBe("returns-policy-2026");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("sets security headers", async () => {
    const res = await mk().request("/health");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects non-json, bad json, empty and oversized questions", async () => {
    const app = mk();
    expect((await post(app, "/ask", "question=hi", { "content-type": "application/x-www-form-urlencoded" })).status).toBe(415);
    expect((await post(app, "/ask", "{oops")).status).toBe(400);
    expect((await post(app, "/ask", { question: "   " })).status).toBe(400);
    expect((await post(app, "/ask", { question: "x".repeat(501) })).status).toBe(400);
    expect((await post(app, "/ask", { question: "hi", extra: "x".repeat(20_000) })).status).toBe(413);
  });

  it("rate limits per client ip using the proxy-appended address", async () => {
    const app = mk(2);
    expect((await post(app, "/ask", { question: "returns" })).status).toBe(200);
    expect((await post(app, "/ask", { question: "returns" })).status).toBe(200);
    const limited = await post(app, "/ask", { question: "returns" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    // spoofing an earlier x-forwarded-for entry does not reset the limit
    expect((await post(app, "/ask", { question: "returns" }, { "x-forwarded-for": "9.9.9.9, 1.2.3.4" })).status).toBe(429);
    // a different real client is unaffected
    expect((await post(app, "/ask", { question: "returns" }, { "x-forwarded-for": "5.6.7.8" })).status).toBe(200);
  });

  it("streams deltas then a final result", async () => {
    const res = await post(mk(), "/ask/stream", { question: "returns window days" });
    const text = await res.text();
    expect(text).toContain("event: delta");
    expect(text).toContain("event: result");
    expect(text.indexOf("event: delta")).toBeLessThan(text.indexOf("event: result"));
  });

  it("only accepts feedback for answers it gave", async () => {
    const app = mk();
    const answer = await (await post(app, "/ask", { question: "returns window days" })).json();
    expect((await post(app, "/feedback", { traceId: answer.meta.traceId, rating: "down" })).status).toBe(200);
    expect((await post(app, "/feedback", { traceId: crypto.randomUUID(), rating: "up" })).status).toBe(404);
  });

  it("hides internals on unknown routes", async () => {
    const res = await mk().request("/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found", message: "Not found." });
  });
});
