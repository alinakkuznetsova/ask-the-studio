// small bm25 implementation. keyword search catches what embeddings blur:
// exact prices ("£225"), sizes ("uk o"), collection names and product names.

const STOPWORDS = new Set(
  (
    "a an and are as at be but by can do does for from has have how i if in is it its " +
    "me my of on or our so that the their them then there this to was we what when " +
    "where which who will with you your"
  ).split(" "),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/£?[a-z0-9]+(?:\.[0-9]+)?/g) ?? [])
    .filter((t) => !STOPWORDS.has(t))
    .map(stem);
}

// deliberately light stemming: plurals and a few suffixes.
// enough for "earrings" ~ "earring", "returns" ~ "return", "shipping" ~ "ship"
export function stem(t: string): string {
  if (t.length <= 3 || /^£?\d/.test(t)) return t;
  if (t.endsWith("ies") && t.length > 4) return t.slice(0, -3) + "y";
  if (t.endsWith("ing") && t.length > 5) {
    const s = t.slice(0, -3);
    return /(.)\1$/.test(s) ? s.slice(0, -1) : s;
  }
  if (t.endsWith("es") && /(ss|x|ch|sh)es$/.test(t)) return t.slice(0, -2);
  if (t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

export class BM25 {
  private docs: string[][] = [];
  private df = new Map<string, number>();
  private avgLen = 0;

  constructor(
    texts: string[],
    private k1 = 1.2,
    private b = 0.75,
  ) {
    this.docs = texts.map(tokenize);
    for (const d of this.docs) {
      for (const t of new Set(d)) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.avgLen = this.docs.reduce((s, d) => s + d.length, 0) / Math.max(1, this.docs.length);
  }

  private idf(term: string): number {
    const n = this.docs.length;
    const df = this.df.get(term) ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  // returns [docIndex, score] pairs, best first, score > 0 only
  search(query: string, limit: number, allowed?: (i: number) => boolean): [number, number][] {
    const q = [...new Set(tokenize(query))];
    const scores: [number, number][] = [];
    this.docs.forEach((d, i) => {
      if (allowed && !allowed(i)) return;
      const tf = new Map<string, number>();
      for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
      let s = 0;
      for (const term of q) {
        const f = tf.get(term);
        if (!f) continue;
        s += (this.idf(term) * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.length) / this.avgLen));
      }
      if (s > 0) scores.push([i, s]);
    });
    return scores.sort((a, b) => b[1] - a[1]).slice(0, limit);
  }
}
