import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type OpenAI from "openai";

export interface Embedder {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export class OpenAIEmbedder implements Embedder {
  constructor(
    private client: OpenAI,
    readonly model: string,
    private batchSize = 96,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const res = await this.client.embeddings.create({ model: this.model, input: batch });
      // the api returns items with an index, sort to be safe
      const sorted = [...res.data].sort((a, b) => a.index - b.index);
      out.push(...sorted.map((d) => d.embedding));
    }
    return out;
  }
}

// incremental embedding: vectors are cached by a hash of (model, text).
// re-ingesting after editing one doc only re-embeds the chunks that changed,
// the same idea as an incremental model in a warehouse.
export class CachedEmbedder implements Embedder {
  private cache = new Map<string, number[]>();
  private loaded = false;
  stats = { hits: 0, misses: 0 };

  constructor(
    private inner: Embedder,
    private file: string | null,
  ) {}

  get model() {
    return this.inner.model;
  }

  static key(model: string, text: string): string {
    return crypto.createHash("sha256").update(`${model}\n${text}`).digest("hex");
  }

  private async load() {
    if (this.loaded || !this.file) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8")) as Record<string, number[]>;
      for (const [k, v] of Object.entries(raw)) this.cache.set(k, v);
    } catch {
      // no cache yet, or unreadable: start empty
    }
  }

  private async save() {
    if (!this.file) return;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(Object.fromEntries(this.cache)));
  }

  async embed(texts: string[]): Promise<number[][]> {
    await this.load();
    const keys = texts.map((t) => CachedEmbedder.key(this.model, t));
    const missing = [...new Set(keys.filter((k) => !this.cache.has(k)))];
    const missingTexts = missing.map((k) => texts[keys.indexOf(k)]!);
    this.stats.hits += keys.length - keys.filter((k) => missing.includes(k)).length;
    this.stats.misses += missing.length;
    if (missing.length) {
      const vecs = await this.inner.embed(missingTexts);
      missing.forEach((k, i) => this.cache.set(k, vecs[i]!));
      await this.save();
    }
    return keys.map((k) => this.cache.get(k)!);
  }

  // query embeddings go through here too but are not persisted to disk,
  // so user questions never end up stored on the server
  async embedEphemeral(texts: string[]): Promise<number[][]> {
    return this.inner.embed(texts);
  }
}

// deterministic offline embedder for unit tests: hashed bag of words
export class HashEmbedder implements Embedder {
  readonly model = "hash-test";
  constructor(private dims = 256) {}
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(this.dims).fill(0);
      for (const w of t.toLowerCase().match(/[a-z0-9£]+/g) ?? []) {
        const h = crypto.createHash("md5").update(w).digest().readUInt32BE(0);
        v[h % this.dims]! += 1;
      }
      return normalise(v);
    });
  }
}

export function normalise(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
