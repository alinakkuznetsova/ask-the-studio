# Design decisions

The README gives the short version. This is the reasoning behind each choice, including the alternatives I rejected.

## Knowledge base

31 markdown documents: 5 policies, 5 guides, an FAQ, an about page, a contact page, 3 collection pages and 15 product pages. The brand, its parure concept, the FAQ and the care advice are real. The MARINE and LUNAR collections, prices and some policy details were generated to give the set realistic breadth, then reviewed as the brand owner (see [Content is part of the system](#content-is-part-of-the-system)).

It deliberately contains the problems a real support knowledge base has:

| Problem | Example |
|---|---|
| Versioned policies | Returns 2025 (14 days, store credit) vs 2026 (30 days, refunds); delivery 2025 (free over £75, UK and Europe only) vs 2026 (free over £100, worldwide) |
| Current sources that disagree | The FAQ says pieces are "highly waterproof"; the care guide says to take them off before swimming |
| Outdated general statements | The FAQ says "all pieces come in one size"; LUNAR rings come in four sizes |
| Near-duplicates | The FAQ's returns answer vs the full returns policy; collection pages vs product pages; "sets are discounted" worded differently in the policy and on each collection page |
| Exceptions that span sections | Earrings can't be returned, unless faulty or part of a complete set, which must then come back whole, unworn, within 30 days |
| Time-bound offers | Free UK express delivery on LUNAR orders until 30 November 2026, vs £6.95 normally |
| Gaps | No necklace weight, no engraving, no phone number, no way to look up an order |

Frontmatter carries `id`, `type`, `effective_from` and `supersedes` / `superseded_by`, validated with zod at ingest, so a typo fails loudly instead of silently corrupting retrieval.

## Chunking

- **Short documents stay whole** (up to 220 words, so every product page). Price, materials and size answer different questions about the same piece and belong together.
- **Policies stay whole up to 400 words.** Their sections qualify each other: the returns window, then the exceptions, then the rule for sets. Split into sections, an answer could cite the earrings exception without the 30-day window it belongs to, and the evals showed exactly that. Keeping the 300-word returns policy whole fixed it at the cost of a few hundred input tokens when it is retrieved.
- **Longer documents split on `##` headings.** In this corpus that's only the about page and the FAQ; every other document is kept whole. Sections under 35 words are merged into a neighbour so no chunk is a context-free fragment.
- **Every chunk is embedded and keyword-indexed with a contextual header:** its document title, plus the section for split documents (`Frequently Asked Questions > Do you offer different sizes?`). Every chunk then carries its document's name. The SOLAR Necklace page's text never says "SOLAR" (the title heading is stripped), so without the header a question about the SOLAR necklace couldn't keyword-match it at all.

The result is 37 chunks from 31 documents: 29 kept whole, plus 3 from the about page and 5 from the FAQ.

## Retrieval

**Hybrid search:** cosine similarity on `text-embedding-3-small` plus BM25, fused with reciprocal rank fusion (k = 60) into the top 6.

- Embeddings handle paraphrase ("send it back" vs "returns", "bathe" vs "shower").
- BM25 handles what embeddings blur in this domain: prices (`£225`), sizes (`UK O`), and collection and product names. Without it, vector search never surfaced the SOLAR necklace page for the length question.
- RRF combines the two rankings by position, so cosine scores and BM25 scores, which live on different scales, never need calibrating against each other.

**The vector store is an array in memory.** A brute-force scan of 37 chunks takes well under a millisecond. A database would add operational cost and nothing else at this size. Production storage is covered in the README.

**A relevance gate:** if nothing in the knowledge base is even loosely similar (best cosine below 0.2), the question is declined before the answer model is called (only a follow-up's rewrite call may already have run). That handles "write me a Python script" for free, and cheaply blocks one class of cost abuse. The gate cannot tell an attack from a real question we have no content for, so its wording covers both.

**Embedding cache:** vectors are cached by `sha256(model + chunk text)`, so editing one document re-embeds only the chunks that changed. Query embeddings are never written to disk, because questions can contain personal data.

## Conflicting and outdated sources

Superseded documents stay in the index but are **filtered out of the main results in code**, so an old policy can never be presented as current. When a current result replaced an older document, the best-matching archived passage is attached separately, labelled `<archived>`, and the prompt allows it only to explain a change ("free delivery used to start at £75").

The alternative, showing the model both versions and letting it pick by date, is what the eval baseline does. Early on, the baseline gave stale answers (the £75 threshold, refusing US shipping) in four of five runs. As the prompt improved, the baseline learned to handle versions itself and the gap narrowed. I still keep the filter: a prompt is a request, a filter is a guarantee, and for a support assistant a confident wrong policy is worse than a decline.

For disagreements between current sources, each passage is shown with its document type and the prompt ranks specificity: policy, guide or product page over the FAQ, and the most cautious advice when they differ.

## Prompting and grounding

The model returns **strict JSON** (structured outputs): `answerable`, `decline_type`, `partial`, `sentences[{sources, text}]` and `citations[{source, quote}]`.

- **Citation numbers are added by code, not written by the model.** Each sentence declares the sources it relies on, and the server appends the numbers after verification. The first version asked for inline `[S1]` markers; the first eval run showed the model omitted them in 25 of 26 answers, despite an explicit rule. Changing the structure fixed what an instruction couldn't.
- **Every quote is verified in code** against the passage it cites, after normalising case, curly quotes, markdown and whitespace. A quote that isn't there is dropped, and an answer with no verified quote from a current source becomes a decline. This turns "grounded" from an instruction into a guarantee about what reaches the customer.
- **Mostly verbatim quotes are trimmed, not dropped.** A Langfuse trace showed a correct answer declined because the model began its quote with a collection page's wording ("Because sets are discounted") and finished it with the returns policy's. If the longest word-for-word run is at least 10 words and 60% of the quote, that run is kept, and the *source's* words are what the customer sees. Short or loose matches are still dropped.
- **Declines are written by the app,** so they're consistent, and every decline for a real Parure question gives hello@parurelondon.com (off-topic declines just redirect to Parure topics). There are five kinds: not in the sources, off-topic, low relevance (no answer-model call), unverified, and too long (the answer hit the token limit, recorded separately so it can't hide as a citation problem).
- **Partly answerable questions** answer what's covered and say plainly what isn't ("we don't list the weight"). The app then adds a fixed line pointing to the studio. Because the model doesn't always flag `partial`, the app also adds the line to any answer that says "we don't list", "doesn't include" or "no mention of". An answer should never be a dead end.
- **Conditions travel with rules.** The prompt requires conditions and exceptions next to the rule they qualify (soap and a toothbrush, but never on pearls). The care guide was also reordered so the pearl warning follows the soap instruction directly: models follow what's close together.
- **Today's date is sent with every question,** so the LUNAR offer is applied only while it runs. Evals use a fixed as-of date, so expectations stay stable after it ends.
- **Prompt injection:** the question and history are wrapped as data with angle brackets neutralised so they can't close a tag, passages are marked as data (they're trusted content, so not escaped), the rules state their own priority, the model has no tools, and a canary token plus an 8-word overlap check replace any answer that leaks the prompt. See [SECURITY.md](SECURITY.md).

## Follow-ups and conversations

The client sends the last few turns; the server stays stateless.

- **A short model call rewrites a follow-up into a standalone question** for retrieval. It carries over the topic as well as the object: after "Can I shower in my MARINE pieces?", "What about the SOLAR ones?" becomes "Can I shower in my SOLAR pieces?". An earlier version produced "Tell me about SOLAR" and the answer lost the point.
- **The rewrite can also over-carry the topic.** Found in final testing: after several turns about earrings, "can I wear the rings in the shower" was rewritten towards earrings, and the search missed the care guide. So a follow-up is searched twice: the rewrite's top 6 are kept whole, and the two best passages for the customer's own words are added if they aren't already there. My first version merged the two searches equally; that fixed the new case but pushed the care guide out of "What about the SOLAR ones?" (t2), which failed 3 of 3 runs. Adding only on top means a real follow-up can't lose anything it found before. All 7 conversation cases, including the new t5, pass 3 of 3. The extra search costs one embedding and only runs when there is history.
- **History reaches the answer model as quoted, untrusted conversation**, never as real assistant messages, so a forged earlier turn ("returns are 90 days") can't carry instructions. That's red-team case r1.

**Suggested next questions come from a separate, small call after the answer.** Asked in the same call, the model kept suggesting questions its own answer had just covered, even when told not to: it writes them without checking them against what it wrote. The second call sees the finished answer, the customer's earlier questions and the retrieved passages, and must stay on the customer's topic. The answer is streamed to the browser as soon as it's verified, and the suggestions follow as a separate event, so the extra call adds no wait before the answer. If that call fails, the answer is unaffected. Every suggestion is filtered in code (no markup, no personal data, must be a short question) and the evals ask each one for real: 99% get an answer.

## Interface

**Customer view and staff view.** Customers see the answer as plain text, with one small pill per source document; tapping a pill shows the passage. On a live site each pill would link to the page itself, since every document already carries its URL. The demo content is partly invented, so the demo shows the passage instead. Staff view adds the numbered markers, each source with its verification badge, effective date and quote, and a "How this answer was made" panel: timings, cost, the rewritten question and the retrieved passages with their scores.

Staff view is a display toggle, not access control. The API returns the metadata to every client. None of it is secret, but in production staff view would sit behind a login and the public API would omit it.

**Other choices:**
- The page opens as a conversation, with a greeting from the studio and a few topics. On the home screen, the question box types out example questions while it's empty.
- Answers stream, revealed at a steady reading pace.
- A sent question scrolls to the top with the answer writing in below, and the page doesn't scroll while the answer streams.
- The design follows Parure's own site: colours from its Webflow variables and Libre Baskerville, self-hosted so the Content Security Policy can stay strict.

## Observability

With Langfuse keys set, every question is one trace with up to five steps (the rewrite only runs for follow-ups, and verification only when an answer was written):
1. `rewrite follow-up`
2. `retrieve`, with each passage's fused, vector and BM25 scores (and the customer's original words, for a follow-up)
3. `generate answer`, with tokens and cost
4. `verify citations`, with the verified quotes and the number dropped and trimmed
5. `suggest follow-ups`

Personal data is masked before traces are sent to Langfuse (the question itself still goes to OpenAI to be answered). Eval runs tag each trace with the variant and question type and attach the eval scores. Thumbs up and down are attached as a `user-feedback` score. The trace is how the quote-trimming problem above was found.

## Content is part of the system

Testing as the brand owner turned up claims in the generated content that weren't true to Parure:
- bangles that "can be gently adjusted" (they're rigid)
- a final-sale exclusion the brand doesn't have
- "from the LUNAR collection onwards" in the size guide

The assistant had repeated each one faithfully, and correctly, from its sources. No eval of the model could catch this, because the model wasn't wrong. The fix was the content. The production lesson: content needs an owner who reviews changes, and the evals should run when a document changes, not only when the code does.

## Models

`gpt-4.1-mini` for answers, follow-up rewriting, suggestions and the judge; `text-embedding-3-small` for embeddings. Mini models are fast and cheap (about 0.15p per answer), and the hard guarantees (versions, verified quotes, declines) are in code rather than resting on model quality. Models are set by environment variable. Using the same model as the judge is a known weakness, measured by the human labelling in [EVALS.md](EVALS.md).
