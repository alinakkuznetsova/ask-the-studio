# Held-out eval report

Run 2026-10-27T11:28:27.982Z, dataset 2026-10-26.1, prompt 2026-10-26.13, chat model gpt-4.1-mini, judge gpt-4.1-mini (rubric 2026-10-26.5).

| Metric | Full system |
|---|---|
| Pass rate | 80% |
| Retrieval recall@k | 100% |
| Decline accuracy | 100% |
| Must-include / must-not facts | 80% |
| Correctness (judge, 1 to 5) | 4.38 |
| Groundedness (judge) | 100% |
| Focused, no padding (judge) | 88% |
| Quotes verified verbatim | 100% |
| Sentences with a verified source | 100% |
| Citation precision | 100% |
| Suggested follow-ups answered | 100% |
| Follow-ups on topic and new (judge) | 100% |
| Latency p50 | 2964ms |
| Latency p95 | 3700ms |
| Cost per answer | $0.00195 |
| False declines | 0 |
| False answers | 0 |


## By category

| Category | Cases | Full |
|---|---|---|
| realistic | 7 | 71% |
| unanswerable | 2 | 100% |
| multi_doc | 1 | 100% |

## Failures (full system)

- **h5-pearls-unique-ugly**: missing: 30 days; judge: The answer correctly states pearls are natural and vary in shape and lustre but omits the important return policy details about returns within 30 days and exceptions for earrings.
- **h10-ring-doesnt-fit**: missing: 30 days; missing: unworn; judge: The answer correctly states ring sizes and sizing advice but omits the return policy and does not directly address whether the ring can be returned if it doesn't fit.

