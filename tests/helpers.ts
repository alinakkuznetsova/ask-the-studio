import type { ChatMessage, ChatModel, Usage } from "../src/answer/llm.js";
import { chunkDocs } from "../src/kb/chunker.js";
import { loadDocs } from "../src/kb/loader.js";
import { settings } from "../src/config.js";
import { HashEmbedder } from "../src/retrieval/embeddings.js";
import { Retriever } from "../src/retrieval/retriever.js";
import { DEFAULT_RETRIEVAL } from "../src/kb/build.js";

// scripted chat model: returns canned json and streams it in small pieces
export class FakeChat implements ChatModel {
  readonly model = "gpt-4.1-mini";
  calls: ChatMessage[][] = [];
  // returned by the separate follow-up call, which is not recorded in calls
  followUps: string[] = [];
  constructor(
    private output: (messages: ChatMessage[]) => object | string,
    private rewrite = "rewritten question",
    private truncated = false,
  ) {}
  async complete(messages: ChatMessage[]) {
    this.calls.push(messages);
    return { text: this.rewrite, usage: { input: 50, output: 10 } as Usage };
  }
  async streamJson(messages: ChatMessage[], schema: { name: string }, _m: number, onDelta: (d: string) => void) {
    if (schema.name === "follow_ups") return { text: JSON.stringify({ follow_ups: this.followUps }), usage: { input: 200, output: 20 } as Usage };
    this.calls.push(messages);
    const out = this.output(messages);
    const text = typeof out === "string" ? out : JSON.stringify(out);
    for (let i = 0; i < text.length; i += 7) onDelta(text.slice(i, i + 7));
    return { text, usage: { input: 1000, output: 100 } as Usage, truncated: this.truncated };
  }
}

export async function testRetriever() {
  const chunks = chunkDocs(await loadDocs(settings.kbDir), settings);
  return Retriever.build(chunks, new HashEmbedder(), DEFAULT_RETRIEVAL);
}

// find which S label the source containing `phrase` got in the prompt
export function labelFor(messages: ChatMessage[], phrase: string): string {
  const user = messages.find((m) => m.role === "user")!.content;
  const blocks = [...user.matchAll(/<current id="(S\d+)"[^>]*>\n([\s\S]*?)\n<\/current>/g)];
  const hit = blocks.find((b) => b[2]!.includes(phrase));
  if (!hit) throw new Error(`no source containing: ${phrase}`);
  return hit[1]!;
}

// builds the model's json: one sentence per [label, text] pair, with quotes
export function cited(
  sentences: [label: string | null, text: string][],
  quotes: [label: string, quote: string][],
  partial = false,
) {
  return {
    answerable: true,
    decline_type: "none",
    partial,
    sentences: sentences.map(([l, text]) => ({ sources: l ? [l] : [], text })),
    citations: quotes.map(([source, quote]) => ({ source, quote })),
  };
}

export const declined = (type: "off_topic" | "not_in_sources") => ({ answerable: false, decline_type: type, partial: false, sentences: [], citations: [] });
