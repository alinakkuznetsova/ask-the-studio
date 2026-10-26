import { useEffect, useState } from "react";
import { fetchEvals, type EvalReport, type EvalSummary } from "./api";

type Kind = "pct" | "num" | "ms" | "usd" | "count";

const METRICS: { key: keyof EvalSummary; label: string; kind: Kind; help: string; lowerIsBetter?: boolean }[] = [
  { key: "passRate", label: "Cases passed", kind: "pct", help: "Right decision, right facts, and judged correct and grounded." },
  { key: "retrievalRecall", label: "Right sources found", kind: "pct", help: "The documents needed were in the top 6 passages." },
  { key: "declineAccuracy", label: "Knew when to decline", kind: "pct", help: "Answered what it should, declined what it should." },
  { key: "factAccuracy", label: "Key facts correct", kind: "pct", help: "Required facts present, banned claims absent." },
  { key: "correctness", label: "Correctness (out of 5)", kind: "num", help: "An LLM judge compares each answer with a reference answer." },
  { key: "groundedness", label: "Fully supported by sources", kind: "pct", help: "The judge found every claim in the cited sources." },
  { key: "focus", label: "Focused answers", kind: "pct", help: "The judge found no padding, repetition or talk of sources." },
  { key: "quoteVerification", label: "Quotes verified", kind: "pct", help: "Quotes the model gave that matched the source word for word." },
  { key: "sentenceCoverage", label: "Sentences backed by a source", kind: "pct", help: "Answer sentences with at least one verified source." },
  { key: "citationPrecision", label: "Citations on target", kind: "pct", help: "Cited documents that are relevant to the question." },
  { key: "followUpAnswerRate", label: "Suggested follow-ups answered", kind: "pct", help: "Each suggested next question was asked for real." },
  { key: "falseAnswers", label: "Answered when it should decline", kind: "count", help: "The costly failure: made something up.", lowerIsBetter: true },
  { key: "falseDeclines", label: "Declined when it could answer", kind: "count", help: "Unhelpful, but safe.", lowerIsBetter: true },
  { key: "latencyP50", label: "Typical response time", kind: "ms", help: "Median, end to end.", lowerIsBetter: true },
  { key: "latencyP95", label: "Slow response time", kind: "ms", help: "95th percentile.", lowerIsBetter: true },
  { key: "costPerAnswerUsd", label: "Cost per answer", kind: "usd", help: "Model tokens at list price.", lowerIsBetter: true },
];

const CATEGORY_NAMES: Record<string, string> = {
  straightforward: "Straightforward",
  multi_doc: "Needs several documents",
  conflict: "Conflicting or outdated sources",
  realistic: "Written the way customers write",
  conversation: "Follow-ups in a conversation",
  unanswerable: "Not in the sources",
  off_script: "Off-topic and manipulation",
  red_team: "Security attacks",
};

function fmt(v: number | null | undefined, kind: Kind): string {
  if (v === null || v === undefined) return "n/a";
  switch (kind) {
    case "pct":
      return `${Math.round(v * 100)}%`;
    case "num":
      return v.toFixed(2);
    case "ms":
      return `${(v / 1000).toFixed(1)}s`;
    case "usd":
      return `$${v.toFixed(4)}`;
    case "count":
      return String(v);
  }
}

function change(a: number | null | undefined, b: number | null | undefined, kind: Kind, lowerIsBetter?: boolean) {
  if (typeof a !== "number" || typeof b !== "number") return null;
  const d = b - a;
  if (Math.abs(d) < 1e-9) return { text: "no change", tone: "flat" };
  const better = lowerIsBetter ? d < 0 : d > 0;
  const text =
    kind === "pct"
      ? `${d > 0 ? "+" : ""}${Math.round(d * 100)} pts`
      : kind === "ms"
        ? `${d > 0 ? "+" : ""}${(d / 1000).toFixed(1)}s`
        : kind === "usd"
          ? `${d > 0 ? "+" : ""}$${d.toFixed(4)}`
          : `${d > 0 ? "+" : ""}${kind === "num" ? d.toFixed(2) : d}`;
  return { text, tone: better ? "up" : "down" };
}

export function Evals() {
  const [report, setReport] = useState<EvalReport | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [openCase, setOpenCase] = useState<string | null>(null);

  useEffect(() => {
    fetchEvals().then(setReport, (e: Error) => setError(e.message));
  }, []);

  if (error) return <main className="evals"><p className="empty">{error}</p></main>;
  if (report === undefined) return <main className="evals"><p className="empty">Loading the latest report</p></main>;
  if (report === null) {
    return (
      <main className="evals">
        <h1>How it's tested</h1>
        <p className="empty">
          No eval report yet. Run <code>npm run eval:baseline</code> and <code>npm run eval</code>, then refresh this page.
        </p>
      </main>
    );
  }

  const s = report.summary;
  const base = report.baseline?.summary;
  const cases = report.results.filter((r) => !onlyFailed || !r.pass);
  const failed = report.results.filter((r) => !r.pass).length;

  return (
    <main className="evals">
      <h1>How it's tested</h1>
      <p className="lede">
        {s.cases} questions written to catch the ways a support assistant goes wrong: outdated policies, sources that disagree, questions
        our documents can't answer, and attempts to make it misbehave. Each run is scored automatically.
      </p>
      <p className="run-meta">
        Last run {new Date(report.runAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}, chat model {report.models.chat},
        judged by {report.models.judge}, prompt {report.promptVersion}. <a href="#/label">Check the judge against your own labels</a>
      </p>

      <section aria-labelledby="results-title">
        <h2 id="results-title">Results</h2>
        {base && (
          <p className="note">
            The baseline is the simple version: meaning-based search only, with old policy versions mixed in. The current system adds
            keyword search, keeps outdated versions out of answers, and labels every passage with its document and section.
          </p>
        )}
        <div className="table-wrap">
          <table className="metrics">
            <thead>
              <tr>
                <th scope="col">Measure</th>
                {base && <th scope="col">Baseline</th>}
                <th scope="col">Current</th>
                {base && <th scope="col">Change</th>}
              </tr>
            </thead>
            <tbody>
              {METRICS.map((m) => {
                const c = base ? change(base[m.key] as number | null, s[m.key] as number | null, m.kind, m.lowerIsBetter) : null;
                return (
                  <tr key={m.key}>
                    <th scope="row">
                      {m.label}
                      <span className="help">{m.help}</span>
                    </th>
                    {base && <td>{fmt(base[m.key] as number | null, m.kind)}</td>}
                    <td className="strong">{fmt(s[m.key] as number | null, m.kind)}</td>
                    {base && <td className={`chg ${c?.tone ?? ""}`}>{c?.text ?? ""}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="cat-title">
        <h2 id="cat-title">By type of question</h2>
        <div className="table-wrap">
          <table className="metrics">
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Questions</th>
                {base && <th scope="col">Baseline</th>}
                <th scope="col">Current</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(s.byCategory).map(([cat, v]) => (
                <tr key={cat}>
                  <th scope="row">{CATEGORY_NAMES[cat] ?? cat}</th>
                  <td>{v.cases}</td>
                  {base && <td>{fmt(base.byCategory[cat]?.passRate, "pct")}</td>}
                  <td className="strong">{fmt(v.passRate, "pct")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="cases-title">
        <div className="cases-head">
          <h2 id="cases-title">Every question</h2>
          <label className="filter">
            <input type="checkbox" checked={onlyFailed} onChange={(e) => setOnlyFailed(e.target.checked)} disabled={!failed} />
            Show only the {failed} that failed
          </label>
        </div>
        <ul className="cases">
          {cases.map((r) => {
            const isOpen = openCase === r.id;
            return (
              <li key={r.id} className={r.pass ? "pass" : "fail"}>
                <button type="button" className="case-head" onClick={() => setOpenCase(isOpen ? null : r.id)} aria-expanded={isOpen}>
                  <span className="mark" aria-label={r.pass ? "Passed" : "Failed"}>
                    {r.pass ? "✓" : "✗"}
                  </span>
                  <span className="case-q">{r.question}</span>
                  <span className="case-cat">{CATEGORY_NAMES[r.category] ?? r.category}</span>
                </button>
                {isOpen && (
                  <div className="case-body">
                    <p className="case-answer">{r.error ? `Error: ${r.error}` : r.answer}</p>
                    <dl>
                      <div>
                        <dt>Expected</dt>
                        <dd>{r.expect === "answer" ? "An answer" : r.expect === "decline" ? "A decline" : "A decline, or a partial answer pointing to the studio"}</dd>
                      </div>
                      <div>
                        <dt>Decision</dt>
                        <dd>{r.declineCorrect ? "Correct" : r.answerable ? "Answered when it should have declined" : "Declined when it should have answered"}</dd>
                      </div>
                      {r.retrievalRecall !== null && (
                        <div>
                          <dt>Sources found</dt>
                          <dd>{fmt(r.retrievalRecall, "pct")} of the needed documents</dd>
                        </div>
                      )}
                      {r.factsPass !== null && (
                        <div>
                          <dt>Key facts</dt>
                          <dd>{r.factsPass ? "All correct" : r.factFailures.join("; ")}</dd>
                        </div>
                      )}
                      {r.judge && (
                        <div>
                          <dt>Judge</dt>
                          <dd>
                            {r.judge.correctness}/5, {r.judge.grounded ? "supported by sources" : "not fully supported"}
                            {r.judge.focused ? "" : ", unfocused"}. {r.judge.reason}
                          </dd>
                        </div>
                      )}
                      {r.sources.length > 0 && (
                        <div>
                          <dt>Cited</dt>
                          <dd>{r.sources.join(", ")}</dd>
                        </div>
                      )}
                    </dl>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}
