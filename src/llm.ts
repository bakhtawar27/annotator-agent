import OpenAI from "openai";

/**
 * One small client for any OpenAI-compatible API: OpenAI itself, Cornell's
 * AI Gateway (LiteLLM), OpenRouter, Azure OpenAI or a local server.
 *
 * .env (see .env.example):
 *   OPENAI_API_KEY    your key            (AI_GATEWAY_KEY also works)
 *   OPENAI_BASE_URL   leave empty for OpenAI (AI_GATEWAY_BASE_URL also works)
 *   AGENT_MODEL       model for every step
 *   CODEBOOK_MODEL / PROMPT_MODEL / ANNOTATION_MODEL / SUGGESTION_MODEL
 *                     optional per-step overrides
 */

export type Step = "codebook" | "prompt" | "annotation" | "suggestion";

const STEP_VARIABLES: Record<Step, string> = {
  codebook: "CODEBOOK_MODEL",
  prompt: "PROMPT_MODEL",
  annotation: "ANNOTATION_MODEL",
  suggestion: "SUGGESTION_MODEL",
};

export class ConfigError extends Error {}

export interface Usage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export const usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0 };

let client: OpenAI | null = null;

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function getApiKey(): string | undefined {
  return env("OPENAI_API_KEY") ?? env("AI_GATEWAY_KEY") ?? env("OPEN_AI_KEY");
}

export function getBaseUrl(): string | undefined {
  return env("OPENAI_BASE_URL") ?? env("AI_GATEWAY_BASE_URL");
}

export function getModel(step: Step): string {
  const model = env(STEP_VARIABLES[step]) ?? env("AGENT_MODEL");
  if (!model) {
    throw new ConfigError(
      `No model set. Add AGENT_MODEL to .env (or ${STEP_VARIABLES[step]} for this step only). See .env.example.`,
    );
  }
  return model;
}

function getClient(): OpenAI {
  if (client) return client;
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new ConfigError(
      "No API key found. Copy .env.example to .env and set OPENAI_API_KEY.",
    );
  }
  client = new OpenAI({
    apiKey,
    baseURL: getBaseUrl(),
    maxRetries: 0,
    timeout: 600_000,
  });
  return client;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryable(error: unknown): boolean {
  if (error instanceof SyntaxError) return true; // model returned broken JSON
  if (error instanceof OpenAI.APIConnectionError) return true;
  if (error instanceof OpenAI.APIError) {
    return error.status === 429 || (error.status ?? 0) >= 500;
  }
  return false;
}

function isSchemaRejection(error: unknown): boolean {
  return (
    error instanceof OpenAI.APIError &&
    error.status === 400 &&
    /response_format|json_schema|schema/i.test(error.message)
  );
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    // Some models wrap JSON in ```json fences.
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
    if (fenced) return JSON.parse(fenced[1]);
    throw error;
  }
}

/**
 * Sends a system + user message and returns the model's JSON answer.
 * Asks for a JSON schema; falls back to plain JSON mode if the provider does
 * not support schemas. Retries rate limits, server errors and broken JSON.
 */
export async function chatJson<T>({
  model,
  system,
  user,
  schema,
  retries = 3,
}: {
  model: string;
  system: string;
  user: string;
  schema: object;
  retries?: number;
}): Promise<T> {
  let useSchema = true;

  for (let attempt = 0; ; attempt++) {
    try {
      const stream = await getClient().chat.completions.create({
        model,
        messages: [
          {
            role: "system",
            content: useSchema
              ? system
              : `${system}\n\nReply with one JSON object only, in this JSON schema: ${JSON.stringify(schema)}`,
          },
          { role: "user", content: user },
        ],
        response_format: useSchema
          ? {
              type: "json_schema",
              json_schema: {
                name: "structured_output",
                schema: schema as Record<string, unknown>,
              },
            }
          : { type: "json_object" },
        stream: true,
        stream_options: { include_usage: true },
      });

      let text = "";
      for await (const chunk of stream) {
        text += chunk.choices?.[0]?.delta?.content ?? "";
        if (chunk.usage) {
          usage.inputTokens += chunk.usage.prompt_tokens ?? 0;
          usage.outputTokens += chunk.usage.completion_tokens ?? 0;
        }
      }
      usage.calls++;
      return parseJson(text) as T;
    } catch (error) {
      if (useSchema && isSchemaRejection(error)) {
        useSchema = false;
        continue;
      }
      if (attempt >= retries || !isRetryable(error)) throw error;
      await sleep(2000 * 2 ** attempt);
    }
  }
}
