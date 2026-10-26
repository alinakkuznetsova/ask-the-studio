import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
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

// customers usually arrive with a specific question, so the home screen is
// an input first. the topics help people who don't know where to start, and
// the placeholder cycles through real examples of what can be asked
const TOPICS = [
  { label: "Returns", question: "How do returns work?" },
  { label: "Delivery", question: "How does delivery work and how long does it take?" },
  { label: "Caring for your jewellery", question: "How should I care for my jewellery?" },
];

const EXAMPLES = [
  "Is the silver hypoallergenic?",
  "Can I wear the rings in the shower?",
  "How do I return a gift?",
  "How much do I save buying the MARINE set?",
];

// swaps the example every few seconds while the box is empty
function useRotatingExample(active: boolean): string {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!active || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setI((n) => (n + 1) % EXAMPLES.length), 3500);
    return () => clearInterval(t);
  }, [active]);
  return EXAMPLES[i]!;
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
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages]);

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
      const result = await askStream(q, history, (d) => update(botMsg.id, (m) => ({ text: m.text + d })), controller.signal);
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
  const example = useRotatingExample(home && !draft);
  const over = draft.length > MAX_CHARS;
  const nearLimit = draft.length > MAX_CHARS - 100;

  const composer = (
    <form className={`composer${home ? " is-home" : ""}`} onSubmit={onSubmit}>
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
          placeholder={home ? example : "Ask a follow-up"}
          aria-invalid={over}
          aria-describedby="composer-help"
          autoFocus
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

  return (
    <main className="chat">
      {home ? (
        <section className="intro" aria-labelledby="intro-title">
          <h1 id="intro-title">How can we help?</h1>
          <p className="lede">Ask about a piece, delivery, returns or care. Answers come from Parure's own guides and policies.</p>
          {composer}
          <ul className="topics" aria-label="Popular topics">
            {TOPICS.map((t) => (
              <li key={t.label}>
                <button type="button" className="pill topic" onClick={() => void send(t.question)}>
                  {t.label}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <section className="thread" aria-live="polite" aria-busy={busy}>
          {messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="q-row">
                <p className="q">{m.text}</p>
              </div>
            ) : (
              <Answer
                key={m.id}
                text={m.text}
                status={m.status}
                result={m.result}
                supportEmail={SUPPORT_EMAIL}
                onAsk={busy ? undefined : (f) => void send(f)}
                staff={staff}
              />
            ),
          )}
          <div ref={endRef} />
        </section>
      )}

      {!home && composer}
    </main>
  );
}
