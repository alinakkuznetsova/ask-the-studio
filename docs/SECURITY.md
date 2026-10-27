# Security and threat model

Ask the Studio is a public, unauthenticated question box in front of a paid language model. That shapes the threats: anyone can send it anything, it spends money on every question, and what it says is read as the brand speaking.

## What is worth protecting

| Asset | Why it matters |
|---|---|
| The OpenAI API key and the spend behind it | A leaked key or an unthrottled endpoint turns into a bill |
| The brand's word | A confident wrong policy ("returns are 90 days", an invented discount code) is a customer promise the studio has to honour or retract |
| Customers' personal data | People paste emails, phone and card numbers into chat |
| The system prompt and internals | Not secret in themselves, but leaking them helps an attacker tune an injection |

The service holds no customer accounts, orders or payment data, and the model has no tools: it can only read the retrieved passages and write text. That removes the most serious class of LLM attack (an injection that makes the model *do* something) by design.

## Trust boundaries

```
browser (untrusted) ──JSON──▶ API (validates, limits) ──▶ retrieval (own content, trusted)
                                       │
                                       └──▶ OpenAI (question + passages) ──▶ output checks ──▶ browser
```

Everything from the browser is untrusted, including the conversation history it sends back. The knowledge base is trusted content, but it is still passed to the model as data, never as instructions. The model's output is untrusted until verified.

## Threats and mitigations

| Threat | Mitigation | Where |
|---|---|---|
| **Prompt injection in the question** ("ignore your rules", "SYSTEM OVERRIDE") | Rules in priority order in the system prompt; the question is wrapped as data with angle brackets neutralised so it cannot close a tag; output is a strict JSON schema; off-topic requests are declined | `src/answer/prompt.ts` |
| **Injection through forged history** (a fake earlier assistant turn saying returns are 90 days) | History is passed as quoted, untrusted conversation, never as real assistant messages; answers must cite current sources | `buildUserMessage`, eval `r1` |
| **Hidden instructions** (zero-width or bidi characters, full-width look-alikes) | Input is NFKC-normalised and invisible formatting characters are stripped | `cleanInput`, eval `r6` |
| **Invented facts or sources** | Every quote must appear verbatim in a passage that was actually retrieved. A quote that is mostly verbatim (a run of at least 10 words and 60% of the quote) is trimmed to that run, and the source's own words are shown, never the model's. Anything else is dropped; no verified quote means a decline | `src/answer/validate.ts` |
| **Stale or superseded policy presented as current** | Superseded documents are filtered out of results in code; archived passages are labelled and only used to explain changes | `src/retrieval/retriever.ts` |
| **System prompt leakage** | A canary token and an 8-word overlap check against the prompt; a leaking answer is replaced with a decline | `leaksPrompt`, eval `o2`, `r2` |
| **Echoing personal data** (a pasted card number repeated back) | Card, phone and non-brand email patterns are masked in answers, and the stream holds back digit runs so not even part of a number is shown | `src/answer/safety.ts`, eval `r5` |
| **Script injection into the page** | The UI never renders HTML from the model; React escapes all text and only citation markers, bold and simple lists are parsed; strict Content Security Policy with no inline scripts | `web/src/Answer.tsx`, `src/server/app.ts`, eval `r3` |
| **Cross-site requests** | Same-origin UI and API, no CORS headers, JSON-only endpoints (a cross-site form cannot send JSON without a preflight) | `src/server/app.ts` |
| **Cost abuse and denial of service** | Per-IP sliding-window rate limit; global daily cap; cap on concurrent model calls; 500-character questions, bounded history, 16 KB bodies and capped answer length; relevance gate declines unrelated questions without a model call | `src/server/limits.ts`, `src/config.ts` |
| **Rate-limit evasion by spoofing X-Forwarded-For** | Behind one trusted proxy, only the last entry (appended by the proxy) is used | `clientIp`, server tests |
| **API key exposure** | Server-side only, from environment variables; `.env` is ignored by git; a separate OpenAI project key restricted to chat completions and embeddings, with a hard monthly spend limit and an expiry | `.env.example`, `.gitignore` |
| **Personal data in logs and feedback** | Questions are redacted (emails, phones, cards, order numbers, postcodes) before logging or storing; query embeddings are never written to disk; feedback is only accepted for answers given in the last hour | `src/server/redact.ts`, `src/server/app.ts` |
| **Information leakage in errors** | Generic error messages with a trace ID; details stay in server logs | `app.onError` |
| **Vulnerable dependencies** | Exact-pinned versions; `npm audit` in CI; Dependabot weekly updates; npm's install-script allowlist (only esbuild and fsevents may run scripts) | `.github/`, `package.json` |
| **Vulnerable code** | CodeQL security-extended analysis on every push and pull request | `.github/workflows/codeql.yml` |
| **Container compromise** | Multi-stage build, production dependencies only, non-root user | `Dockerfile` |

## How it is tested

- **Red-team eval group** (`evals/dataset.json`, ids `r1` to `r7`): forged history, instruction translation, script output, another customer's data, card number echo, hidden characters, fake system message. The eval gate fails on any answer to a question that should have been declined.
- **Off-topic group** (`o1` to `o4`): coding request, prompt extraction, competitor comparison, role-play injection.
- **Unit and integration tests** (`tests/`): security headers, content type, body and question limits, rate limiting and proxy spoofing, feedback trace checks, quote verification, prompt-leak detection, input cleaning, answer masking in the final text and in every streamed chunk.

## Repository settings

Enable in GitHub under **Settings → Code security**: secret scanning and push protection (blocks a push that contains a key), Dependabot alerts, and code scanning (uses the CodeQL workflow).

## Known gaps

- **Rate limits are per instance and in memory.** With several instances they need a shared store (Redis), and a determined attacker with many IPs is limited only by the daily cap.
- **No bot protection.** A public launch would add a challenge (for example Cloudflare Turnstile) in front of the API.
- **Pattern-based masking is not complete PII detection.** It covers the common cases; names and addresses in free text are not detected.
- **The model is still the first line against injection.** Code-level checks bound the damage (no tools, verified quotes, masked output, schema), but a subtle injection could still make an answer unhelpful.
- **Staff view is a display toggle, not access control.** The API returns answer metadata (retrieved passage ids, scores, token counts, cost) to every client and the eval dashboard is reachable by its address. None of it is secret, but in production staff view would sit behind a login and the public API would omit the metadata.
- **Retrieved content is trusted.** If the knowledge base were editable by customers (reviews, for example), it would become an injection channel and need the same treatment as user input.
