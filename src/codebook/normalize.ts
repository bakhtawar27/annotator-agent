import type { CodebookExample } from "../types";

type ExampleType = CodebookExample["exampleType"];

const EXAMPLE_TYPES: ExampleType[] = ["HIT", "NEAR_HIT", "NEAR_MISS", "MISS"];

export interface ExtractedCodebookExample {
  example?: unknown;
  exampleType?: unknown;
}

export interface ExtractedCodebookCode {
  code?: unknown;
  definition?: unknown;
  examples?: unknown;
}

export interface ExtractedCodebookCategory {
  name?: unknown;
  description?: unknown;
  appliesToSpeaker?: unknown;
  condition?: unknown;
  codes?: unknown;
}

export interface ExtractedCodebook {
  name?: unknown;
  intention?: unknown;
  categories?: unknown;
}

export interface NormalizedCodebookCategory {
  name: string;
  description: string;
  codes: {
    code: string;
    description: string;
    definition: string;
    examples: { example: string; exampleType: ExampleType }[];
  }[];
}

export interface NormalizedCodebook {
  name: string;
  intention: string;
  categories: NormalizedCodebookCategory[];
}

const MAX_TEXT_LENGTH = 4000;

export const NOT_APPLICABLE_CODE = "NA";

function toCleanString(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_LENGTH);
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toExampleType(value: unknown): ExampleType {
  const normalized = toCleanString(value)
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  return (EXAMPLE_TYPES as string[]).includes(normalized)
    ? (normalized as ExampleType)
    : "HIT";
}

function isScopedToSpeaker(speaker: string): boolean {
  return !!speaker && !/^(all|any|both|everyone)$/i.test(speaker);
}

/**
 * True when a category is only coded for some utterances (one speaker, or a
 * condition on another category). Every annotation must fill every field, so
 * such categories get an NA code for the other utterances.
 */
export function needsNotApplicableCode(
  category: ExtractedCodebookCategory,
): boolean {
  return (
    isScopedToSpeaker(toCleanString(category.appliesToSpeaker)) ||
    !!toCleanString(category.condition)
  );
}

/**
 * Folds speaker scoping and conditional rules into the category description,
 * so the existing codebook → prompt generator passes them to the LLM without
 * a schema change.
 */
export function buildCategoryDescription(
  category: ExtractedCodebookCategory,
): string {
  const parts: string[] = [];
  const description = toCleanString(category.description);
  const speaker = toCleanString(category.appliesToSpeaker);
  const condition = toCleanString(category.condition);

  if (description) parts.push(description);
  if (isScopedToSpeaker(speaker)) {
    parts.push(
      `Applies to: ${speaker} utterances only. Use ${NOT_APPLICABLE_CODE} for other speakers.`,
    );
  }
  if (condition) {
    parts.push(
      `Only code this when: ${condition}. Otherwise use ${NOT_APPLICABLE_CODE}.`,
    );
  }

  return parts.join("\n");
}

/**
 * Cleans the raw JSON an LLM returns when reading a codebook document:
 * trims text, drops empty categories/codes/examples, removes duplicate codes
 * (case-insensitive), maps unknown example types to HIT and adds an NA code
 * to speaker-scoped or conditional categories.
 */
export default function normalizeExtractedCodebook(
  raw: ExtractedCodebook,
  fallbackName = "Imported codebook",
): NormalizedCodebook {
  const usedCategoryNames = new Set<string>();
  const categories: NormalizedCodebookCategory[] = [];

  for (const rawCategory of toArray(raw?.categories)) {
    const category = (rawCategory ?? {}) as ExtractedCodebookCategory;
    const name = toCleanString(category.name);
    if (!name || usedCategoryNames.has(name.toLowerCase())) continue;

    const usedCodes = new Set<string>();
    const codes: NormalizedCodebookCategory["codes"] = [];

    for (const rawCode of toArray(category.codes)) {
      const code = (rawCode ?? {}) as ExtractedCodebookCode;
      const label = toCleanString(code.code);
      if (!label || usedCodes.has(label.toLowerCase())) continue;
      usedCodes.add(label.toLowerCase());

      const examples = toArray(code.examples)
        .map((rawExample) => {
          const example = (rawExample ?? {}) as ExtractedCodebookExample;
          return {
            example: toCleanString(example.example),
            exampleType: toExampleType(example.exampleType),
          };
        })
        .filter((example) => example.example.length > 0);

      codes.push({
        code: label,
        description: "",
        definition: toCleanString(code.definition),
        examples,
      });
    }

    if (codes.length === 0) continue;
    usedCategoryNames.add(name.toLowerCase());

    const hasNotApplicable = [...usedCodes].some((code) =>
      /^(n\s*\/?\s*a|not applicable|none)$/i.test(code),
    );
    if (needsNotApplicableCode(category) && !hasNotApplicable) {
      codes.push({
        code: NOT_APPLICABLE_CODE,
        description: "",
        definition:
          "Not applicable: this utterance is outside the speaker or condition this category applies to.",
        examples: [],
      });
    }

    categories.push({
      name,
      description: buildCategoryDescription(category),
      codes,
    });
  }

  return {
    name: toCleanString(raw?.name) || fallbackName,
    intention: toCleanString(raw?.intention),
    categories,
  };
}
