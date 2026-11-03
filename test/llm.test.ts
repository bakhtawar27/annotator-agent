import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// A tiny OpenAI-compatible server: the first request with a JSON schema is
// rejected (like providers without schema support), then JSON is streamed.
let requests: Array<Record<string, unknown>> = [];
let rejectSchema = true;
let replies: string[] = [];

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const request = JSON.parse(body);
    requests.push(request);
    const format = (request.response_format as { type: string }).type;
    if (rejectSchema && format === "json_schema") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "response_format json_schema is not supported" },
        }),
      );
      return;
    }
    const text = replies.shift() ?? '{"ok":true}';
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (text === "STREAM_ERROR") {
      // LiteLLM reports provider outages as an error event in the stream.
      res.end(
        `data: ${JSON.stringify({ error: { message: 'litellm.ServiceUnavailableError: BedrockException - serviceUnavailableException {"message":"Bedrock is unable to process your request."}' } })}\n\n`,
      );
      return;
    }
    res.write(
      `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text } }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.NO_PROXY = "127.0.0.1,localhost";
  process.env.no_proxy = "127.0.0.1,localhost";
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  requests = [];
  replies = [];
  rejectSchema = true;
});

describe("config", () => {
  it("reads the key and models from the environment", async () => {
    const { getApiKey, getModel } = await import("../src/llm");
    expect(getApiKey()).toBe("test-key");

    process.env.AGENT_MODEL = "general-model";
    process.env.ANNOTATION_MODEL = "cheap-model";
    expect(getModel("codebook")).toBe("general-model");
    expect(getModel("annotation")).toBe("cheap-model");
    delete process.env.ANNOTATION_MODEL;
    delete process.env.AGENT_MODEL;
    expect(() => getModel("prompt")).toThrow(/AGENT_MODEL/);
  });
});

describe("chatJson", () => {
  it("falls back to JSON mode, parses fenced JSON and counts tokens", async () => {
    const { chatJson, usage } = await import("../src/llm");
    replies = ['```json\n{"answer": 42}\n```'];

    const result = await chatJson<{ answer: number }>({
      model: "m",
      system: "Be helpful.",
      user: "Question",
      schema: { type: "object", properties: { answer: { type: "number" } } },
    });

    expect(result).toEqual({ answer: 42 });
    expect(requests).toHaveLength(2);
    expect(
      (requests[1].response_format as { type: string }).type,
    ).toBe("json_object");
    const system = (requests[1].messages as Array<{ content: string }>)[0]
      .content;
    expect(system).toContain("JSON schema");
    expect(usage.inputTokens).toBeGreaterThanOrEqual(7);
  });

  it("retries when the model returns broken JSON", async () => {
    const { chatJson } = await import("../src/llm");
    rejectSchema = false;
    replies = ["not json", '{"fixed": true}'];

    const result = await chatJson<{ fixed: boolean }>({
      model: "m",
      system: "s",
      user: "u",
      schema: { type: "object" },
      retries: 1,
    });

    expect(result).toEqual({ fixed: true });
    expect(requests).toHaveLength(2);
  }, 20_000);

  it("retries when the provider is unavailable mid-stream", async () => {
    const { chatJson } = await import("../src/llm");
    rejectSchema = false;
    replies = ["STREAM_ERROR", '{"recovered": true}'];

    const result = await chatJson<{ recovered: boolean }>({
      model: "m",
      system: "s",
      user: "u",
      schema: { type: "object" },
      retries: 1,
    });

    expect(result).toEqual({ recovered: true });
    expect(requests).toHaveLength(2);
  }, 20_000);
});
