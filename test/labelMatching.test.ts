import { describe, expect, it } from "vitest";
import { normalizeLabel } from "../src/evaluate/evaluate";
import { LabelMatcher, matchLabelToCode } from "../src/evaluate/labelMatching";

// Code names from the STEPS codebook and labels from the STEPS gold files.
const tutorCodes = [
  "ask questions specified in prompt",
  "ask follow-up questions",
  "check student understanding",
  "directly answer student question/request",
  "confirm and/or elaborate on student correct answers",
  "attempt to address student incorrect answers",
  "provide part of the correct answer appropriately (when the student is struggling)",
  "provide general praise/encouragement",
  "instruct students to return to survey",
  "remind students the purpose of the exercise",
].map(normalizeLabel);

const practiceCodes = [
  "Relevant concepts",
  "Similar problems",
  "Information needed",
  "Strategy",
  "Execution",
  "Answer checking",
].map(normalizeLabel);

const correctnessCodes = [
  "Completely correct",
  "Correct but out of sequence",
  "Partially incorrect",
  "Completely incorrect",
  "Unintelligible",
  "Not specific enough",
].map(normalizeLabel);

const match = (label: string, codes: string[]) =>
  matchLabelToCode(normalizeLabel(label), codes);

describe("matchLabelToCode", () => {
  it("reads spelling variants as the codebook code", () => {
    expect(match("Ask follow-up question", tutorCodes)).toBe(
      normalizeLabel("ask follow-up questions"),
    );
    expect(match("Ask question specified in prompt", tutorCodes)).toBe(
      normalizeLabel("ask questions specified in prompt"),
    );
    expect(match("Check for understanding", tutorCodes)).toBe(
      normalizeLabel("check student understanding"),
    );
    expect(
      match("Confirm and elaborate on student correct answers", tutorCodes),
    ).toBe(normalizeLabel("confirm and/or elaborate on student correct answers"));
    expect(
      match(
        "Provide part of correct answer appropraitely (when student is struggling)",
        tutorCodes,
      ),
    ).toBe(tutorCodes[6]);
    expect(match("Provide part of correct answer", tutorCodes)).toBe(
      tutorCodes[6],
    );
    expect(match("Instruct student to return to survey", tutorCodes)).toBe(
      tutorCodes[8],
    );
    expect(match("Simliar problems", practiceCodes)).toBe("similar problems");
    expect(match("Relevant concetps", practiceCodes)).toBe("relevant concepts");
    expect(match("Inofrmation needed", practiceCodes)).toBe(
      "information needed",
    );
    expect(match("Execution/Solution", practiceCodes)).toBe("execution");
    expect(
      match("Doesn't identify", [
        normalizeLabel("Correctly identifies"),
        normalizeLabel("Incorrectly identifies"),
        normalizeLabel("Doesn't indentify"),
      ]),
    ).toBe(normalizeLabel("Doesn't indentify"));
    expect(
      match("Specifc question", [
        normalizeLabel("Specific question"),
        normalizeLabel("General help-seeking"),
      ]),
    ).toBe("specific question");
  });

  it("leaves labels alone when there is no clear match", () => {
    expect(match("Uninterpretable", correctnessCodes)).toBeNull();
    expect(match("Partially correct", correctnessCodes)).toBeNull();
    expect(match("Relevant conceptsSimilar problem", practiceCodes)).toBeNull();
    expect(
      match("Correctly identifies", [
        normalizeLabel("Incorrectly identifies"),
        normalizeLabel("Doesn't identify"),
      ]),
    ).toBeNull();
    expect(
      match("Encouragement", [normalizeLabel("Discouragement")]),
    ).toBeNull();
  });
});

describe("LabelMatcher", () => {
  it("counts the mappings it made", () => {
    const matcher = new LabelMatcher(practiceCodes);
    matcher.map("simliar problems");
    matcher.map("simliar problems");
    matcher.map("strategy");
    expect(matcher.mappings()).toEqual([
      { from: "simliar problems", to: "similar problems", count: 2 },
    ]);
  });
});
