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

// a quote that is mostly verbatim can be trimmed to the part that is. models
// sometimes blend two near-identical documents into one quote ("because sets
// are discounted" from a collection page, then the rest from the returns
// policy). the longest run that does appear word for word is kept if it is
// long enough to be the substance of the quote. the source's own words are
// then shown, never the model's, so a displayed quote is always verbatim.
const MIN_RUN_WORDS = 10;
const MIN_RUN_SHARE = 0.6;

function longestRun(quoteWords: string[], source: string): string[] {
  let best: string[] = [];
  for (let i = 0; i < quoteWords.length; i++) {
    for (let j = quoteWords.length; j - i > best.length; j--) {
      const run = quoteWords.slice(i, j);
      if (source.includes(run.join(" "))) {
        best = run;
        break;
      }
    }
  }
  return best;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// finds the run in the original source text, so the shown quote keeps its
// capitals and punctuation; falls back to the normalised words
function originalSpan(run: string[], text: string): string {
  const pattern = run.map((w) => escapeRe(w).replace(/'/g, "['‘’]")).join("[\\s*_`]+");
  return text.match(new RegExp(pattern, "i"))?.[0] ?? run.join(" ");
}

// keep only citations that point at a source we actually retrieved and whose
// quote appears verbatim in that source (or, trimmed, mostly verbatim: see
// above). this is the main defence against hallucinated or fabricated citations.
export function validateCitations(
  citations: RawCitation[],
  sourceText: Map<string, string>,
): { valid: ValidatedCitation[]; dropped: number; checked: number; trimmed: number } {
  const bySource = new Map<string, string[]>();
  let dropped = 0;
  let trimmed = 0;
  for (const c of citations) {
    const text = sourceText.get(c.source.trim());
    const q = normaliseForMatch(c.quote);
    if (!text || q.length < 2) {
      dropped++;
      continue;
    }
    const source = normaliseForMatch(text);
    let quote = c.quote.trim();
    if (!source.includes(q)) {
      const words = q.split(" ");
      const run = longestRun(words, source);
      if (run.length < MIN_RUN_WORDS || run.length < words.length * MIN_RUN_SHARE) {
        dropped++;
        continue;
      }
      quote = originalSpan(run, text);
      trimmed++;
    }
    const list = bySource.get(c.source.trim()) ?? [];
    if (!list.includes(quote)) list.push(quote);
    bySource.set(c.source.trim(), list);
  }
  return {
    valid: [...bySource.entries()].map(([source, quotes]) => ({ source, quotes })),
    dropped,
    checked: citations.length,
    trimmed,
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
