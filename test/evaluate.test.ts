import { describe, expect, it } from "vitest";
import {
  evaluateAgainstGold,
  mapGoldColumnsToFields,
  matchAiRowsToGold,
  normalizeFieldName,
  normalizeLabel,
  renderEvaluationMarkdown,
  standardizeGoldFiles,
} from "../src/evaluate/evaluate";

describe("normalizers", () => {
  it("cleans field names and labels", () => {
    expect(normalizeFieldName("student_input_type (Human)")).toBe(
      "student input type",
    );
    expect(normalizeLabel(" General  Help-Seeking ")).toBe(
      "general help seeking",
    );
    expect(normalizeLabel("N/A")).toBe("na");
    expect(normalizeLabel("")).toBe("na");
    expect(normalizeLabel("Praise | Hint")).toBe("hint + praise");
    expect(normalizeLabel("Hint, Praise")).toBe("hint + praise");
    expect(normalizeLabel("NA | Hint")).toBe("hint");
  });
});

describe("mapGoldColumnsToFields", () => {
  it("matches exact names first, then contained names", () => {
    const result = mapGoldColumnsToFields(
      [
        "_id",
        "session_id",
        "content",
        "student_input_type (Human)",
        "correctness",
        "tutor correctness identification (Human)",
        "answer leak (Human)",
        "notes",
      ],
      [
        "STUDENT_INPUT_TYPE",
        "CORRECTNESS",
        "TUTOR_CORRECTNESS_IDENTIFICATION",
        "TUTOR_ANSWER_LEAK",
        "ENCOURAGEMENT_FLAG",
      ],
    );
    expect(result.mapping).toEqual({
      STUDENT_INPUT_TYPE: "student_input_type (Human)",
      CORRECTNESS: "correctness",
      TUTOR_CORRECTNESS_IDENTIFICATION:
        "tutor correctness identification (Human)",
      TUTOR_ANSWER_LEAK: "answer leak (Human)",
    });
    expect(result.unmatchedFields).toEqual(["ENCOURAGEMENT_FLAG"]);
    expect(result.unusedGoldColumns).toEqual(["notes"]);
  });

  it("never uses earlier AI labels as gold, but keeps them as a baseline", () => {
    const result = mapGoldColumnsToFields(
      [
        "student_input_type (AI)",
        "student_input_type (Human)",
        "Answer leak (AI)",
        "Answer leak(Human)",
        "tutor_output_type(Claude Opus 4.6)",
      ],
      ["STUDENT_INPUT_TYPE", "ANSWER_LEAK", "TUTOR_OUTPUT_TYPE"],
    );
    expect(result.mapping).toEqual({
      STUDENT_INPUT_TYPE: "student_input_type (Human)",
      ANSWER_LEAK: "Answer leak(Human)",
    });
    expect(result.baselineMapping).toEqual({
      STUDENT_INPUT_TYPE: "student_input_type (AI)",
      ANSWER_LEAK: "Answer leak (AI)",
      TUTOR_OUTPUT_TYPE: "tutor_output_type(Claude Opus 4.6)",
    });
    expect(result.unmatchedFields).toEqual(["TUTOR_OUTPUT_TYPE"]);
  });

  it("respects overrides", () => {
    const result = mapGoldColumnsToFields(["flag"], ["ENCOURAGEMENT_FLAG"], {
      flag: "ENCOURAGEMENT_FLAG",
    });
    expect(result.mapping.ENCOURAGEMENT_FLAG).toBe("flag");
  });
});

describe("standardizeGoldFiles", () => {
  it("reads a GT1-style file with no session_id column", () => {
    const { rows, files } = standardizeGoldFiles(
      [
        {
          name: "GT1.csv",
          rows: [
            {
              "#": "1",
              question: "Barium Hydroxide",
              "student (shortened code)": "30",
              "message_type (prompt form student, response from bot)": "prompt",
              text: "can you help me with this problem?",
              student_input_type: "General help-seeking",
              "tutor answer leak": "NA",
            },
            {
              "#": "2",
              question: "Barium Hydroxide",
              "student (shortened code)": "30",
              "message_type (prompt form student, response from bot)":
                "response",
              text: "Of course!",
              student_input_type: "NA",
              "tutor answer leak": "No",
            },
          ],
        },
      ],
      ["STUDENT_INPUT_TYPE", "TUTOR_ANSWER_LEAK"],
    );
    expect(rows[0]).toMatchObject({
      session_id: "30 / Barium Hydroxide",
      sequence_id: "1",
      role: "Student",
      content: "can you help me with this problem?",
      STUDENT_INPUT_TYPE: "General help-seeking",
    });
    expect(rows[1]).toMatchObject({ role: "Tutor", TUTOR_ANSWER_LEAK: "No" });
    expect(files[0].unusedGoldColumns).toEqual([]);
  });
});

describe("matchAiRowsToGold", () => {
  const ai = [
    { session_id: "a", sequence_id: "1", content: "hi", ai_X: "Yes" },
    { session_id: "a", sequence_id: "2", content: "ok", ai_X: "No" },
  ];

  it("matches by session and sequence", () => {
    const result = matchAiRowsToGold(ai, [
      { session_id: "a", sequence_id: "2", content: "ok" },
    ]);
    expect(result.matched).toHaveLength(1);
    expect(result.byOrder).toBe(1);
  });

  it("falls back to text when sequence numbers differ", () => {
    const result = matchAiRowsToGold(ai, [
      { session_id: "a", sequence_id: "10", content: "hi" },
      { session_id: "a", sequence_id: "11", content: "OK" },
    ]);
    expect(result.matched.map((m) => m.ai.ai_X)).toEqual(["Yes", "No"]);
    expect(result.byText).toBe(2);
  });
});

describe("evaluateAgainstGold", () => {
  const ai = [
    {
      session_id: "s",
      sequence_id: "1",
      role: "S",
      content: "a",
      ai_TYPE: "Help",
      ai_reasoning: "r1",
    },
    {
      session_id: "s",
      sequence_id: "2",
      role: "T",
      content: "b",
      ai_TYPE: "NA",
      ai_reasoning: "r2",
    },
    {
      session_id: "s",
      sequence_id: "3",
      role: "S",
      content: "c",
      ai_TYPE: "Answer",
      ai_reasoning: "r3",
    },
    {
      session_id: "s",
      sequence_id: "4",
      role: "S",
      content: "d",
      ai_TYPE: "Help",
      ai_reasoning: "r4",
    },
  ];

  it("computes kappa, non-NA kappa, baseline and disagreements", () => {
    const report = evaluateAgainstGold({
      aiRows: ai,
      goldFiles: [
        {
          name: "gold.csv",
          rows: [
            {
              session_id: "s",
              sequence_id: "1",
              role: "S",
              content: "a",
              "type (Human)": "help",
              "type (AI)": "Help",
            },
            {
              session_id: "s",
              sequence_id: "2",
              role: "T",
              content: "b",
              "type (Human)": "NA",
              "type (AI)": "Help",
            },
            {
              session_id: "s",
              sequence_id: "3",
              role: "S",
              content: "c",
              "type (Human)": "Answer",
              "type (AI)": "Help",
            },
            {
              session_id: "s",
              sequence_id: "4",
              role: "S",
              content: "d",
              "type (Human)": "Answer",
              "type (AI)": "Help",
            },
          ],
        },
      ],
      fieldKeys: ["TYPE"],
      codesByField: { TYPE: ["Help", "Answer", "NA"] },
    });

    const field = report.fields[0];
    expect(report.matchedRows).toBe(4);
    expect(field.agreement).toBe(0.75);
    expect(field.applicableRows).toBe(3);
    expect(field.kappa).toBeGreaterThan(0.6);
    expect(field.baselineKappa).not.toBeNull();
    expect(field.baselineKappa!).toBeLessThan(field.kappa);
    expect(field.disagreements).toEqual([
      {
        sessionId: "s",
        sequence: "4",
        role: "Student",
        content: "d",
        gold: "Answer",
        ai: "Help",
        reasoning: "r4",
      },
    ]);

    const markdown = renderEvaluationMarkdown(report, "Run v1");
    expect(markdown).toContain("| TYPE | type (Human) |");
    expect(markdown).toContain("Previous AI κ");
    expect(markdown).toContain("Gold **answer** → AI **help**: 1 rows");
  });

  it("pools several gold files and flags labels that are not codes", () => {
    const report = evaluateAgainstGold({
      aiRows: [
        {
          session_id: "s",
          sequence_id: "1",
          role: "S",
          content: "a",
          ai_TYPE: "Help",
        },
        {
          session_id: "t",
          sequence_id: "1",
          role: "S",
          content: "z",
          ai_TYPE: "Help",
        },
      ],
      goldFiles: [
        {
          name: "gold1.csv",
          rows: [
            {
              session_id: "s",
              sequence_id: "1",
              role: "S",
              content: "a",
              type: "Help",
            },
          ],
        },
        {
          name: "gold2.csv",
          rows: [
            {
              session_id: "t",
              sequence_id: "1",
              role: "S",
              content: "z",
              TYPE: "Other",
            },
          ],
        },
      ],
      fieldKeys: ["TYPE"],
      codesByField: { TYPE: ["Help"] },
    });
    expect(report.matchedRows).toBe(2);
    expect(report.fields[0].goldColumns).toEqual([
      "gold1.csv: type",
      "gold2.csv: TYPE",
    ]);
    expect(report.fields[0].goldLabelsNotInCodebook).toEqual(["other"]);
  });
});
