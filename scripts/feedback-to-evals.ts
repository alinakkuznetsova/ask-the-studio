// turns thumbs-down feedback into draft eval cases, so real failures become
// regression tests. a person still writes the reference answer and checks.
// usage: npm run feedback:export   -> writes evals/candidates.json
import fs from "node:fs/promises";
import path from "node:path";
import { settings } from "../src/config.js";

interface Feedback {
  at: string;
  traceId: string;
  rating: "up" | "down";
  comment?: string;
  question: string;
  answer: string;
  answerable: boolean;
  sources: string[];
}

const file = path.join(settings.dataDir, "feedback.jsonl");
const raw = await fs.readFile(file, "utf8").catch(() => "");
const rows = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Feedback);
const down = rows.filter((r) => r.rating === "down");

const candidates = down.map((r, i) => ({
  id: `fb-${r.at.slice(0, 10)}-${i + 1}`,
  category: r.answerable ? "straightforward" : "unanswerable",
  question: r.question,
  expect: "answer",
  requiredDocs: [],
  acceptableDocs: [...new Set(r.sources.map((s) => s.split("#")[0]))],
  mustInclude: [],
  mustNotInclude: [],
  reference: "TODO: write the correct answer",
  _feedback: { comment: r.comment ?? null, answerGiven: r.answer, traceId: r.traceId },
}));

await fs.writeFile(path.join(settings.reportsDir, "..", "candidates.json"), JSON.stringify(candidates, null, 2));
console.log(`${rows.length} feedback entries, ${down.length} thumbs down -> evals/candidates.json`);
