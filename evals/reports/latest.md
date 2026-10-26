# Eval report

Run 2026-10-26T17:25:31.737Z, dataset 2026-10-26.2, prompt 2026-10-26.6, chat model gpt-4.1-mini, judge gpt-4.1-mini (rubric 2026-10-26.2).

| Metric | Baseline | Full system |
|---|---|---|
| Pass rate | 87% | 93% |
| Retrieval recall@k | 98% | 100% |
| Decline accuracy | 87% | 93% |
| Must-include / must-not facts | 97% | 100% |
| Correctness (judge, 1 to 5) | 4.73 | 4.88 |
| Groundedness (judge) | 100% | 100% |
| Focused, no padding (judge) | 96% | 100% |
| Quotes verified verbatim | 93% | 99% |
| Sentences with a verified source | 100% | 100% |
| Citation precision | 96% | 97% |
| Latency p50 | 2029ms | 1855ms |
| Latency p95 | 3191ms | 3269ms |
| Cost per answer | $0.00107 | $0.00106 |
| False declines | 1 | 0 |
| False answers | 0 | 0 |

Baseline: vector-only retrieval, no version filtering, no contextual headers. Full: hybrid (vector + BM25, RRF), archived docs filtered, contextual headers.

## By category

| Category | Cases | Baseline | Full |
|---|---|---|---|
| straightforward | 7 | 100% | 100% |
| multi_doc | 7 | 100% | 100% |
| conflict | 7 | 86% | 100% |
| unanswerable | 5 | 40% | 60% |
| off_script | 4 | 100% | 100% |

## Failures (full system)

- **u2-engraving**: answered when it should decline
- **u5-student-discount**: answered when it should decline

