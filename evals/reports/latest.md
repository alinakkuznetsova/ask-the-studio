# Eval report

Run 2026-10-27T11:50:41.247Z, dataset 2026-10-26.13, prompt 2026-10-26.13, chat model gpt-4.1-mini, judge gpt-4.1-mini (rubric 2026-10-26.5).

| Metric | Baseline | Full system |
|---|---|---|
| Pass rate | 90% | 97% |
| Retrieval recall@k | 95% | 98% |
| Decline accuracy | 97% | 100% |
| Must-include / must-not facts | 92% | 98% |
| Correctness (judge, 1 to 5) | 4.73 | 4.88 |
| Groundedness (judge) | 100% | 100% |
| Focused, no padding (judge) | 100% | 100% |
| Quotes verified verbatim | 97% | 98% |
| Sentences with a verified source | 100% | 99% |
| Citation precision | 92% | 95% |
| Suggested follow-ups answered | n/a | 99% |
| Follow-ups on topic and new (judge) | 100% | 100% |
| Latency p50 | 3215ms | 2833ms |
| Latency p95 | 5257ms | 4118ms |
| Cost per answer | $0.00184 | $0.00188 |
| False declines | 1 | 0 |
| False answers | 0 | 0 |

Baseline: vector-only retrieval, no version filtering, no contextual headers. Full: hybrid (vector + BM25, RRF), archived docs filtered, contextual headers.

## Across 3 runs

| Metric | Mean | Min | Max |
|---|---|---|---|
| passRate | 96% | 94% | 97% |
| declineAccuracy | 100% | 100% | 100% |
| factAccuracy | 96% | 95% | 98% |
| correctness | 4.87 | 4.82 | 4.91 |
| groundedness | 100% | 100% | 100% |
| focus | 99% | 98% | 100% |
| retrievalRecall | 98% | 98% | 98% |

Flaky cases: p7-discount-casual (passed 2 of 3), f2-return-earrings (passed 2 of 3), f4-discount-code (passed 2 of 3), f8-return-solar-bangle (passed 1 of 3), f11-three-piece-discount (passed 2 of 3).

## By category

| Category | Cases | Baseline | Full |
|---|---|---|---|
| straightforward | 12 | 83% | 100% |
| multi_doc | 12 | 92% | 100% |
| conflict | 9 | 89% | 89% |
| unanswerable | 7 | 86% | 86% |
| off_script | 4 | 100% | 100% |
| red_team | 7 | 86% | 100% |
| realistic | 12 | 100% | 100% |
| conversation | 4 | 75% | 100% |

## Failures (full system)

- **c7-lunar-express**: missing: free; judge: The answer correctly states the express delivery cost but omits the key detail that express delivery is currently free for LUNAR orders until 30 November 2026.
- **f4-discount-code**: judge: The answer correctly states no discount codes are listed and mentions a launch offer, but it misses the key fact that sets are sold at a discount, which is in the reference.

