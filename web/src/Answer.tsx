import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { sendFeedback, type AskResult, type Citation } from "./api";

export type AnswerStatus = "streaming" | "done" | "error" | "stopped";

interface Props {
  text: string;
  status: AnswerStatus;
  result?: AskResult;
  supportEmail: string;
  // asks a suggested follow-up; undefined while another answer is streaming
  onAsk?: (question: string) => void;
  // staff view adds the technical breakdown of how the answer was made
  staff?: boolean;
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
          <dt>Sentences cited</dt>
          <dd>
            {m.sentencesCited} of {m.sentencesTotal} backed by a verified source
          </dd>
        </div>
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

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i);
}

// the model sends text in bursts (often a whole answer in about a second),
// which looks jumpy. this reveals text at a steady pace instead: about 120
// characters a second, speeding up gently when a large backlog builds so it never
// falls far behind. if the final text differs from what was streamed (e.g.
// an unverified citation removed), it rewinds to the common prefix and
// continues from there.
function useSmoothText(target: string): { text: string; typing: boolean } {
  const [shown, setShown] = useState("");
  const shownRef = useRef("");
  const targetRef = useRef(target);
  const frame = useRef<number | null>(null);
  targetRef.current = target;

  useEffect(() => {
    if (reducedMotion()) {
      shownRef.current = target;
      setShown(target);
      return;
    }
    if (frame.current !== null) return; // already animating towards the latest target
    let last = performance.now();
    let carry = 0;
    const step = (now: number) => {
      const t = targetRef.current;
      let s = shownRef.current;
      if (!t.startsWith(s)) s = commonPrefix(s, t);
      const backlog = t.length - s.length;
      if (backlog <= 0) {
        shownRef.current = s;
        setShown(s);
        frame.current = null;
        return;
      }
      const charsPerMs = Math.max(0.12, backlog / 2500);
      carry += (now - last) * charsPerMs;
      last = now;
      const n = Math.floor(carry);
      if (n > 0) {
        carry -= n;
        s = t.slice(0, s.length + n);
        shownRef.current = s;
        setShown(s);
      }
      frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  }, [target]);

  // stop on unmount. frame must be reset too: in development react mounts
  // components twice, and a stale frame id would stop typing ever starting
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    },
    [],
  );

  // never show half a citation marker such as "[1"
  return { text: shown.replace(/\[\d*$/, ""), typing: shown !== target };
}

// three brand-red dots growing in turn. purely decorative, so hidden from
// screen readers; the text beside them says what is happening
function Thinking() {
  return (
    <div className="thinking" role="status">
      <span className="stones" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>Looking through our guides and policies</span>
    </div>
  );
}

export function Answer({ text, status, result, supportEmail, onAsk, staff = false }: Props) {
  const [open, setOpen] = useState<number | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [feedback, setFeedback] = useState<"up" | "down" | "error" | null>(null);
  const smooth = useSmoothText(status === "error" ? "" : text);
  // sources and the footer appear once the text has finished typing out
  const settled = status === "done" && !smooth.typing;
  const stopped = status === "stopped";

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
      {!smooth.text && !settled && !stopped ? (
        <Thinking />
      ) : (
        <div className={`a-body${settled || stopped ? "" : " is-streaming"}`}>
          <Body text={smooth.text} onCite={toggle} active={open} />
        </div>
      )}

      {stopped && <p className="stopped">Stopped.</p>}

      {settled && declined && (result.declineReason === "not_in_sources" || result.declineReason === "unverified") && (
        <a className="mail" href={`mailto:${supportEmail}`}>
          Email the studio
        </a>
      )}

      {settled && result && result.sources.length > 0 && (
        <ol className="tags" aria-label="Sources">
          {result.sources.map((c) => (
            <SourceTag key={c.chunkId} c={c} open={open === c.n} onToggle={() => toggle(c.n)} />
          ))}
        </ol>
      )}

      {settled && result && result.followUps.length > 0 && (
        <div className="follow-ups">
          <h3>Related questions</h3>
          <ul className="chips">
            {result.followUps.map((f) => (
              <li key={f}>
                <button type="button" className="chip" onClick={() => onAsk?.(f)} disabled={!onAsk}>
                  {f}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {settled && result && (
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
          {staff && (
            <button type="button" className="link" onClick={() => setShowDetails((s) => !s)} aria-expanded={showDetails}>
              {showDetails ? "Hide details" : "How this answer was made"}
            </button>
          )}
        </div>
      )}
      {settled && result && staff && showDetails && <Details r={result} />}
    </article>
  );
}
