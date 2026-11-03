import { describe, expect, it } from "vitest";
import normalizeExtractedCodebook, {
  buildCategoryDescription,
} from "../src/codebook/normalize";

describe("normalizeExtractedCodebook", () => {
  it("keeps categories, codes, definitions and typed examples", () => {
    const result = normalizeExtractedCodebook({
      name: "  STEPS codebook ",
      intention: "Codes student and tutor moves",
      categories: [
        {
          name: "Student input type",
          description: "What the student wrote",
          appliesToSpeaker: "Student",
          condition: "",
          codes: [
            {
              code: "General help-seeking",
              definition: "Student asks for broad help",
              examples: [
                { example: "can you help me?", exampleType: "HIT" },
                { example: "what is a mole?", exampleType: "near miss" },
              ],
            },
          ],
        },
      ],
    });

    expect(result.name).toBe("STEPS codebook");
    expect(result.intention).toBe("Codes student and tutor moves");
    expect(result.categories).toHaveLength(1);
    expect(result.categories[0].codes.map((c) => c.code)).toEqual([
      "General help-seeking",
      "NA",
    ]);
    expect(result.categories[0].codes[0]).toEqual({
      code: "General help-seeking",
      description: "",
      definition: "Student asks for broad help",
      examples: [
        { example: "can you help me?", exampleType: "HIT" },
        { example: "what is a mole?", exampleType: "NEAR_MISS" },
      ],
    });
  });

  it("drops empty and duplicate codes and empty categories", () => {
    const result = normalizeExtractedCodebook({
      categories: [
        {
          name: "Repetition",
          codes: [
            { code: "Yes", definition: "", examples: [] },
            { code: "yes", definition: "duplicate", examples: [] },
            { code: "   ", definition: "empty", examples: [] },
          ],
        },
        { name: "Empty", codes: [] },
        { name: "", codes: [{ code: "orphan" }] },
        { name: "repetition", codes: [{ code: "No" }] },
      ],
    });

    expect(result.categories).toHaveLength(1);
    expect(result.categories[0].codes.map((c) => c.code)).toEqual(["Yes"]);
  });

  it("uses the fallback name and survives malformed input", () => {
    const result = normalizeExtractedCodebook(
      { categories: "nope" } as never,
      "my-file",
    );
    expect(result).toEqual({ name: "my-file", intention: "", categories: [] });
  });

  it("maps unknown example types to HIT and drops empty examples", () => {
    const result = normalizeExtractedCodebook({
      categories: [
        {
          name: "Leak",
          codes: [
            {
              code: "Answer leak",
              examples: [
                { example: "The answer is 4", exampleType: "SOMETHING" },
                { example: "", exampleType: "HIT" },
              ],
            },
          ],
        },
      ],
    });
    expect(result.categories[0].codes[0].examples).toEqual([
      { example: "The answer is 4", exampleType: "HIT" },
    ]);
  });
});

describe("buildCategoryDescription", () => {
  it("adds speaker scope and conditional rules", () => {
    const description = buildCategoryDescription({
      description: "Is the student's answer correct?",
      appliesToSpeaker: "Student",
      condition:
        "student input type is Direct answer or Answer with uncertainty",
    });

    expect(description).toContain("Is the student's answer correct?");
    expect(description).toContain(
      "Applies to: Student utterances only. Use NA for other speakers.",
    );
    expect(description).toContain(
      "Only code this when: student input type is Direct answer or Answer with uncertainty. Otherwise use NA.",
    );
  });

  it("skips the speaker rule when it applies to everyone", () => {
    expect(
      buildCategoryDescription({ description: "x", appliesToSpeaker: "All" }),
    ).toBe("x");
  });
});

describe("NA code", () => {
  it("is added once for conditional categories and not for general ones", () => {
    const result = normalizeExtractedCodebook({
      categories: [
        {
          name: "Correctness",
          condition: "the student gives an answer",
          codes: [{ code: "Correct" }, { code: "na" }],
        },
        {
          name: "Tutor move",
          appliesToSpeaker: "All",
          codes: [{ code: "Hint" }],
        },
      ],
    });

    expect(result.categories[0].codes.map((c) => c.code)).toEqual([
      "Correct",
      "na",
    ]);
    expect(result.categories[1].codes.map((c) => c.code)).toEqual(["Hint"]);
  });
});
