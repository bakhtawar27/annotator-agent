import { describe, expect, it } from "vitest";
import { annotateSession } from "../src/annotate/annotateSession";
import type { LocalSession } from "../src/annotate/transcripts";

function session(n: number): LocalSession {
  const transcript = Array.from({ length: n }, (_, i) => ({
    _id: String(i),
    role: i % 2 ? "Tutor" : "Student",
    content: `utterance ${i}`,
  }));
  return { sessionId: "s1", rows: transcript.map(() => ({})), transcript, leadRole: "Tutor" };
}

function requestedIds(user: string): string[] {
  const match = /these utterances, with at least one annotation for each _id: ([^.]*)\./.exec(user);
  return match ? match[1].split(", ") : [];
}

describe("annotateSession", () => {
  it("asks in slices and covers every utterance", async () => {
    const asked: string[][] = [];
    const result = await annotateSession({
      session: session(45),
      promptText: "Code it.",
      utterancesPerRequest: 20,
      ask: async (user) => {
        const ids = requestedIds(user);
        asked.push(ids);
        return { annotations: ids.map((_id) => ({ _id, CODE: "x" })) };
      },
    });
    expect(asked.map((ids) => ids.length)).toEqual([20, 20, 5]);
    expect(result.missingIds).toEqual([]);
    expect(new Set(result.annotations.map((a) => a._id)).size).toBe(45);
  });

  it("asks again for utterances the model skipped, like a small model that only codes the last turns", async () => {
    let call = 0;
    const result = await annotateSession({
      session: session(10),
      promptText: "Code it.",
      ask: async (user) => {
        call++;
        const ids = requestedIds(user);
        const answered = call === 1 ? ids.slice(-2) : ids;
        return { annotations: answered.map((_id) => ({ _id, CODE: "x" })) };
      },
    });
    expect(call).toBe(2);
    expect(result.missingIds).toEqual([]);
    expect(result.annotations).toHaveLength(10);
  });

  it("reports what is still missing and ignores unknown ids", async () => {
    const result = await annotateSession({
      session: session(4),
      promptText: "Code it.",
      ask: async () => ({ annotations: [{ _id: "0" }, { _id: "99" }] }),
    });
    expect(result.missingIds).toEqual(["1", "2", "3"]);
    expect(result.annotations.map((a) => a._id)).toEqual(["0"]);
  });
});
