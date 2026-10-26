import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { Doc } from "../types.js";

// frontmatter is validated so a typo in a doc fails loudly at ingest time
// instead of silently producing a bad index
const FrontmatterSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  type: z.enum(["policy", "product", "collection", "guide", "faq", "brand", "contact"]),
  collection: z.string().optional(),
  effective_from: z.union([z.string(), z.date()]).transform((v) =>
    v instanceof Date ? v.toISOString().slice(0, 10) : v,
  ),
  supersedes: z.string().optional(),
  superseded_by: z.string().optional(),
  url: z.string().url().optional(),
});

const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseDoc(raw: string, relPath: string): Doc {
  const m = raw.match(FM);
  if (!m) throw new Error(`${relPath}: missing frontmatter`);
  const result = FrontmatterSchema.safeParse(parseYaml(m[1]!));
  if (!result.success) {
    throw new Error(`${relPath}: invalid frontmatter: ${result.error.message}`);
  }
  const fm = result.data;
  return {
    id: fm.id,
    title: fm.title,
    type: fm.type,
    collection: fm.collection,
    effectiveFrom: fm.effective_from,
    supersedes: fm.supersedes,
    supersededBy: fm.superseded_by,
    url: fm.url,
    body: raw.slice(m[0].length).trim(),
    path: relPath,
  };
}

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      return e.name.endsWith(".md") && e.name.toLowerCase() !== "readme.md" ? [p] : [];
    }),
  );
  return files.flat().sort();
}

export async function loadDocs(kbDir: string): Promise<Doc[]> {
  const files = await walk(kbDir);
  const docs = await Promise.all(
    files.map(async (f) => parseDoc(await fs.readFile(f, "utf8"), path.relative(kbDir, f))),
  );
  validateLinks(docs);
  return docs;
}

// supersedes / superseded_by must point at real docs and agree with each other
export function validateLinks(docs: Doc[]): void {
  const byId = new Map<string, Doc>();
  for (const d of docs) {
    if (byId.has(d.id)) throw new Error(`duplicate doc id: ${d.id}`);
    byId.set(d.id, d);
  }
  for (const d of docs) {
    if (d.supersededBy) {
      const newer = byId.get(d.supersededBy);
      if (!newer) throw new Error(`${d.id}: superseded_by points at missing doc ${d.supersededBy}`);
      if (newer.supersedes !== d.id) {
        throw new Error(`${d.id} and ${newer.id}: supersedes/superseded_by do not match`);
      }
    }
    if (d.supersedes && !byId.has(d.supersedes)) {
      throw new Error(`${d.id}: supersedes points at missing doc ${d.supersedes}`);
    }
  }
}
