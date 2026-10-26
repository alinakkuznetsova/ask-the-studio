import type OpenAI from "openai";

export interface Usage {
  input: number;
  output: number;
}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

// thin interface over the chat model so the pipeline can be tested offline
// and the provider can be swapped without touching the pipeline
export interface ChatModel {
  readonly model: string;
  complete(messages: ChatMessage[], maxTokens: number, signal?: AbortSignal): Promise<{ text: string; usage: Usage }>;
  streamJson(
    messages: ChatMessage[],
    schema: { name: string; schema: object },
    maxTokens: number,
    onDelta: (delta: string) => void,
    signal?: AbortSignal,
    // truncated: the model hit maxTokens, so the json is cut off
  ): Promise<{ text: string; usage: Usage; truncated?: boolean }>;
}

// reasoning-style models reject a temperature parameter
function samplingParams(model: string) {
  return /^(o\d|gpt-5|gpt-6)/.test(model) ? {} : { temperature: 0 };
}

export class OpenAIChat implements ChatModel {
  constructor(
    private client: OpenAI,
    readonly model: string,
  ) {}

  async complete(messages: ChatMessage[], maxTokens: number, signal?: AbortSignal) {
    const res = await this.client.chat.completions.create(
      { model: this.model, messages, max_completion_tokens: maxTokens, ...samplingParams(this.model) },
      { signal },
    );
    return {
      text: res.choices[0]?.message.content ?? "",
      usage: { input: res.usage?.prompt_tokens ?? 0, output: res.usage?.completion_tokens ?? 0 },
    };
  }

  async streamJson(
    messages: ChatMessage[],
    schema: { name: string; schema: object },
    maxTokens: number,
    onDelta: (delta: string) => void,
    signal?: AbortSignal,
  ) {
    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        messages,
        max_completion_tokens: maxTokens,
        ...samplingParams(this.model),
        response_format: {
          type: "json_schema",
          json_schema: { name: schema.name, strict: true, schema: schema.schema as Record<string, unknown> },
        },
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal },
    );
    let text = "";
    let usage: Usage = { input: 0, output: 0 };
    let truncated = false;
    for await (const chunk of stream) {
      if (chunk.choices[0]?.finish_reason === "length") truncated = true;
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        text += delta;
        onDelta(delta);
      }
      if (chunk.usage) usage = { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens };
    }
    return { text, usage, truncated };
  }
}
