import { chatJson, getModel } from "../llm";

// System message adapted from Sandpiper's createPromptFromCodebook
// (National Tutoring Observatory, MIT License).
export const PROMPT_GENERATION_SYSTEM_PROMPT = `You are an expert at writing LLM annotation prompts for analysing tutoring transcripts.
- You will be given a codebook summary containing categories, codes, definitions, and examples.
- Your task is to write a clear, detailed prompt that an LLM can use to annotate transcripts according to the codebook.
- The prompt should instruct the LLM to classify each annotation field using the codes defined in the codebook.
- Include the code definitions and examples from the codebook so the LLM understands each code.
- Do not include any JSON schema or output format instructions — those are handled separately.`;

/** Writes the annotation prompt for a codebook summary (see summary.ts). */
export default async function generatePromptFromCodebook(
  summary: string,
): Promise<string> {
  const response = await chatJson<{ prompt?: string }>({
    model: getModel("prompt"),
    system: PROMPT_GENERATION_SYSTEM_PROMPT,
    user: `Codebook summary:\n${summary}`,
    schema: {
      type: "object",
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
    },
  });
  if (!response.prompt?.trim()) {
    throw new Error("The model returned an empty prompt. Try again.");
  }
  return response.prompt;
}
