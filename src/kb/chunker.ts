import type { Chunk, Doc } from "../types.js";

// chunking strategy:
// - short docs (product pages) stay whole: price, materials and size answer
//   different questions about the same item and should be retrieved together
// - longer docs split on "## " headings, which in this kb map to one topic each
//   (e.g. "returns window", "returning a set")
// - tiny neighbouring sections (under sectionMinWords) are merged, so a
//   14-word "returns window" section does not become a context-free chunk
// - a section that is still too long is split on paragraph boundaries
// - every chunk gets a contextual header (doc title > section) prepended to
//   the text that is embedded and keyword indexed

export interface ChunkOptions {
  wholeDocMaxWords: number;
  sectionMinWords: number;
  sectionMaxWords: number;
}

export function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "section"
  );
}

export interface Section {
  heading: string;
  text: string;
}

function splitSections(body: string, docTitle: string): Section[] {
  const lines = body.split(/\r?\n/);
  const sections: Section[] = [];
  let heading = "Overview";
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join("\n").trim();
    if (text) sections.push({ heading, text });
    buf = [];
  };
  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      flush();
      heading = h2[1]!;
      continue;
    }
    // the h1 just repeats the title, so drop it
    if (/^#\s+/.test(line)) continue;
    buf.push(line);
  }
  flush();
  // a doc with no h2 becomes a single section named after the doc
  if (sections.length === 1 && sections[0]!.heading === "Overview") {
    sections[0]!.heading = docTitle;
  }
  return sections;
}

// merge each small section into the next one (the last small one goes back
// into the previous), keeping merged chunks under the max size
export function packSections(sections: Section[], minWords: number, maxWords: number): Section[] {
  const out: Section[] = [];
  let pending: Section | null = null;
  for (const s of sections) {
    // an intro paragraph has no real heading, so it takes the next one's
    const heading = pending?.heading === "Overview" ? s.heading : pending ? `${pending.heading}; ${s.heading}` : s.heading;
    const cur: Section = pending ? { heading, text: `${pending.text}\n\n${s.text}` } : s;
    pending = null;
    if (wordCount(cur.text) < minWords) pending = cur;
    else out.push(cur);
  }
  if (pending) {
    const prev = out[out.length - 1];
    if (prev && wordCount(prev.text) + wordCount(pending.text) <= maxWords) {
      out[out.length - 1] = {
        heading: `${prev.heading}; ${pending.heading}`,
        text: `${prev.text}\n\n${pending.text}`,
      };
    } else {
      out.push(pending);
    }
  }
  return out;
}

function splitLong(text: string, maxWords: number): string[] {
  if (wordCount(text) <= maxWords) return [text];
  const paras = text.split(/\n\s*\n/);
  const parts: string[] = [];
  let cur: string[] = [];
  let curWords = 0;
  for (const p of paras) {
    const w = wordCount(p);
    if (curWords + w > maxWords && cur.length) {
      parts.push(cur.join("\n\n"));
      cur = [];
      curWords = 0;
    }
    cur.push(p);
    curWords += w;
  }
  if (cur.length) parts.push(cur.join("\n\n"));
  return parts;
}

function header(doc: Doc, section: string): string {
  const meta = [doc.title];
  if (section !== doc.title) meta.push(section);
  const archived = doc.supersededBy ? " (archived, no longer current)" : "";
  return `${meta.join(" > ")}${archived}`;
}

export function chunkDoc(doc: Doc, opts: ChunkOptions): Chunk[] {
  const base = {
    docId: doc.id,
    docTitle: doc.title,
    docType: doc.type,
    archived: Boolean(doc.supersededBy),
    supersedes: doc.supersedes,
    effectiveFrom: doc.effectiveFrom,
    url: doc.url,
  };

  if (wordCount(doc.body) <= opts.wholeDocMaxWords) {
    const text = doc.body.replace(/^#\s+.*\n?/m, "").trim();
    return [
      {
        ...base,
        id: `${doc.id}#all`,
        section: doc.title,
        text,
        indexText: `${header(doc, doc.title)}\n\n${text}`,
      },
    ];
  }

  const chunks: Chunk[] = [];
  const seen = new Map<string, number>();
  const sections = packSections(splitSections(doc.body, doc.title), opts.sectionMinWords, opts.sectionMaxWords);
  for (const s of sections) {
    const parts = splitLong(s.text, opts.sectionMaxWords);
    // repeated headings in one doc get a numeric suffix so ids stay unique
    let slug = slugify(s.heading);
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    if (n > 0) slug = `${slug}-${n + 1}`;
    parts.forEach((text, i) => {
      const id = parts.length > 1 ? `${doc.id}#${slug}-p${i + 1}` : `${doc.id}#${slug}`;
      chunks.push({
        ...base,
        id,
        section: s.heading,
        text,
        indexText: `${header(doc, s.heading)}\n\n${text}`,
      });
    });
  }
  return chunks;
}

export function chunkDocs(docs: Doc[], opts: ChunkOptions): Chunk[] {
  return docs.flatMap((d) => chunkDoc(d, opts));
}
