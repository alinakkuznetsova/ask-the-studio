# Evaluation

Five checks, each covering what the others can't:

| Check | What it answers | Command |
|---|---|---|
| Main eval set (67 questions) | Does it answer correctly, stay grounded, and decline when it should? | `npm run eval` |
| Held-out set (10 questions) | Does that hold on questions it was never tuned against? | `npm run eval:heldout` |
| Counterfactual test (6 cases) | Do answers come from the documents, not from what the model believes? | `npm run eval:counterfactual` |
| Repeat runs | Which differences are real, and which are the model's randomness? | `npm run eval -- --repeat 3` |
| Human labels | Can the LLM judge be trusted? | the labelling page, then `npm run eval:agreement` |

## The main set

`evals/dataset.json`, 67 questions:

| Group | Cases | What it tests |
|---|---|---|
| Straightforward | 12 | Single-document facts, including a safety case (severe nickel allergy) and product measurements |
| Needs several documents | 12 | Set savings, the set returns exception, gift wrap plus delivery to France, warranty claims, comparing the collections |
| Conflicting or outdated sources | 9 | 2025 vs 2026 policies, the FAQ vs the care guide (asked three ways), the time-limited LUNAR offer |
| Written the way customers write | 12 | Typos, indirect and casual phrasing ("bought my mum a necklace, not really her style"), and questions found by using the assistant |
| Follow-ups in a conversation | 4 | Questions that only make sense with earlier turns, up to three turns deep |
| Not in the sources | 7 | Necklace weight, engraving, phone number, next collection, discounts, exchanges |
| Off-topic and manipulation | 4 | A coding request, prompt extraction, a competitor comparison, role-play with a false claim |
| Security attacks | 7 | A forged earlier turn, instructions in another language, script output, another customer's data, a card number to echo, hidden zero-width characters, a fake system message |

The three example questions from the brief are cases s9 (silver hypoallergenic), c9 (rings in the shower) and m8 (returning a gift). Each case lists the documents retrieval must find, the documents it may cite, facts that must appear (alternatives allowed), claims that must not appear, whether it should answer or decline, and a reference answer written as the brand.

### Metrics

| Metric | How it's measured |
|---|---|
| Pass | The right decision (answer or decline), the required facts present and banned claims absent, and, for answers, the judge rating it correct (4 or 5 out of 5), grounded and focused |
| Retrieval recall@6 | Share of required documents in the top 6 passages |
| Decline accuracy | Answered or declined as expected; false answers (the costly kind) and false declines counted separately |
| Key facts | Exact word matching, which is deliberately strict. Meaning-based matching would accept "45 days" for "30 days". Words may take plain endings ("pearls", "showering"); numbers may not. |
| Correctness, groundedness, focus | An LLM judge, given the question, the reference answer, the answer, its suggested follow-ups and the full text of every cited passage |
| Quote verification, sentence coverage, citation precision | From the pipeline's own verification step |
| Follow-ups answered | Every suggested next question is asked for real; a suggestion the assistant then can't answer would look broken |
| Useful follow-up suggestions | Judge: every suggestion on the customer's topic and not already answered |
| Latency, cost | p50 and p95 end to end; USD per answer from token counts |

Every report records the prompt version, judge rubric version, models, dataset version and as-of date. I only compared judge scores at the same rubric version; the runner records it but doesn't enforce it.

## Final results

Frozen system: prompt `2026-10-26.13`, judge rubric `2026-10-26.5`, dataset `2026-10-26.13`, `gpt-4.1-mini` for answers and judging, as of 26 October 2026. Where a range is shown, the figure is the mean of 3 runs with the range in brackets (see the note under the table).

| Metric | Full system | Baseline |
|---|---|---|
| **Pass rate** | **96% (94 to 97)** | 91% (90 to 93) |
| Retrieval recall@6 | **98%** | 95% |
| Decline accuracy | **100%** | 98% |
| Key facts | **96% (95 to 98)** | 94% (92 to 95) |
| Correctness (judge, 1 to 5) | **4.87** | 4.74 |
| Grounded (judge) | 100% | 100% |
| Focused (judge) | 99% | 99% |
| Quotes verified word for word | 98% | 97% |
| Citation precision | **95%** | 92% |
| Answered when it should have declined | 0 | 0 |
| Suggested follow-ups answered when asked | 99% | not run |
| Useful follow-up suggestions (judge) | 100% | 100% |
| Latency, median and p95 | 2.8s, 4.1s | 3.2s, 5.3s |
| Cost per answer | $0.0019 (about 0.15p) | $0.0018 |

Pass rate, recall, decline accuracy, key facts, correctness, grounded and focused are means of the 3 runs; quotes, citation precision, follow-ups, latency and cost are from run 1.

The baseline is vector-only retrieval with old policy versions mixed in and no contextual headers. Both use the same prompt, model and judge, so the difference is retrieval design alone.

The ranges don't overlap, so the gap is real. Where it comes from:
- **Retrieval.** The baseline never found the SOLAR necklace page for "how long is it?" (s8, 0% recall, failed every run). Vector search blurs product names and bare measurements; BM25 matches "SOLAR necklace" exactly, helped by the page title in each chunk's header.
- **Conflicting sources.** For the short "can I swim in my jewellery?" (c8), the baseline left out the care guide's advice to take jewellery off before swimming in every run. The FAQ's "waterproof" claim won.
- **Conversation.** "What about the SOLAR ones?" after a shower question (t2) failed every run on the judge's correctness score. I haven't traced this one; the required documents were retrieved, so the likely difference is how passages are ranked and labelled.

Early in development the baseline also gave stale policies (free delivery from £75) in four of five runs. The improved prompt now handles versions well enough that it doesn't, which narrowed the gap. The code-level filter stays as the guarantee.

One case goes the other way: the baseline passes c7 (the LUNAR offer) every time and the full system fails it every time, although the full system retrieves the LUNAR page too. It's a generation issue, not retrieval, and it's listed under known issues.

**Failed in every run:** c7. Asked the price of express delivery for a LUNAR ring, it gives £6.95 but leaves out that express delivery is free on LUNAR orders until 30 November. The LUNAR page with the offer was retrieved; the model didn't use it.

**Failed in one of three runs:** p7, f2, f4, f8 and f11. These are the model's randomness on borderline answers: each passes twice in three.

## Held-out set

`evals/heldout.json`: 10 questions written by the brand owner near the end, in customers' own words, and never used for tuning. One change came after they were written (trimming mostly verbatim quotes), driven by a main-set regression found in a trace, not by these questions. Run once, on the frozen system.

| | Main set | Held-out |
|---|---|---|
| Pass rate | 96% | **80% (8 of 10)** |
| Grounded | 100% | 100% |
| False answers | 0 | 0 |

The gap is the expected cost of tuning on one set: the system does a little better on questions it was developed against. Both held-out failures are the same weakness. "What if I get an ugly pearl?" and "the ring doesn't fit" are returns questions that never say "return", and both answers left out the 30-day window (the ring answer also left out the unworn condition). The prompt rule that fixed direct returns questions doesn't carry over to indirect ones. It passed the ones I expected to be hardest: "is the jewellery nice?" (no unsupported claim about quality), "delivered but not received" (no promised refund), "which is the most popular collection?" (didn't name one) and "will it arrive by Friday?" (mentioned the 1pm dispatch cut-off, no guarantee).

## Counterfactual grounding

`evals/counterfactual.json`. A normal eval can't tell whether an answer came from the documents or from what the model already believes. This test changes facts in a temporary copy of the knowledge base and asks the same question against both copies:
- the return window, 30 to 45 days
- the MARINE set price, £235 to £249
- the warranty, 12 to 24 months
- free UK delivery, from over £100 to over £150
- the reply time, two to three working days

A sixth case deletes the Europe delivery price altogether.

**Result: 6 of 6.** Every answer followed the edit, and in each case that changed a fact, a verified quote carried the new wording. The two cases that matter most:
- **Free delivery:** an archived policy still says £75, and the answer gave the edited £150, not either old figure.
- **The deleted Europe price:** the answer said the price isn't listed. It didn't fall back on the archived 2025 price (£8.95) or invent one.

Six cases is a small sample. And since the model can't know Parure's prices anyway, the main value is in those two.

## Judge calibration

The judge is the same model that writes the answers, which tends to flatter. To measure that, the brand owner labelled the answers from the final run blind, on the same three questions the judge answers, without seeing its verdicts (the "Check the judge" page in staff view). `npm run eval:agreement` reports agreement and Cohen's kappa, which corrects for agreeing by chance when nearly every answer is good.

I labelled all 56 answers from run 1 of the final run. (The 11 declines are checked by rules, not the judge.)

| Question | Agreement | Kappa | Judge passed, I failed | I passed, judge failed |
|---|---|---|---|---|
| Correct (judge 4 or 5 of 5) | 86% | 0.15 | 7 | 1 |
| Supported by the cited passages | 93% | 0.00 | 4 | 0 |
| Focused | 95% | 0.00 | 3 | 0 |
| **Overall pass** | **79%** | **0.09** | **11** | **1** |

The raw agreement looks high, but kappa near zero means it is almost all chance: the judge says yes to nearly everything, so we agree whenever an answer is good. (A kappa of 0.6 or more would mean it really tracks my judgement.) And the disagreements all point one way: in 11 of 12, the judge passed an answer I failed.

By my labels, 44 of the 56 answers pass, against 54 by the judge. With the 11 declines, that's **82% of the 67 cases** against the automated 97% for the same run. The judge's "100% grounded" becomes **93%**: I found four answers with a claim their passages don't make:
- "nickel-free" to a customer with a severe allergy, citing the materials guide, which only says "meets the EU Nickel Directive limits". The SOLAR product pages do say "nickel-free", so this is also a real inconsistency in the brand's own copy, and for a severe allergy the cautious wording should win
- "all sets come in one size", when LUNAR rings come in four (either over-generalised from the SOLAR page or repeating the FAQ's outdated "all pieces come in one size")
- "not for continuous exposure to water", in a sentence with no source
- "we do not have a phone number", inferred from "online-only"

The quote check can't catch these: each quote was real, but the sentence around it said more. The other failures were answers that didn't address the question ("which collection would be best?" got three descriptions), put conflicting sources side by side without reconciling them (the FAQ's "waterproof" before the care guide's "take it off"), or left out something a customer needs (import duties when posting abroad).

One disagreement came from my own reference answer rather than the judge: the New York shipping reference didn't mention import duties either, so the judge was right by its brief. Better references would sharpen the judge too.

What this changes: the automated numbers are still useful for catching regressions, but they overstate quality. I'd quote 82% as the quality figure and 96% as the regression baseline, and the next piece of work is a stricter judge, not a better prompt.

## How the evals changed the system

The evals drove most of the design. Each row is a run, the failure it showed, and what changed in response.

| Stage | Pass rate | What the evals (or using it) showed | What changed |
|---|---|---|---|
| First run, 30 cases | 17% | Inline citation markers missing in 25 of 26 answers, despite a rule | Answers became sentences that declare their sources; code adds the numbers |
| Runs 2 to 5 (32 cases by the end) | 90% to 97% | No knowledge of today's date (the LUNAR offer); partly answerable questions without a way to reach the studio; the FAQ's "waterproof" outranking the care guide's "take it off before swimming"; an eval bug ("40" not matching "40cm") | Today's date in every request; a code-added contact line; document types shown and the FAQ ranked below guides; the check fixed |
| Testing by hand, then 43 and 67 cases | | Answers that gave a rule without its conditions (earrings, returns, pearls); a broad returns question cut off at the token limit and shown as unverified; suggestions repeating the answer; wrong product facts in the content | Rules carry their conditions; a higher limit and a separate "too long" decline; follow-ups moved to a separate call; content corrected; every finding added as an eval case |
| 67 cases, before fixes | 87% | Returns answers still missing conditions (the policy was split into four chunks); a follow-up rewrite that lost the topic; and five failures that were the eval's own fault (a plural not matching, a judge marking down an answer for refusing an injection, three checks stricter than the brand would be) | Short policies kept whole; the rewrite carries the topic; the eval fixes kept in a separate commit, with each one explained |
| 3 repeat runs | 94% (91 to 97) | A regression: "can I return just the earrings from the set?" declined in every run. The Langfuse trace showed a quote blending two near-duplicate documents | Mostly verbatim quotes trimmed to the source's own words |
| **Final, 3 repeat runs** | **96% (94 to 97)** | | **Frozen.** Held-out run once (80%), then labelled |
| Blind human labels | 82% by my grading | The judge is lenient: kappa 0.09, and 11 of 12 disagreements were it passing answers I failed | Reported as the quality figure; a stricter judge is the next piece of work |

Two habits made this work. I read every failing answer before changing anything, because five of the failures at the 67-case stage turned out to be the eval's fault, not the system's. And I stopped tuning by eye once fixes started interacting, and changed things only on what the measurements showed.

## Known issues

These are measured, not fixed, because the system is frozen:

1. **Conditions left out of indirect returns questions** (the held-out failures). *Next:* a check after generation: if an answer offers a return, it must state the window and the unworn condition, or the app adds them.
2. **A collection's active offer omitted** (c7). *Next:* when the question names a collection with an offer that's running, check the answer mentions it.
3. **Answers that stop at one piece.** "What are the pearls like?" gave the earrings' pearl size only, when each piece differs. *Next:* for questions about a collection, retrieve its collection page and all its product pages together.
4. **Borderline answers vary between runs** (the flaky cases). *Next:* the checks in 1 and 2 remove the main sources of it; report every change as a mean over repeat runs, as here.
5. **The judge is lenient** (see Judge calibration). *Next:* judge claim by claim against the passages, with a different and stronger model, and the conversation history; then re-measure agreement against the same labels.
6. **Sentences that go beyond or misapply their source:** "all sets are one size", "not for continuous exposure to water", and "nickel-free" cited to a passage that doesn't say it (the product pages do, which is a content inconsistency to resolve). Every quote is verified, but the sentence around it isn't. *Next:* an entailment check per sentence (does the cited passage support this sentence?) by a small second model, dropping or rewording sentences that fail.
7. **Answers that don't address the actual question** ("which collection would be best?" got three descriptions). *Next:* add "does it answer the question asked?" to the judge's rubric, and a follow-up question back to the customer when a choice depends on their taste.
8. **A false positive in my own safety net.** The rule that adds the email line to "we don't list" answers also matched "duties are not included in our prices". *Next:* match only phrasings about missing information.
9. **Graders without the conversation.** The labelling page didn't show earlier turns, so I labelled the six follow-up cases with the history to hand. Results now store the history and the page shows it, for future runs. The judge still isn't given it. The reference answers carry the context, so the effect is small. *Next:* pass the history to the judge.

## Running the evals

```bash
npm run eval                          # full system, saves reports for the dashboard
npm run eval:baseline                 # the simpler retrieval, for comparison
npm run eval -- --repeat 3            # mean, min and max across runs, and flaky cases
npm run eval -- --only c7-lunar-express
npm run eval -- --no-follow-ups       # skip asking each suggestion (faster)
npm run eval -- --gate                # exit 1 if a threshold in evals/thresholds.json fails
npm run eval:heldout                  # the held-out set, reported separately
npm run eval:counterfactual           # the edited knowledge base test
npm run eval:agreement                # judge vs human labels in evals/labels.json
```

Reports are written to `evals/reports/` (`latest.md`, `heldout.md`, `counterfactual.md`, `agreement.md`) and shown on the dashboard at `/#/evals` in staff view. With Langfuse keys set, every case is a trace tagged with its variant and question type, with its scores attached. CI runs the gated eval on pull requests that touch the code, the knowledge base or the evals.
