// judge calibration: how often does the llm judge agree with a person?
// usage: npm run eval:agreement
//
// reads the labels downloaded from the labelling page (evals/labels.json) and
// the latest full eval run, and compares them on each of the judge's three
// questions. reports raw agreement and cohen's kappa (agreement corrected for
// chance: with mostly "yes" answers, two raters agree often by luck alone),
// and which way the judge errs: too lenient (passes what the person failed)
// or too strict. only labels whose answer text matches the run are used.
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { settings } from "../src/config.js";
import type { CaseResult } from "./score.js";

const here = path.dirname(new URL(import.meta.url).pathname);

const Labels = z.object({
  labeller: z.string(),
  labelledAt: z.string(),
  runAt: z.string(),
  labels: z.array(
    z.object({ id: z.string(), answer: z.string(), correct: z.boolean(), grounded: z.boolean(), focused: z.boolean(), note: z.string() }),
  ),
});

export interface Agreement {
  n: number;
  agreement: number | null;
  kappa: number | null;
  judgeLenient: number; // judge yes, person no
  judgeStrict: number; // judge no, person yes
}

// cohen's kappa for two raters and a yes/no label
export function agreement(pairs: [human: boolean, judge: boolean][]): Agreement {
  const n = pairs.length;
  if (!n) return { n, agreement: null, kappa: null, judgeLenient: 0, judgeStrict: 0 };
  const po = pairs.filter(([h, j]) => h === j).length / n;
  const h = pairs.filter(([x]) => x).length / n;
  const j = pairs.filter(([, x]) => x).length / n;
  const pe = h * j + (1 - h) * (1 - j);
  return {
    n,
    agreement: po,
    // when both raters always say the same single value, chance agreement is 1 and kappa is undefined
    kappa: pe === 1 ? null : (po - pe) / (1 - pe),
    judgeLenient: pairs.filter(([hu, ju]) => !hu && ju).length,
    judgeStrict: pairs.filter(([hu, ju]) => hu && !ju).length,
  };
}

async function main() {
  const labelsPath = path.join(here, "labels.json");
  const raw = await fs.readFile(labelsPath, "utf8").catch(() => null);
  if (!raw) {
    console.error("no evals/labels.json yet: label answers on the dashboard (staff view, How it's tested, Check the judge) and download them");
    process.exit(1);
  }
  const labels = Labels.parse(JSON.parse(raw));
  const run = JSON.parse(await fs.readFile(path.join(settings.reportsDir, "latest-full.json"), "utf8")) as { runAt: string; results: CaseResult[] };
  const byId = new Map(run.results.map((r) => [r.id, r]));

  const matched = labels.labels.flatMap((l) => {
    const r = byId.get(l.id);
    return r?.judge && r.answer === l.answer ? [{ l, j: r.judge }] : [];
  });
  const stale = labels.labels.length - matched.length;

  const dims = {
    "Correct (judge 4 or 5 out of 5)": agreement(matched.map(({ l, j }) => [l.correct, j.correctness >= 4])),
    Supported: agreement(matched.map(({ l, j }) => [l.grounded, j.grounded])),
    Focused: agreement(matched.map(({ l, j }) => [l.focused, j.focused])),
    "Overall pass": agreement(
      matched.map(({ l, j }) => [l.correct && l.grounded && l.focused, j.correctness >= 4 && j.grounded && j.focused]),
    ),
  };

  const pct = (x: number | null) => (x === null ? "n/a" : `${Math.round(x * 100)}%`);
  const k = (x: number | null) => (x === null ? "n/a" : x.toFixed(2));
  console.log(`\njudge vs ${labels.labeller}: ${matched.length} answers${stale ? ` (${stale} labels skipped: the answer changed since labelling)` : ""}\n`);
  console.table(
    Object.fromEntries(
      Object.entries(dims).map(([name, a]) => [name, { agreement: pct(a.agreement), kappa: k(a.kappa), "judge too lenient": a.judgeLenient, "judge too strict": a.judgeStrict }]),
    ),
  );

  const disagreements = matched.filter(
    ({ l, j }) => l.correct !== j.correctness >= 4 || l.grounded !== j.grounded || l.focused !== j.focused,
  );
  const md = [
    `# Judge agreement`,
    ``,
    `${matched.length} answers from the run of ${run.runAt}, labelled blind by the ${labels.labeller} on ${labels.labelledAt.slice(0, 10)}.`,
    `Kappa corrects agreement for chance: above 0.6 is usually read as substantial, above 0.8 as almost perfect.`,
    ``,
    `| Question | Agreement | Kappa | Judge too lenient | Judge too strict |`,
    `|---|---|---|---|---|`,
    ...Object.entries(dims).map(([name, a]) => `| ${name} | ${pct(a.agreement)} | ${k(a.kappa)} | ${a.judgeLenient} | ${a.judgeStrict} |`),
    ``,
    `## Disagreements`,
    ``,
    ...(disagreements.length
      ? disagreements.map(
          ({ l, j }) =>
            `- **${l.id}**: person ${[l.correct ? "correct" : "incorrect", l.grounded ? "supported" : "unsupported", l.focused ? "focused" : "unfocused"].join(", ")}; judge ${j.correctness}/5, ${j.grounded ? "supported" : "unsupported"}, ${j.focused ? "focused" : "unfocused"} ("${j.reason}")${l.note ? `. Note: ${l.note}` : ""}`,
        )
      : ["None."]),
    ``,
  ].join("\n");
  await fs.writeFile(path.join(settings.reportsDir, "agreement.md"), md);
  console.log("report saved to evals/reports/agreement.md");
}

// only run when called directly, so the kappa function can be unit tested
if (import.meta.url === `file://${process.argv[1]}`) await main();
