// counterfactual grounding test.
// usage: npm run eval:counterfactual
//
// a normal eval cannot tell whether an answer came from the documents or from
// what the model already believes. this one changes facts in a temporary copy
// of the knowledge base (returns 30 -> 45 days, a set price, the warranty
// length) and asks the same question against both copies. a grounded system
// gives the original fact first and the edited fact second. removal cases
// delete a fact, and the system must not fill the gap from memory or from an
// archived policy.
import "dotenv/config";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { env, settings } from "../src/config.js";
import { ask } from "../src/answer/pipeline.js";
import { OpenAIChat } from "../src/answer/llm.js";
import { PROMPT_VERSION } from "../src/answer/prompt.js";
import { buildIndex, DEFAULT_RETRIEVAL, openaiClient } from "../src/kb/build.js";
import type { AskResult } from "../src/types.js";
import { containsTerm } from "./score.js";

const Check = z.object({ mustInclude: z.array(z.string()), mustNotInclude: z.array(z.string()) });
const Schema = z.object({
  version: z.string(),
  notes: z.string().optional(),
  cases: z.array(
    z.object({
      id: z.string(),
      question: z.string(),
      edits: z.array(z.object({ file: z.string(), find: z.string(), replace: z.string() })),
      original: Check,
      edited: Check,
    }),
  ),
});
type Case = z.infer<typeof Schema>["cases"][number];

const here = path.dirname(new URL(import.meta.url).pathname);
const spec = Schema.parse(JSON.parse(await fs.readFile(path.join(here, "counterfactual.json"), "utf8")));
const asOf = new Date("2026-10-26T12:00:00Z");

// "a|b" passes if either term appears
function failures(answer: string, check: z.infer<typeof Check>): string[] {
  const out: string[] = [];
  for (const item of check.mustInclude) if (!item.split("|").some((t) => containsTerm(answer, t))) out.push(`missing ${item}`);
  for (const item of check.mustNotInclude) if (item.split("|").some((t) => containsTerm(answer, t))) out.push(`says ${item}`);
  return out;
}

// copies the knowledge base and applies every edit. each find string must
// exist, so a wording change in a doc breaks this loudly instead of making a
// case silently test nothing
async function editedCopy(cases: Case[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kb-counterfactual-"));
  await fs.cp(settings.kbDir, dir, { recursive: true });
  for (const c of cases) {
    for (const e of c.edits) {
      const file = path.join(dir, e.file);
      const text = await fs.readFile(file, "utf8");
      if (!text.includes(e.find)) throw new Error(`${c.id}: "${e.find}" not found in ${e.file}`);
      await fs.writeFile(file, text.split(e.find).join(e.replace));
    }
  }
  return dir;
}

const cfg = env();
const chat = new OpenAIChat(openaiClient(), cfg.CHAT_MODEL);
const kbCopy = await editedCopy(spec.cases);
// one after the other: both indexes share the embedding cache file
const original = await buildIndex(DEFAULT_RETRIEVAL);
const edited = await buildIndex(DEFAULT_RETRIEVAL, undefined, kbCopy);

console.log(`\ncounterfactual grounding: ${spec.cases.length} cases, model=${cfg.CHAT_MODEL}, prompt=${PROMPT_VERSION}\n`);

interface Row {
  id: string;
  question: string;
  original: { answer: string; failures: string[] };
  edited: { answer: string; answerable: boolean; failures: string[]; citesEditedText: boolean };
  pass: boolean;
}

const summaryOf = (r: AskResult) => ({ answer: r.answer, answerable: r.answerable });
const rows: Row[] = [];
for (const c of spec.cases) {
  const [a, b] = await Promise.all([
    ask(c.question, { retriever: original.retriever, chat }, { now: asOf }),
    ask(c.question, { retriever: edited.retriever, chat }, { now: asOf }),
  ]);
  const replaced = c.edits.map((e) => e.replace).filter(Boolean);
  const row: Row = {
    id: c.id,
    question: c.question,
    original: { answer: a.answer, failures: failures(a.answer, c.original) },
    edited: {
      ...summaryOf(b),
      failures: failures(b.answer, c.edited),
      // the verified quote itself carries the new wording
      citesEditedText: replaced.length === 0 || b.sources.some((s) => s.quotes.some((q) => replaced.some((r) => q.includes(r.trim())))),
    },
    pass: false,
  };
  row.pass = row.original.failures.length === 0 && row.edited.failures.length === 0;
  rows.push(row);
  console.log(`${row.pass ? "✓" : "✗"} ${c.id}`);
}

console.table(
  rows.map((r) => ({
    case: r.id,
    original: r.original.failures.length ? r.original.failures.join("; ") : "ok",
    edited: r.edited.failures.length ? r.edited.failures.join("; ") : "ok",
    "quote has new text": r.edited.citesEditedText ? "yes" : "no",
  })),
);
const passed = rows.filter((r) => r.pass).length;
console.log(`\nfollowed the edited knowledge base in ${passed} of ${rows.length} cases`);

const report = { runAt: new Date().toISOString(), version: spec.version, promptVersion: PROMPT_VERSION, model: cfg.CHAT_MODEL, passed, total: rows.length, rows };
await fs.mkdir(settings.reportsDir, { recursive: true });
await fs.writeFile(path.join(settings.reportsDir, "counterfactual.json"), JSON.stringify(report, null, 2));
const md = [
  `# Counterfactual grounding`,
  ``,
  `Run ${report.runAt}, prompt ${PROMPT_VERSION}, model ${cfg.CHAT_MODEL}. Followed the edit in **${passed} of ${rows.length}** cases.`,
  ``,
  `| Case | Original KB | Edited KB | Edited answer |`,
  `|---|---|---|---|`,
  ...rows.map(
    (r) =>
      `| ${r.id} | ${r.original.failures.join("; ") || "ok"} | ${r.edited.failures.join("; ") || "ok"} | ${r.edited.answer.replace(/\[\d+\]/g, "").replace(/\s+/g, " ").replace(/\|/g, "/").slice(0, 160)} |`,
  ),
  ``,
].join("\n");
await fs.writeFile(path.join(settings.reportsDir, "counterfactual.md"), md);
await fs.rm(kbCopy, { recursive: true, force: true });
console.log("report saved to evals/reports/counterfactual.md");
