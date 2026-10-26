// incremental helpers for streaming a structured-output response.

// pulls the value of the top-level "answer" string out of a json object that
// is still being generated, returning only newly decoded characters each time
export class AnswerFieldStreamer {
  private raw = "";
  private start = -1; // index of the first char inside the answer string
  private pos = 0; // next raw index to decode
  private done = false;

  feed(delta: string): string {
    this.raw += delta;
    if (this.done) return "";
    if (this.start < 0) {
      const m = /"answer"\s*:\s*"/.exec(this.raw);
      if (!m) return "";
      this.start = m.index + m[0].length;
      this.pos = this.start;
    }
    let out = "";
    while (this.pos < this.raw.length) {
      const ch = this.raw[this.pos]!;
      if (ch === '"') {
        this.done = true;
        break;
      }
      if (ch !== "\\") {
        out += ch;
        this.pos++;
        continue;
      }
      // escape sequence: wait until it is complete
      const next = this.raw[this.pos + 1];
      if (next === undefined) break;
      if (next === "u") {
        const hex = this.raw.slice(this.pos + 2, this.pos + 6);
        if (hex.length < 4) break;
        out += String.fromCharCode(parseInt(hex, 16));
        this.pos += 6;
        continue;
      }
      const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\", "/": "/" };
      out += map[next] ?? next;
      this.pos += 2;
    }
    return out;
  }

  get text(): string {
    return this.raw;
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
