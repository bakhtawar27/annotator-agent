import { describe, expect, it } from "vitest";
import {
  buildSessionsFromCsvRows,
  detectColumns,
  mergeAnnotationsIntoRows,
  normalizeRole,
  toCsv,
} from "../src/annotate/transcripts";

const rows = [
  {
    session_id: "a",
    sequence_id: "2",
    speaker: "T",
    content: "What do you think?",
  },
  {
    session_id: "a",
    sequence_id: "1",
    speaker: "S",
    content: "can you help me?",
  },
  { session_id: "b", sequence_id: "1", speaker: "S", content: "hi" },
  { session_id: "c", sequence_id: "1", speaker: "S", content: "skipped" },
];

describe("localAnnotationHelpers", () => {
  it("detects STEPS-style columns", () => {
    expect(
      detectColumns(["session_id", "sequence_id", "speaker", "content"]),
    ).toEqual({
      session: "session_id",
      sessionParts: ["session_id"],
      role: "speaker",
      content: "content",
      order: "sequence_id",
    });
  });

  it("expands S/T speaker codes", () => {
    expect(normalizeRole("S")).toBe("Student");
    expect(normalizeRole("t")).toBe("Tutor");
    expect(normalizeRole("Teacher")).toBe("Teacher");
    expect(normalizeRole("prompt")).toBe("Student");
    expect(normalizeRole("response")).toBe("Tutor");
  });

  it("groups, orders and limits sessions", () => {
    const sessions = buildSessionsFromCsvRows(rows, { maxSessions: 2 });
    expect(sessions.map((s) => s.sessionId)).toEqual(["a", "b"]);
    expect(sessions[0].transcript).toEqual([
      { _id: "0", role: "Student", content: "can you help me?" },
      { _id: "1", role: "Tutor", content: "What do you think?" },
    ]);
    expect(sessions[0].leadRole).toBe("Tutor");
  });

  it("explains missing columns", () => {
    expect(() =>
      buildSessionsFromCsvRows([{ id: "1", words: "x" }], { maxSessions: 1 }),
    ).toThrow(/session, speaker and text columns/);
  });

  it("merges annotations into rows and writes CSV", () => {
    const [session] = buildSessionsFromCsvRows(rows, { maxSessions: 1 });
    const merged = mergeAnnotationsIntoRows(
      session,
      [
        {
          _id: "0",
          STUDENT_INPUT_TYPE: "General help-seeking",
          reasoning: "asks, for help",
        },
        { _id: "1", STUDENT_INPUT_TYPE: "NA", reasoning: "tutor turn" },
      ],
      ["STUDENT_INPUT_TYPE"],
    );
    expect(merged[0].ai_STUDENT_INPUT_TYPE).toBe("General help-seeking");
    expect(merged[1].ai_STUDENT_INPUT_TYPE).toBe("NA");

    const csv = toCsv(merged);
    expect(csv.split("\n")[0]).toBe(
      "session_id,sequence_id,speaker,content,ai_STUDENT_INPUT_TYPE,ai_reasoning",
    );
    expect(csv).toContain('"asks, for help"');
  });
});
