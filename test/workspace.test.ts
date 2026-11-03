import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("findInputFiles", () => {
  it("finds a CSV codebook by name and keeps it out of the dataset", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-"));
    const input = path.join(workspace, "input");
    fs.mkdirSync(input);
    for (const name of [
      "STEPS_codebook.csv",
      "dataset.csv",
      "Annotated_Dataset_Hackathon - GT1 1.csv",
      "column-map.json",
    ]) {
      fs.writeFileSync(path.join(input, name), "x");
    }
    process.env.AGENT_WORKSPACE = workspace;
    const { findInputFiles } = await import("../src/workspace");

    const found = findInputFiles({});
    expect(path.basename(found.codebook!)).toBe("STEPS_codebook.csv");
    expect(path.basename(found.dataset!)).toBe("dataset.csv");
    expect(found.golds.map((file) => path.basename(file))).toEqual([
      "Annotated_Dataset_Hackathon - GT1 1.csv",
    ]);
    expect(found.problems).toEqual([]);
  });
});
