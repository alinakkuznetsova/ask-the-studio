import { useEffect, useMemo, useState } from "react";
import { fetchEvals, type EvalCaseResult, type EvalReport } from "./api";

// human labelling, to check the llm judge. a person labels the answers from
// the latest eval run on the same three questions the judge answers, without
// seeing the judge's verdicts (so they cannot anchor on them). the labels are
// downloaded as evals/labels.json and `npm run eval:agreement` measures how
// often the judge agrees with the person.

type Verdict = boolean | null;
interface Label {
  id: string;
  answer: string; // labels match by answer text, so a changed answer is never mislabelled
  correct: Verdict;
  grounded: Verdict;
  focused: Verdict;
  note: string;
}

const QUESTIONS: { key: "correct" | "grounded" | "focused"; title: string; help: string }[] = [
  { key: "correct", title: "Correct", help: "All the key facts in the reference are there, and nothing is wrong." },
  { key: "grounded", title: "Supported", help: "Every claim is backed by the cited passages. A closing line pointing to the studio's email doesn't count." },
  { key: "focused", title: "Focused", help: "Sticks to the question: no extra offers, repetition or talk of sources." },
];

const storageKey = (runAt: string) => `ask-the-studio:labels:${runAt}`;

function load(runAt: string): Record<string, Label> {
  try {
    return JSON.parse(localStorage.getItem(storageKey(runAt)) ?? "{}") as Record<string, Label>;
  } catch {
    return {};
  }
}

function save(runAt: string, labels: Record<string, Label>) {
  try {
    localStorage.setItem(storageKey(runAt), JSON.stringify(labels));
  } catch {
    // ignore: labels still live in memory, and can be downloaded
  }
}

const done = (l?: Label) => !!l && l.correct !== null && l.grounded !== null && l.focused !== null;

function download(report: EvalReport, labels: Record<string, Label>) {
  const body = {
    labeller: "brand owner",
    labelledAt: new Date().toISOString(),
    runAt: report.runAt,
    promptVersion: report.promptVersion,
    labels: Object.values(labels).filter(done),
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "labels.json";
  a.click();
  URL.revokeObjectURL(url);
}

function YesNo({ value, onChange, label }: { value: Verdict; onChange: (v: boolean) => void; label: string }) {
  return (
    <span className="yesno" role="radiogroup" aria-label={label}>
      <button type="button" role="radio" aria-checked={value === true} className={value === true ? "is-on" : ""} onClick={() => onChange(true)}>
        Yes
      </button>
      <button type="button" role="radio" aria-checked={value === false} className={value === false ? "is-on" : ""} onClick={() => onChange(false)}>
        No
      </button>
    </span>
  );
}

export function LabelPage() {
  const [report, setReport] = useState<EvalReport | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [labels, setLabels] = useState<Record<string, Label>>({});
  const [i, setI] = useState(0);

  useEffect(() => {
    fetchEvals()
      .then((r) => {
        setReport(r);
        if (r) setLabels(load(r.runAt));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Couldn't load the eval report."));
  }, []);

  // only answers are labelled: the judge does not grade declines
  const items = useMemo<EvalCaseResult[]>(() => report?.results.filter((r) => r.answerable && r.judge && r.cited) ?? [], [report]);
  const labelledCount = items.filter((r) => done(labels[r.id]) && labels[r.id]!.answer === r.answer).length;

  if (error) return <main className="evals"><p className="empty">{error}</p></main>;
  if (report === undefined) return <main className="evals"><p className="empty">Loading…</p></main>;
  if (!report || !items.length) {
    return (
      <main className="evals">
        <h1>Check the judge</h1>
        <p className="empty">No answers to label yet. Run npm run eval first.</p>
      </main>
    );
  }

  const r = items[Math.min(i, items.length - 1)]!;
  const current: Label = labels[r.id]?.answer === r.answer ? labels[r.id]! : { id: r.id, answer: r.answer, correct: null, grounded: null, focused: null, note: "" };
  const update = (patch: Partial<Label>) => {
    const next = { ...labels, [r.id]: { ...current, ...patch } };
    setLabels(next);
    save(report.runAt, next);
  };

  return (
    <main className="evals label-page">
      <h1>Check the judge</h1>
      <p className="lede">
        Label each answer yourself. The judge's verdicts are hidden so they can't sway you. When you're done, download the labels and
        the agreement script compares them with the judge.
      </p>

      <div className="label-progress">
        <span>
          Answer {i + 1} of {items.length} · {labelledCount} labelled
        </span>
        <span className="label-bar" aria-hidden="true">
          <span style={{ width: `${(labelledCount / items.length) * 100}%` }} />
        </span>
      </div>

      <article className="label-card">
        <p className="label-meta">
          {r.id} · {r.category.replace("_", " ")}
        </p>
        {r.history?.length ? (
          <div className="label-history">
            <h2>Earlier in the conversation</h2>
            {r.history.map((t, n) => (
              <p key={n}>
                <span>{t.role === "user" ? "Customer" : "Studio"}:</span> {t.content}
              </p>
            ))}
          </div>
        ) : null}
        <div className="q-row">
          <p className="q">{r.question}</p>
        </div>

        <h2>Assistant's answer</h2>
        <p className="label-answer">{r.answer}</p>

        <h2>Reference answer, written by the brand</h2>
        <p className="label-ref">{r.reference ?? "Not saved in this report. Rerun the evals."}</p>

        <details className="label-sources" open>
          <summary>Passages the answer cited ({r.cited!.length})</summary>
          {r.cited!.map((c, n) => (
            <div key={n}>
              <p className="label-src-title">
                [{n + 1}] {c.title}
              </p>
              <p className="label-src-text">{c.text}</p>
            </div>
          ))}
        </details>

        <div className="label-qs">
          {QUESTIONS.map((q) => (
            <div key={q.key} className="label-q">
              <div>
                <p className="label-q-title">{q.title}</p>
                <p className="label-q-help">{q.help}</p>
              </div>
              <YesNo value={current[q.key]} onChange={(v) => update({ [q.key]: v })} label={q.title} />
            </div>
          ))}
          <label className="label-note">
            Note (optional)
            <input value={current.note} maxLength={300} onChange={(e) => update({ note: e.target.value })} placeholder="What's wrong, if anything" />
          </label>
        </div>

        <div className="label-nav">
          <button type="button" className="link" disabled={i === 0} onClick={() => setI(i - 1)}>
            Previous
          </button>
          <button type="button" className="chip" onClick={() => setI(Math.min(i + 1, items.length - 1))} disabled={i === items.length - 1}>
            {done(current) ? "Next" : "Skip"}
          </button>
        </div>
      </article>

      <p className="note">
        <button type="button" className="link" onClick={() => download(report, labels)} disabled={!labelledCount}>
          Download labels ({labelledCount})
        </button>{" "}
        then move the file to <code>evals/labels.json</code> and run <code>npm run eval:agreement</code>.
      </p>
    </main>
  );
}
