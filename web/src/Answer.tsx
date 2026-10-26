import { Fragment, useState, type ReactNode } from "react";
import { sendFeedback, type AskResult, type Citation } from "./api";

interface Props {
  text: string;
  status: "streaming" | "done" | "error";
  result?: AskResult;
  supportEmail: string;
}

// renders model text safely: react escapes everything, and we only recognise
// three things ourselves: citation markers [n], **bold**, and "- " lists.
// no html from the model is ever injected into the page.
function inline(text: string, onCite: (n: number) => void, active: number | null): ReactNode[] {
  return text.split(/(\[\d+\]|\*\*[^*]+\*\*)/g).map((part, i) => {
    const cite = part.match(/^\[(\d+)\]$/);
    if (cite) {
      const n = Number(cite[1]);
      return (
        <button
          key={i}
          type="button"
          className={`cite${active === n ? " is-active" : ""}`}
          onClick={() => onCite(n)}
          aria-label={`Source ${n}`}
        >
          {n}
        </button>
      );
    }
    if (/^\*\*[^*]+\*\*$/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

function Body({ text, onCite, active }: { text: string; onCite: (n: number) => void; active: number | null }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <>
      {blocks.map((block, bi) => {
        const lines = block.split("\n");
        if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
          return (
            <ul key={bi}>
              {lines.map((l, li) => (
                <li key={li}>{inline(l.replace(/^\s*[-*•]\s+/, ""), onCite, active)}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={bi}>
            {lines.map((l, li) => (
              <Fragment key={li}>
                {li > 0 && <br />}
                {inline(l, onCite, active)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

function SourceTag({ c, open, onToggle }: { c: Citation; open: boolean; onToggle: () => void }) {
  return (
    <li className={`tag${c.archived ? " is-archived" : ""}${open ? " is-open" : ""}`} id={`src-${c.chunkId}`}>
      <button type="button" className="tag-head" onClick={onToggle} aria-expanded={open}>
        <span className="tag-n">{c.n}</span>
        <span className="tag-title">
          {c.title}
          {c.section !== c.title && <span className="tag-section">{c.section}</span>}
        </span>
        <span className="tag-date">{c.archived ? "Replaced, shown to explain a change" : `In effect from ${formatDate(c.effectiveFrom)}`}</span>
      </button>
      {open && (
        <div className="tag-body">
          {c.quotes.map((q) => (
            <blockquote key={q}>{q}</blockquote>
          ))}
          <p className="tag-note">Checked word for word against the source.</p>
        </div>
      )}
    </li>
  );
}

function Details({ r }: { r: AskResult }) {
  const m = r.meta;
  const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  return (
    <div className="details">
      <dl>
        <div>
          <dt>Time</dt>
          <dd>
            {secs(m.latencyMs.total)} (search {m.latencyMs.retrieve}ms, writing {secs(m.latencyMs.generate)}
            {m.latencyMs.rewrite ? `, follow-up rewrite ${m.latencyMs.rewrite}ms` : ""})
          </dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>
            {m.costUsd === null ? "n/a" : `$${m.costUsd.toFixed(5)}`} ({m.tokens.input} in, {m.tokens.output} out)
          </dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>
            {m.model}, prompt {m.promptVersion}
          </dd>
        </div>
        {m.rewrittenQuestion && (
          <div>
            <dt>Searched for</dt>
            <dd>{m.rewrittenQuestion}</dd>
          </div>
        )}
        <div>
          <dt>Quotes checked</dt>
          <dd>
            {m.citationsChecked - m.droppedCitations} of {m.citationsChecked} verified
            {m.droppedCitations ? `, ${m.droppedCitations} removed` : ""}
          </dd>
        </div>
      </dl>
      {m.retrieved.length > 0 && (
        <>
          <p className="details-sub">Passages retrieved, best first</p>
          <ol className="retrieved">
            {m.retrieved.map((x) => (
              <li key={x.chunkId}>
                <code>{x.chunkId}</code>
                <span>
                  fused {x.score.toFixed(3)}
                  {x.vectorScore !== null && `, similarity ${x.vectorScore.toFixed(2)}`}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </div>
  );
}

export function Answer({ text, status, result, supportEmail }: Props) {
  const [open, setOpen] = useState<number | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [feedback, setFeedback] = useState<"up" | "down" | "error" | null>(null);

  const toggle = (n: number) => setOpen((cur) => (cur === n ? null : n));
  const declined = result && !result.answerable;

  async function rate(r: "up" | "down") {
    if (!result || feedback) return;
    setFeedback(r);
    try {
      await sendFeedback(result.meta.traceId, r);
    } catch {
      setFeedback("error");
    }
  }

  if (status === "error") {
    return (
      <article className="a is-error" role="alert">
        <p>{text}</p>
      </article>
    );
  }

  return (
    <article className={`a${declined ? " is-declined" : ""}`}>
      {status === "streaming" && !text ? (
        <p className="thinking">Looking through our guides and policies</p>
      ) : (
        <div className={`a-body${status === "streaming" ? " is-streaming" : ""}`}>
          <Body text={text} onCite={toggle} active={open} />
        </div>
      )}

      {declined && result.declineReason !== "off_topic" && (
        <a className="mail" href={`mailto:${supportEmail}`}>
          Email the studio
        </a>
      )}

      {result && result.sources.length > 0 && (
        <ol className="tags" aria-label="Sources">
          {result.sources.map((c) => (
            <SourceTag key={c.chunkId} c={c} open={open === c.n} onToggle={() => toggle(c.n)} />
          ))}
        </ol>
      )}

      {result && (
        <div className="a-foot">
          {feedback === null ? (
            <span className="rate">
              Was this helpful?
              <button type="button" className="link" onClick={() => void rate("up")}>
                Yes
              </button>
              <button type="button" className="link" onClick={() => void rate("down")}>
                No
              </button>
            </span>
          ) : (
            <span className="rate">{feedback === "error" ? "Feedback wasn't saved. The answer may have expired." : "Thanks, noted."}</span>
          )}
          <button type="button" className="link" onClick={() => setShowDetails((s) => !s)} aria-expanded={showDetails}>
            {showDetails ? "Hide details" : "How this answer was made"}
          </button>
        </div>
      )}
      {result && showDetails && <Details r={result} />}
    </article>
  );
}
