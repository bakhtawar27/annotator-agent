import type { FieldEvaluation } from "../evaluate/evaluate";
import { chatJson, getModel } from "../llm";

export interface PromptSuggestion {
  field: string;
  problem: string;
  evidence: string;
  change: string;
}

export interface PromptImprovementResult {
  summary: string;
  suggestions: PromptSuggestion[];
  possibleLabelIssues: string[];
  revisedPrompt: string;
}

const MAX_EXAMPLES_PER_FIELD = 15;

export const PROMPT_IMPROVEMENT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    suggestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field: { type: "string" },
          problem: { type: "string" },
          evidence: { type: "string" },
          change: { type: "string" },
        },
        required: ["field", "problem", "evidence", "change"],
      },
    },
    possibleLabelIssues: { type: "array", items: { type: "string" } },
    revisedPrompt: { type: "string" },
  },
  required: ["summary", "suggestions", "possibleLabelIssues", "revisedPrompt"],
};

export const PROMPT_IMPROVEMENT_SYSTEM_PROMPT = `You help researchers improve an LLM annotation prompt for tutoring transcripts.
- You get: the codebook, the current prompt, Cohen's kappa per field against human gold labels, the most common confusions, and examples where the AI and the human disagree (with the AI's reasoning).
- Find the patterns behind the disagreements, starting with the fields that have the lowest kappa. Explain each problem in plain words and quote the evidence (the confusion counts or short utterance snippets).
- Propose concrete, general changes to the prompt: clearer decision rules, tie-breakers between codes that get confused, when to use NA, short examples taken from the codebook. Do not write rules that only fit one specific utterance.
- The codebook is the authority. Never add, rename or remove codes; the code labels must stay exactly as they are.
- If the human label looks inconsistent with the codebook definition, or the codebook itself is ambiguous, list it under possibleLabelIssues instead of bending the prompt to it.
- revisedPrompt: the full improved prompt. Keep the structure, wording and formatting of the current prompt except where you are fixing a problem. Do not add JSON or output-format instructions; those are handled separately.
- summary: two or three sentences on the main problems and what the revision changes.`;

function formatFieldEvaluation(field: FieldEvaluation): string {
  const lines = [
    `### ${field.fieldKey} (kappa ${field.kappa}, ${field.interpretation}; kappa on non-NA gold rows ${field.applicableKappa}; agreement ${Math.round(field.agreement * 100)}%; ${field.rows} rows)`,
  ];
  for (const confusion of field.topConfusions) {
    lines.push(
      `- human "${confusion.gold}" but AI "${confusion.ai}": ${confusion.count} times`,
    );
  }
  if (field.goldLabelsNotInCodebook.length) {
    lines.push(
      `- human labels that are not codebook codes: ${field.goldLabelsNotInCodebook.join(", ")}`,
    );
  }
  for (const example of field.disagreements.slice(0, MAX_EXAMPLES_PER_FIELD)) {
    lines.push(
      `- [${example.role}] "${example.content.slice(0, 300)}" → human: ${example.gold || "(empty)"}, AI: ${example.ai || "(empty)"}. AI reasoning: ${example.reasoning.slice(0, 300)}`,
    );
  }
  return lines.join("\n");
}

/**
 * Reads an evaluation against gold labels and asks an LLM for prompt
 * improvements plus a revised prompt for a human to review.
 */
export default async function suggestPromptImprovements({
  promptText,
  codebookSummary,
  fields,
}: {
  promptText: string;
  codebookSummary: string;
  fields: FieldEvaluation[];
}): Promise<PromptImprovementResult> {
  const sortedFields = [...fields].sort((a, b) => a.kappa - b.kappa);

  const result = await chatJson<Partial<PromptImprovementResult>>({
    model: getModel("suggestion"),
    system: PROMPT_IMPROVEMENT_SYSTEM_PROMPT,
    user: `Codebook:\n${codebookSummary}\n\nCurrent prompt:\n${promptText}\n\nEvaluation against human gold labels (lowest kappa first):\n${sortedFields.map(formatFieldEvaluation).join("\n\n")}`,
    schema: PROMPT_IMPROVEMENT_SCHEMA,
  });

  return {
    summary: result.summary ?? "",
    suggestions: Array.isArray(result.suggestions) ? result.suggestions : [],
    possibleLabelIssues: Array.isArray(result.possibleLabelIssues)
      ? result.possibleLabelIssues
      : [],
    revisedPrompt: result.revisedPrompt ?? "",
  };
}

export function renderSuggestionsMarkdown(
  result: PromptImprovementResult,
  {
    fromVersion,
    draftFile,
    nextVersion,
  }: { fromVersion: string; draftFile: string; nextVersion: string },
): string {
  const lines = [
    `# Suggestions for prompt ${fromVersion}`,
    "",
    result.summary,
    "",
    "## Suggested changes",
    "",
  ];
  result.suggestions.forEach((suggestion, index) => {
    lines.push(
      `${index + 1}. **${suggestion.field}: ${suggestion.problem}**`,
      `    - Evidence: ${suggestion.evidence}`,
      `    - Change: ${suggestion.change}`,
    );
  });
  if (result.possibleLabelIssues.length) {
    lines.push(
      "",
      "## Possible gold-label or codebook issues (check with the coders)",
      "",
    );
    for (const issue of result.possibleLabelIssues) lines.push(`- ${issue}`);
  }
  lines.push(
    "",
    "## Next step",
    "",
    `A draft prompt with these changes is in \`${draftFile}\`. Edit it, then run \`./agent accept ${nextVersion}\` to make it prompt ${nextVersion}.`,
  );
  return lines.join("\n") + "\n";
}
