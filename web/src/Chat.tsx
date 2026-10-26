import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { askStream, type AskResult, type Turn } from "./api";
import { Answer, type AnswerStatus } from "./Answer";

const MAX_CHARS = 500;
const SUPPORT_EMAIL = "hello@parurelondon.com";

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  status: AnswerStatus;
  result?: AskResult;
}

// the page opens as a conversation: the studio says hello, with a few topics
// for people who don't know where to start, and the box at the bottom types
// out examples of what can be asked
const TOPICS = [
  { label: "Returns", question: "How do returns work?" },
  { label: "Delivery", question: "How does delivery work and how long does it take?" },
  { label: "Caring for your jewellery", question: "How should I care for my jewellery?" },
  { label: "Choosing a gift", question: "I'm buying a gift. How do I choose between the collections?" },
];

const EXAMPLES = [
  "Can I wear the rings in the shower?",
  "Is the silver hypoallergenic?",
  "How do I return a gift?",
  "How much do I save buying the MARINE set?",
];
const STILL_PLACEHOLDER = "Ask about a piece, an order or a policy";

// types an example out letter by letter, holds it, clears it and moves to
// the next. only runs while the box is empty and not focused, and never for
// people who have asked their system for reduced motion
function useTypedExample(active: boolean): string {
  const [text, setText] = useState("");
  useEffect(() => {
    if (!active) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setText(EXAMPLES[0]!);
      return;
    }
    let i = 0;
    let n = 0;
    let erasing = false;
    let timer: number;
    const tick = () => {
      const target = EXAMPLES[i]!;
      if (!erasing) {
        n++;
        setText(target.slice(0, n));
        if (n === target.length) {
          erasing = true;
          timer = window.setTimeout(tick, 1800);
          return;
        }
        timer = window.setTimeout(tick, 45 + Math.random() * 40);
      } else {
        n = Math.max(0, n - 3);
        setText(target.slice(0, n));
        if (n === 0) {
          erasing = false;
          i = (i + 1) % EXAMPLES.length;
          timer = window.setTimeout(tick, 400);
          return;
        }
        timer = window.setTimeout(tick, 20);
      }
    };
    timer = window.setTimeout(tick, 600);
    return () => window.clearTimeout(timer);
  }, [active]);
  return active ? text : STILL_PLACEHOLDER;
}

let counter = 0;
const nextId = () => `m${++counter}`;

// history sent to the server: finished turns only, citation markers removed
function toHistory(messages: Message[]): Turn[] {
  return messages
    .filter((m) => m.status === "done")
    .map((m) => ({ role: m.role, content: m.text.replace(/\[\d+\]/g, "").slice(0, 1500) }))
    .slice(-6);
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor" />
    </svg>
  );
}

export function Chat({ staff }: { staff: boolean }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastTurnRef = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(false);
  const turnCount = Math.ceil(messages.length / 2);

  // when a question is sent, bring it to the top of the screen and let the
  // answer write itself in underneath. no scrolling while it streams, so
  // reading or scrolling back is never fought
  useLayoutEffect(() => {
    if (turnCount > 0) lastTurnRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [turnCount]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const update = (id: string, patch: Partial<Message> | ((m: Message) => Partial<Message>)) =>
    setMessages((ms) => ms.map((m) => (m.id === id ? { ...m, ...(typeof patch === "function" ? patch(m) : patch) } : m)));

  async function send(question: string) {
    const q = question.trim();
    if (!q || busy || q.length > MAX_CHARS) return;
    const history = toHistory(messages);
    const userMsg: Message = { id: nextId(), role: "user", text: q, status: "done" };
    const botMsg: Message = { id: nextId(), role: "assistant", text: "", status: "streaming" };
    setMessages((ms) => [...ms, userMsg, botMsg]);
    setDraft("");
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await askStream(
        q,
        history,
        (d) => update(botMsg.id, (m) => ({ text: m.text + d })),
        controller.signal,
        // show the verified answer straight away; suggestions arrive after
        (answer) => update(botMsg.id, { text: answer.answer, result: answer, status: "done" }),
      );
      // the final text replaces the streamed text: unverified citations are
      // removed server side, and declines use the app's own wording
      update(botMsg.id, { text: result.answer, result, status: "done" });
    } catch (err) {
      if (controller.signal.aborted) {
        update(botMsg.id, { status: "stopped" });
        return;
      }
      update(botMsg.id, { text: err instanceof Error ? err.message : "Something went wrong. Please try again.", status: "error" });
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  // stops the answer being written; the server stops the model call too
  function stop() {
    abortRef.current?.abort();
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send(draft);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(draft);
    }
  }

  function reset() {
    abortRef.current?.abort();
    setMessages([]);
    setBusy(false);
    inputRef.current?.focus();
  }

  const home = messages.length === 0;
  const placeholder = useTypedExample(home && !draft && !focused);
  const over = draft.length > MAX_CHARS;
  const nearLimit = draft.length > MAX_CHARS - 100;

  const composer = (
    <form className="composer" onSubmit={onSubmit}>
      <div className={`composer-box${over ? " is-over" : ""}`}>
        <label htmlFor="question" className="sr-only">
          Your question
        </label>
        <textarea
          id="question"
          ref={inputRef}
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={home ? placeholder : "Ask a follow-up"}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          aria-invalid={over}
          aria-describedby="composer-help"
        />
        {busy ? (
          <button type="button" className="icon-btn" onClick={stop} aria-label="Stop answering">
            <StopIcon />
          </button>
        ) : (
          <button type="submit" className="icon-btn" disabled={!draft.trim() || over} aria-label="Ask">
            <SendIcon />
          </button>
        )}
      </div>
      <div className="composer-foot" id="composer-help">
        <span className={over ? "warn" : undefined}>
          {over
            ? `Please keep questions under ${MAX_CHARS} characters.`
            : "Answers use only Parure's published information. Don't share card details."}
        </span>
        <span className="composer-actions">
          {nearLimit && <span className={over ? "warn" : undefined}>{`${draft.length}/${MAX_CHARS}`}</span>}
          {messages.length > 0 && (
            <button type="button" className="link" onClick={reset}>
              New conversation
            </button>
          )}
        </span>
      </div>
    </form>
  );

  // messages come in question and answer pairs; each pair is one turn
  const turns: [Message, Message | undefined][] = [];
  for (let i = 0; i < messages.length; i += 2) turns.push([messages[i]!, messages[i + 1]]);

  return (
    <main className="chat">
      <section className="thread" aria-live="polite" aria-busy={busy}>
        <article className="a greeting">
          <p>Hello, and welcome to Parure. Ask us anything about our pieces, delivery, returns or caring for your jewellery.</p>
          {home && (
            <ul className="chips" aria-label="Popular topics">
              {TOPICS.map((t) => (
                <li key={t.label}>
                  <button type="button" className="chip" onClick={() => void send(t.question)}>
                    {t.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </article>
        {turns.map(([q, a], i) => (
          <div key={q.id} className={`turn${i === turns.length - 1 ? " is-last" : ""}`} ref={i === turns.length - 1 ? lastTurnRef : undefined}>
            <div className="q-row">
              <p className="q">{q.text}</p>
            </div>
            {a && (
              <Answer
                text={a.text}
                status={a.status}
                result={a.result}
                supportEmail={SUPPORT_EMAIL}
                onAsk={busy ? undefined : (f) => void send(f)}
                staff={staff}
              />
            )}
          </div>
        ))}
      </section>
      {composer}
    </main>
  );
}
