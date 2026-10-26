// helpers for turning the model's structured output into display text,
// both incrementally while it streams and once it is complete.

export interface SentencePart {
  text: string;
  labels: string[]; // source ids such as S1 or A1
}

const isListItem = (s: string) => /^\s*[-•]\s/.test(s);

// separator before a sentence: lists get their own block, list items sit
// on separate lines, ordinary sentences flow together as one paragraph
function separator(prevWasList: boolean, curIsList: boolean): string {
  if (curIsList && prevWasList) return "\n";
  if (curIsList || prevWasList) return "\n\n";
  return " ";
}

const markers = (labels: string[]) => labels.map((l) => `[${l}]`).join("");

// joins cited sentences into answer text with [S1] style markers after each
// sentence. the same layout rules are used while streaming.
export function joinSentences(parts: SentencePart[]): string {
  let out = "";
  let prevList = false;
  parts.forEach((p, i) => {
    const text = p.text.trim();
    if (!text) return;
    const list = isListItem(text);
    if (i > 0 && out) out += separator(prevList, list);
    out += text + markers(p.labels);
    prevList = list;
  });
  return out;
}

// decodes one json string character at raw[pos]. returns null when more input
// is needed, { end } at the closing quote
function decodeAt(raw: string, pos: number): { ch: string; next: number } | { end: number } | null {
  const ch = raw[pos];
  if (ch === undefined) return null;
  if (ch === '"') return { end: pos + 1 };
  if (ch !== "\\") return { ch, next: pos + 1 };
  const esc = raw[pos + 1];
  if (esc === undefined) return null;
  if (esc === "u") {
    const hex = raw.slice(pos + 2, pos + 6);
    if (hex.length < 4) return null;
    return { ch: String.fromCharCode(parseInt(hex, 16)), next: pos + 6 };
  }
  const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };
  return { ch: map[esc] ?? esc, next: pos + 2 };
}

// reads a json object that is still being generated and returns, on each
// feed, the newly available display text. relies on the schema's property
// order: in each sentence "sources" comes before "text", so a sentence's
// markers are known the moment its text finishes.
export class SentenceStreamer {
  private raw = "";
  private pos = 0;
  private mode: "seekSources" | "seekText" | "inText" | "done" = "seekSources";
  private labels: string[] = [];
  private count = 0;
  private prevList = false;
  private head = ""; // first characters of a sentence, held until we know if it is a list item
  private headSent = false;

  private flushHead(): string {
    if (this.headSent) return "";
    this.headSent = true;
    const list = isListItem(this.head);
    const sep = this.count > 0 ? separator(this.prevList, list) : "";
    this.prevList = list;
    return sep + this.head;
  }

  feed(delta: string): string {
    this.raw += delta;
    let out = "";
    for (;;) {
      if (this.mode === "done") return out;

      if (this.mode === "seekSources") {
        const re = /"sources"\s*:\s*\[([^\]]*)\]|"citations"\s*:/g;
        re.lastIndex = this.pos;
        const m = re.exec(this.raw);
        if (!m) return out;
        if (m[1] === undefined) {
          this.mode = "done";
          return out;
        }
        this.labels = [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]!.trim());
        this.pos = m.index + m[0].length;
        this.mode = "seekText";
        continue;
      }

      if (this.mode === "seekText") {
        const re = /"text"\s*:\s*"/g;
        re.lastIndex = this.pos;
        const m = re.exec(this.raw);
        if (!m) return out;
        this.pos = m.index + m[0].length;
        this.mode = "inText";
        this.head = "";
        this.headSent = false;
        continue;
      }

      // inText
      const step = decodeAt(this.raw, this.pos);
      if (step === null) return out;
      if ("end" in step) {
        this.pos = step.end;
        // an empty sentence adds nothing, not even a separator
        if (this.head.trim() || this.headSent) {
          out += this.flushHead() + markers(this.labels);
          this.count++;
        }
        this.mode = "seekSources";
        continue;
      }
      this.pos = step.next;
      if (this.headSent) {
        out += step.ch;
      } else {
        this.head += step.ch;
        // two characters are enough to tell "- " list items apart
        if (this.head.trimStart().length >= 2) out += this.flushHead();
      }
    }
  }
}

const MARKER = /\[((?:[SA]\d+)(?:\s*,\s*[SA]\d+)*)\]/g;

// rewrites source labels ([S2], [A1]) into display numbers ([1], [2]) in
// order of first appearance. holds back a trailing "[..." until it closes,
// so a marker split across two deltas is never shown half-rewritten.
export class MarkerRewriter {
  private pending = "";
  readonly order: string[] = [];

  constructor(private allowed?: Set<string>) {}

  private num(label: string): number | null {
    if (this.allowed && !this.allowed.has(label)) return null;
    let i = this.order.indexOf(label);
    if (i < 0) {
      this.order.push(label);
      i = this.order.length - 1;
    }
    return i + 1;
  }

  private rewrite(s: string): string {
    return s.replace(MARKER, (_m, inner: string) =>
      inner
        .split(/\s*,\s*/)
        .map((l) => this.num(l))
        .filter((n): n is number => n !== null)
        .map((n) => `[${n}]`)
        .join(""),
    );
  }

  push(delta: string): string {
    const s = this.pending + delta;
    const open = s.lastIndexOf("[");
    // keep a possibly unfinished marker back (markers are short)
    if (open >= 0 && !s.includes("]", open) && s.length - open < 16) {
      this.pending = s.slice(open);
      return this.rewrite(s.slice(0, open));
    }
    this.pending = "";
    return this.rewrite(s);
  }

  flush(): string {
    const s = this.rewrite(this.pending);
    this.pending = "";
    return s;
  }
}

// one-shot version for the final, validated answer
export function rewriteMarkers(answer: string, allowed: Set<string>): { text: string; order: string[] } {
  const r = new MarkerRewriter(allowed);
  const text = (r.push(answer) + r.flush())
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return { text, order: r.order };
}
