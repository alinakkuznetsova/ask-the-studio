import { CANARY, SYSTEM_PROMPT } from "./prompt.js";

// normalise text before comparing a quote with its source: case, curly
// quotes, dashes, markdown emphasis and whitespace should not fail a match
export function normaliseForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'(]+|["'.,;:!?)]+$/g, "")
    .trim();
}

export interface RawCitation {
  source: string;
  quote: string;
}

export interface ValidatedCitation {
  source: string;
  quotes: string[];
}

// keep only citations that point at a source we actually retrieved and whose
// quote appears verbatim in that source. this is the main defence against
// hallucinated or fabricated citations.
export function validateCitations(
  citations: RawCitation[],
  sourceText: Map<string, string>,
): { valid: ValidatedCitation[]; dropped: number; checked: number } {
  const bySource = new Map<string, string[]>();
  let dropped = 0;
  for (const c of citations) {
    const text = sourceText.get(c.source.trim());
    const q = normaliseForMatch(c.quote);
    if (!text || q.length < 2 || !normaliseForMatch(text).includes(q)) {
      dropped++;
      continue;
    }
    const list = bySource.get(c.source.trim()) ?? [];
    if (!list.includes(c.quote.trim())) list.push(c.quote.trim());
    bySource.set(c.source.trim(), list);
  }
  return {
    valid: [...bySource.entries()].map(([source, quotes]) => ({ source, quotes })),
    dropped,
    checked: citations.length,
  };
}

// detects an answer that leaks the system prompt: the canary token, or any
// run of 8 consecutive words copied from the prompt
const PROMPT_WORDS = normaliseForMatch(SYSTEM_PROMPT).split(" ");
const PROMPT_SHINGLES = new Set<string>();
for (let i = 0; i + 8 <= PROMPT_WORDS.length; i++) PROMPT_SHINGLES.add(PROMPT_WORDS.slice(i, i + 8).join(" "));

export function leaksPrompt(answer: string): boolean {
  if (answer.includes(CANARY)) return true;
  const words = normaliseForMatch(answer).split(" ");
  for (let i = 0; i + 8 <= words.length; i++) {
    if (PROMPT_SHINGLES.has(words.slice(i, i + 8).join(" "))) return true;
  }
  return false;
}
